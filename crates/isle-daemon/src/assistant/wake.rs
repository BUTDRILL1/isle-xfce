// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Lightweight pure-Rust whistle wake-word detector.

use std::f64::consts::PI;
use tokio::sync::watch;
use crate::assistant::mic::Mic;

pub struct WhistleDetector {
    whistle_freqs: [f64; 39],
    low_freqs: [f64; 13],
    streak: usize,
    cooldown: usize,
}

impl WhistleDetector {
    pub fn new() -> Self {
        let mut whistle_freqs = [0.0; 39];
        for (i, freq) in whistle_freqs.iter_mut().enumerate() {
            *freq = 1200.0 + (i as f64) * 50.0;
        }
        let mut low_freqs = [0.0; 13];
        for (i, freq) in low_freqs.iter_mut().enumerate() {
            *freq = 250.0 + (i as f64) * 50.0;
        }
        Self {
            whistle_freqs,
            low_freqs,
            streak: 0,
            cooldown: 0,
        }
    }

    fn goertzel_power(samples: &[i16], freq: f64) -> f64 {
        let n = samples.len();
        if n == 0 {
            return 0.0;
        }
        let coeff = 2.0 * (2.0 * PI * freq / 16000.0).cos();
        let mut s1 = 0.0;
        let mut s2 = 0.0;
        let mut sum_sq = 0.0;

        for &x in samples {
            let xf = x as f64;
            sum_sq += xf * xf;
            let s = xf + coeff * s1 - s2;
            s2 = s1;
            s1 = s;
        }

        let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        if sum_sq <= 1e-6 {
            0.0
        } else {
            2.0 * power / (n as f64 * sum_sq)
        }
    }

    pub fn feed(&mut self, samples: &[i16]) -> bool {
        if self.cooldown > 0 {
            self.cooldown -= 1;
            return false;
        }

        if samples.is_empty() {
            self.streak = 0;
            return false;
        }

        let n = samples.len() as f64;
        let mut sum_sq = 0.0;
        for &s in samples {
            let xf = s as f64;
            sum_sq += xf * xf;
        }
        let rms = (sum_sq / n).sqrt();

        if rms < 450.0 {
            self.streak = 0;
            return false;
        }

        let mut powers = [0.0f64; 39];
        for (idx, &f) in self.whistle_freqs.iter().enumerate() {
            powers[idx] = Self::goertzel_power(samples, f);
        }
        let mut max_whistle = 0.0f64;
        for pair in powers.windows(2) {
            let energy = pair[0] + pair[1];
            if energy > max_whistle {
                max_whistle = energy;
            }
        }

        let mut max_low = 0.0;
        for &f in &self.low_freqs {
            let p = Self::goertzel_power(samples, f);
            if p > max_low {
                max_low = p;
            }
        }

        if max_whistle >= 0.52 && max_low < 0.25 {
            self.streak += 1;
            if self.streak >= 11 {
                self.streak = 0;
                self.cooldown = 150;
                true
            } else {
                false
            }
        } else {
            self.streak = 0;
            false
        }
    }
}

impl Default for WhistleDetector {
    fn default() -> Self {
        Self::new()
    }
}

pub async fn run(
    mut enabled: watch::Receiver<bool>,
    mut paused: watch::Receiver<bool>,
    mut on_wake: impl FnMut() + Send + 'static,
) {
    let mut detector = WhistleDetector::new();

    loop {
        let is_enabled = *enabled.borrow_and_update();
        let is_paused = *paused.borrow_and_update();

        if !is_enabled || is_paused {
            tokio::select! {
                res = enabled.changed() => {
                    if res.is_err() { break; }
                }
                res = paused.changed() => {
                    if res.is_err() { break; }
                }
            }
            continue;
        }

        let mut mic = match Mic::start() {
            Ok(m) => m,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        loop {
            tokio::select! {
                chunk_opt = mic.chunk() => {
                    let Some(chunk) = chunk_opt else { break; };
                    if detector.feed(&chunk) {
                        on_wake();
                    }
                }
                res = enabled.changed() => {
                    if res.is_err() { return; }
                    if !*enabled.borrow_and_update() {
                        break;
                    }
                }
                res = paused.changed() => {
                    if res.is_err() { return; }
                    if *paused.borrow_and_update() {
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_whistle_trigger() {
        let mut detector = WhistleDetector::new();
        // 2000 Hz sine wave, amplitude 8000
        let mut chunk = vec![0i16; 320];
        for (i, sample) in chunk.iter_mut().enumerate() {
            let t = i as f64 / 16000.0;
            *sample = (8000.0 * (2.0 * PI * 2000.0 * t).sin()) as i16;
        }

        // Feed 15 frames (~300ms)
        let mut triggered_count = 0;
        for _ in 0..15 {
            if detector.feed(&chunk) {
                triggered_count += 1;
            }
        }
        assert_eq!(triggered_count, 1);

        // Another 300ms right after -> cooldown active, returns false
        for _ in 0..15 {
            assert!(!detector.feed(&chunk));
        }

        // Between-bin whistle (2025 Hz) also triggers cleanly with fresh detector
        let mut det2 = WhistleDetector::new();
        let mut mid_chunk = vec![0i16; 320];
        for (i, sample) in mid_chunk.iter_mut().enumerate() {
            let t = i as f64 / 16000.0;
            *sample = (8000.0 * (2.0 * PI * 2025.0 * t).sin()) as i16;
        }
        assert!((0..15).any(|_| det2.feed(&mid_chunk)));
    }

    #[test]
    fn test_low_band_speech() {
        let mut detector = WhistleDetector::new();
        // 350 Hz sine wave, amplitude 8000
        let mut chunk = vec![0i16; 320];
        for (i, sample) in chunk.iter_mut().enumerate() {
            let t = i as f64 / 16000.0;
            *sample = (8000.0 * (2.0 * PI * 350.0 * t).sin()) as i16;
        }

        // Feed for 500ms (25 frames)
        for _ in 0..25 {
            assert!(!detector.feed(&chunk));
        }
    }

    #[test]
    fn test_silence_and_noise() {
        let mut detector = WhistleDetector::new();
        let silence = vec![0i16; 320];
        for _ in 0..25 {
            assert!(!detector.feed(&silence));
        }

        // Pseudo-random white noise
        let mut rng_val: u32 = 42;
        let mut noise = vec![0i16; 320];
        for _ in 0..25 {
            for s in noise.iter_mut() {
                rng_val = rng_val.wrapping_mul(1103515245).wrapping_add(12345);
                *s = ((rng_val >> 16) as i16 % 1000) - 500;
            }
            assert!(!detector.feed(&noise));
        }
    }
}
