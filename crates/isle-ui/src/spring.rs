// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Damped harmonic oscillator simulation for Isle animations.
//!
//! Direct, bit-for-bit port of upstream `gnome-extension/src/spring.js`.
//! Unlike fixed-duration easing, a spring can be retargeted mid-flight and
//! preserves its current velocity, preventing visual hitches.

/// The island's size spring: ~3.5% overshoot, peaking at ~0.37 s and at rest by ~0.57 s.
pub const ISLAND_CONFIG: (f64, f64) = (155.0, 18.0); // (stiffness, damping)

/// Same speed without overshoot, for corner and shoulder radii.
pub const GENTLE_CONFIG: (f64, f64) = (155.0, 25.0);

const MAX_STEP: f64 = 1.0 / 240.0;
const MAX_FRAME: f64 = 0.25;

/// At rest within a quarter pixel, slower than 2 px/s: closer is invisible,
/// and creeping on would keep nudging the island's edges by a pixel for a second more.
const REST_DISTANCE: f64 = 0.25;
const REST_SPEED: f64 = 2.0;

/// One animated value pulled toward its target by a damped spring.
#[derive(Debug, Clone, Copy)]
pub struct Spring {
    pub value: f64,
    pub target: f64,
    pub velocity: f64,
    pub stiffness: f64,
    pub damping: f64,
}

impl Spring {
    /// Starts at rest on `value` with the provided configuration.
    pub fn new(initial: f64, (stiffness, damping): (f64, f64)) -> Self {
        Self {
            value: initial,
            target: initial,
            velocity: 0.0,
            stiffness,
            damping,
        }
    }

    /// Retargets mid-flight, keeping the current velocity.
    pub fn set_target(&mut self, target: f64) {
        self.target = target;
    }

    /// Jumps straight to `value` with no motion.
    #[allow(dead_code)]
    pub fn reset(&mut self, value: f64) {
        self.value = value;
        self.target = value;
        self.velocity = 0.0;
    }

    /// Whether it is close and slow enough to count as at rest.
    pub fn is_settled(&self) -> bool {
        (self.value - self.target).abs() < REST_DISTANCE && self.velocity.abs() < REST_SPEED
    }

    /// Advances by `dt` seconds; returns whether the spring is at rest.
    pub fn step(&mut self, dt: f64) -> bool {
        let mut remaining = dt.clamp(0.0, MAX_FRAME);
        while remaining > 0.0 && !self.is_settled() {
            let h = remaining.min(MAX_STEP);
            let accel = -self.stiffness * (self.value - self.target) - self.damping * self.velocity;
            self.velocity += accel * h;
            self.value += self.velocity * h;
            remaining -= h;
        }

        if self.is_settled() {
            self.value = self.target;
            self.velocity = 0.0;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spring_settling() {
        let mut spring = Spring::new(0.0, ISLAND_CONFIG);
        spring.set_target(100.0);
        assert!(!spring.is_settled());

        // Step by 16.6ms frames
        let dt = 1.0 / 60.0;
        let mut steps = 0;
        while !spring.step(dt) && steps < 300 {
            steps += 1;
        }

        assert!(spring.is_settled());
        assert_eq!(spring.value, 100.0);
        assert_eq!(spring.velocity, 0.0);
        // Peaking around ~0.37s (22 frames) and settling around ~0.57s (~35-45 frames)
        assert!(steps > 25 && steps < 60);
    }

    #[test]
    fn test_gentle_no_overshoot() {
        let mut spring = Spring::new(0.0, GENTLE_CONFIG);
        spring.set_target(50.0);

        let dt = 1.0 / 60.0;
        let mut max_val = 0.0f64;
        while !spring.step(dt) {
            max_val = max_val.max(spring.value);
        }

        assert!(spring.is_settled());
        // Critically damped gentle spring should not overshoot past 50.0
        assert!(max_val <= 50.001);
    }
}
