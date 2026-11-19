// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! The microphone, through PulseAudio/PipeWire's `parec`: 16 kHz mono 16-bit LE PCM chunks.

use std::process::Stdio;

use isle_core::voice::CHUNK_MS;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const RATE: u32 = 16_000;
const CHUNK_SAMPLES: usize = (RATE * CHUNK_MS / 1000) as usize;

/// A running `parec`, read chunk by chunk.
pub struct Mic {
    _child: Child,
    chunks: mpsc::Receiver<Vec<i16>>,
    reader: JoinHandle<()>,
}

impl Mic {
    /// Starts recording; the recorder is killed when this is dropped.
    pub fn start() -> std::io::Result<Self> {
        let mut child = Command::new("parec")
            // Tagged as Isle's own, so the island does not take it for a call.
            .args([
                "--raw",
                "--latency-msec=20",
                "--rate=16000",
                "--channels=1",
                "--format=s16le",
                "--property=application.id=io.github.zickrian.isle",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdout = child.stdout.take().expect("piped stdout");
        // Read on a task of its own, so waiting for a chunk can be interrupted without losing audio.
        let (sender, chunks) = mpsc::channel(64);
        let reader = tokio::spawn(async move {
            let mut bytes = vec![0u8; CHUNK_SAMPLES * 2];
            let mut warmup_chunks = 3u8;
            while stdout.read_exact(&mut bytes).await.is_ok() {
                if warmup_chunks > 0 {
                    warmup_chunks -= 1;
                    continue;
                }
                let raw: Vec<i16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|&pair| i16::from_le_bytes(pair))
                    .collect();
                let mean = raw.iter().map(|&s| s as i64).sum::<i64>() / raw.len().max(1) as i64;
                let chunk: Vec<i16> = raw
                    .into_iter()
                    .map(|s| (s as i64 - mean).clamp(i16::MIN as i64, i16::MAX as i64) as i16)
                    .collect();
                if sender.send(chunk).await.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            _child: child,
            chunks,
            reader,
        })
    }

    /// The next chunk; `None` once the recorder stopped.
    pub async fn chunk(&mut self) -> Option<Vec<i16>> {
        self.chunks.recv().await
    }
}

impl Drop for Mic {
    /// Stops the reader; `kill_on_drop` takes care of the recorder.
    fn drop(&mut self) {
        self.reader.abort();
    }
}
