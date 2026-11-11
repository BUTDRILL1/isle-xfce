// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Speech to text: Handy (Parakeet Unified English 0.6B) or `isle-whisper` (whisper.cpp).

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Context;
use isle_core::speech::{MODELS, MODELS_DIR, model_file};
use log::{info, warn};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

use super::child::{self, Group};
use crate::store::{data_dir, write_private};

pub const PARAKEET_MODEL: &str =
    "handy-computer/parakeet-unified-en-0.6b-gguf/parakeet-unified-en-0.6b-Q8_0.gguf";

const NATIVE: &str = "isle-whisper";
/// Set, the user picked the GPUs (by their Vulkan numbers) the helper may use.
const PINNED: &str = "GGML_VK_VISIBLE_DEVICES";
/// How long `isled --doctor` waits for the helper to say where it runs.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Set once the GPU failed (a driver that crashes): the processor from then on, until isled restarts.
static GPU_FAILED: AtomicBool = AtomicBool::new(false);
/// Set once the helper found no GPU to use: later ones skip loading Vulkan, until isled restarts.
static NO_GPU: AtomicBool = AtomicBool::new(false);

/// Where `handy` is installed: `/usr/bin/handy` or on the PATH.
fn handy() -> Option<PathBuf> {
    let fixed = PathBuf::from("/usr/bin/handy");
    if fixed.is_file() {
        return Some(fixed);
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|dir| dir.join("handy"))
        .find(|path| path.is_file())
}

/// `isle-whisper` beside isled (both go in ~/.local/bin), else on the PATH.
fn native() -> Option<PathBuf> {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join(NATIVE)));
    let path = std::env::var_os("PATH").unwrap_or_default();
    beside
        .into_iter()
        .chain(std::env::split_paths(&path).map(|dir| dir.join(NATIVE)))
        .find(|path| path.is_file())
}

/// Where `isle-setup-voice` puts the speech models.
fn models_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_default().join(MODELS_DIR)
}

/// The models `isle-setup-voice` downloaded for `isle-whisper`.
fn downloaded(dir: &Path) -> Vec<&'static str> {
    MODELS
        .into_iter()
        .filter(|model| model_file(model).is_some_and(|file| dir.join(file).is_file()))
        .collect()
}

/// Whether speech recognition is set up: `handy`, or `isle-whisper` and a model for it.
pub fn installed() -> bool {
    handy().is_some() || (native().is_some() && !downloaded(&models_dir()).is_empty())
}

/// What `isled --doctor` says about speech recognition.
pub fn report() -> String {
    if let Some(h) = handy() {
        return format!(
            "  Speech recognition: {} (model: Parakeet Unified English 0.6B), on Vulkan GPU",
            h.display()
        );
    }
    let models = downloaded(&models_dir());
    match native() {
        Some(native) if !models.is_empty() => format!(
            "  Speech recognition: {} (models: {}), on {}",
            native.display(),
            models.join(", "),
            probe(&native)
        ),
        Some(_) => "  Speech recognition: no speech model yet (run isle-setup-voice)".to_owned(),
        None => "  Speech recognition: isle-whisper is missing (install Isle again)".to_owned(),
    }
}

/// Where `isle-whisper` would run, as it finds when asked: the GPU's name, or the processor.
fn probe(native: &Path) -> String {
    let child = std::process::Command::new(native)
        .arg("--probe")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return "nothing: it does not start".to_owned();
    };
    let started = Instant::now();
    // Polled: a GPU driver that hangs must not hang the check.
    while child.try_wait().ok().flatten().is_none() {
        if started.elapsed() > PROBE_TIMEOUT {
            child.kill().ok();
            child.wait().ok();
            return "the processor (the GPU did not answer)".to_owned();
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut output = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        std::io::Read::read_to_string(&mut stdout, &mut output).ok();
    }
    device_name(&output)
}

/// How the doctor names the device in the helper's `--probe` answer.
fn device_name(probe: &str) -> String {
    let probe: Value = serde_json::from_str(probe.trim()).unwrap_or_default();
    let integrated = probe["gpus"]
        .as_array()
        .is_some_and(|gpus| !gpus.is_empty());
    match (probe["device"].as_str(), probe["error"].as_str()) {
        // An integrated GPU is not faster than the processor's own cores.
        (Some("cpu"), _) if integrated => {
            "the processor (integrated graphics are not used)".to_owned()
        }
        (Some("cpu"), _) => "the processor (no graphics card found)".to_owned(),
        (Some(gpu), _) => format!("the GPU ({gpu})"),
        (None, Some(error)) => format!("nothing: {error}"),
        (None, None) => "the processor (the GPU check failed)".to_owned(),
    }
}

/// The threads speech recognition may use: half the cores, at least one.
fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1))
}

/// Builds a valid 44-byte RIFF/WAVE header (16000 Hz, 1 channel, 16 bits per sample, PCM format = 1)
/// followed by little-endian i16 sample bytes.
fn encode_wav_16k_mono(samples: &[i16]) -> Vec<u8> {
    let data_len = samples.len().saturating_mul(2) as u32;
    let riff_chunk_size = 36u32.saturating_add(data_len);
    let mut wav = Vec::with_capacity(44 + (data_len as usize));

    // RIFF chunk descriptor
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    // "fmt " sub-chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size (16 for PCM)
    wav.extend_from_slice(&1u16.to_le_bytes());  // AudioFormat (1 for PCM)
    wav.extend_from_slice(&1u16.to_le_bytes());  // NumChannels (1 mono)
    wav.extend_from_slice(&16000u32.to_le_bytes()); // SampleRate (16000 Hz)
    wav.extend_from_slice(&32000u32.to_le_bytes()); // ByteRate (16000 * 1 * 2 = 32000)
    wav.extend_from_slice(&2u16.to_le_bytes());  // BlockAlign (1 * 2 = 2)
    wav.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample (16 bits)

    // "data" sub-chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());

    for &sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }

    wav
}

/// Finds the last line in stdout starting with '{', parses it as JSON, and extracts the text field.
fn parse_handy_output(stdout: &str) -> anyhow::Result<String> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            let val: Value =
                serde_json::from_str(trimmed).context("could not parse handy JSON output")?;
            return Ok(val["text"].as_str().unwrap_or_default().trim().to_owned());
        }
    }
    anyhow::bail!("no JSON output from handy")
}

/// An error the helper answered with, as opposed to the helper stopping.
#[derive(Debug)]
struct Answered(String);

impl fmt::Display for Answered {
    /// The helper's own words.
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Answered {}

/// The speech recognition engine backend.
#[allow(clippy::large_enum_variant)]
pub enum Backend {
    Handy {
        bin: PathBuf,
        #[allow(dead_code)]
        audio: PathBuf,
    },
    Native {
        _child: Group,
        stdin: ChildStdin,
        lines: Lines<BufReader<ChildStdout>>,
        ready: bool,
        helper: PathBuf,
        model: String,
        language: String,
    },
}

/// A running speech recognition engine, kept for one voice request.
pub struct Whisper {
    backend: Backend,
    audio: PathBuf,
    on_gpu: bool,
}

impl Whisper {
    /// Starts the speech recognition engine; uses handy with Parakeet if available,
    /// otherwise starts `isle-whisper`.
    pub fn start(model: &str, language: &str) -> anyhow::Result<Self> {
        if let Some(bin) = handy() {
            let audio = dirs::runtime_dir()
                .unwrap_or_else(data_dir)
                .join(format!("isle-voice-{}.wav", std::process::id()));
            return Ok(Self {
                backend: Backend::Handy {
                    bin,
                    audio: audio.clone(),
                },
                audio,
                on_gpu: true,
            });
        }
        let helper = native().context("speech recognition is not set up")?;
        let cpu = GPU_FAILED.load(Ordering::Relaxed) || NO_GPU.load(Ordering::Relaxed);
        Self::start_with(helper, model, language, cpu)
    }

    /// Starts `isle-whisper`, on the processor only when `cpu` is set.
    fn start_with(helper: PathBuf, model: &str, language: &str, cpu: bool) -> anyhow::Result<Self> {
        let mut command = Command::new(&helper);
        if cpu {
            command.arg("--cpu");
        }
        command
            .args(["--model", model, "--language", language])
            // Half the cores at most: transcribing never takes the whole computer.
            .env("ISLE_WHISPER_THREADS", threads().to_string())
            // isled's own allocator limit would slow its threads down.
            .env_remove("MALLOC_ARENA_MAX")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = child::spawn(&mut command).context("could not start speech recognition")?;
        let stdin = child.stdin.take().expect("piped stdin");
        let lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        // A private folder: the session's runtime directory, else Isle's own data folder.
        let audio = dirs::runtime_dir()
            .unwrap_or_else(data_dir)
            .join(format!("isle-voice-{}.pcm", std::process::id()));
        Ok(Self {
            backend: Backend::Native {
                _child: child,
                stdin,
                lines,
                ready: false,
                helper,
                model: model.to_owned(),
                language: language.to_owned(),
            },
            audio,
            on_gpu: !cpu,
        })
    }

    /// The words in `audio` (16 kHz mono), tried once more on the processor if the GPU crashed.
    pub async fn transcribe(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        match &mut self.backend {
            Backend::Handy { bin, .. } => {
                let wav_bytes = encode_wav_16k_mono(audio);
                write_private(&self.audio, &wav_bytes)?;
                let audio_str = self.audio.to_string_lossy();
                let output = Command::new(bin)
                    .args([
                        "--transcribe-file",
                        &audio_str,
                        "--model",
                        PARAKEET_MODEL,
                        "--json",
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await;
                tokio::fs::remove_file(&self.audio).await.ok();
                let output = output.context("failed to execute handy")?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                parse_handy_output(&stdout)
            }
            Backend::Native {
                helper,
                model,
                language,
                ..
            } => {
                let helper = helper.clone();
                let model = model.clone();
                let language = language.clone();
                let mut result = self.transcribe_native_attempt(audio).await;
                let stopped = match &result {
                    Err(err) if self.on_gpu && err.downcast_ref::<Answered>().is_none() => {
                        Some(format!("{err:#}"))
                    }
                    _ => None,
                };
                if let Some(err) = stopped {
                    // It stopped on the GPU (a driver crash): the same words again, on the processor.
                    warn!("speech recognition stopped on the GPU ({err}); using the processor from now on");
                    GPU_FAILED.store(true, Ordering::Relaxed);
                    let cpu = Self::start_with(helper, &model, &language, true);
                    result = match cpu {
                        Ok(mut cpu) => {
                            cpu.audio = self.audio.clone();
                            // The old helper (and its recording, removed on drop) goes.
                            *self = cpu;
                            self.transcribe_native_attempt(audio).await
                        }
                        Err(err) => Err(err),
                    };
                }
                // What was said is not left on disk, whatever happened.
                tokio::fs::remove_file(&self.audio).await.ok();
                result
            }
        }
    }

    /// Waits for `isle-whisper` to load its model once, then asks it.
    async fn transcribe_native_attempt(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        let (lines, ready) = match &mut self.backend {
            Backend::Native { lines, ready, .. } => (lines, ready),
            _ => anyhow::bail!("not native backend"),
        };
        if !*ready {
            let ready_msg = Self::read_native_line(lines).await?;
            let device = ready_msg["device"].as_str();
            info!(
                "speech recognition runs on {}",
                device.unwrap_or("an unknown device")
            );
            // No GPU to use, and none picked by hand: the next helpers start on the processor.
            if self.on_gpu && device == Some("cpu") && std::env::var_os(PINNED).is_none() {
                NO_GPU.store(true, Ordering::Relaxed);
            }
            *ready = true;
        }
        self.transcribe_native_ask(audio).await
    }

    /// Hands the recording over as a file and reads back the text from `isle-whisper`.
    async fn transcribe_native_ask(&mut self, audio: &[i16]) -> anyhow::Result<String> {
        let (stdin, lines) = match &mut self.backend {
            Backend::Native { stdin, lines, .. } => (stdin, lines),
            _ => anyhow::bail!("not native backend"),
        };
        let bytes: Vec<u8> = audio.iter().flat_map(|s| s.to_le_bytes()).collect();
        write_private(&self.audio, &bytes)?;
        let request = serde_json::json!({"audio": self.audio});
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await?;
        let reply = Self::read_native_line(lines).await?;
        let text = reply["text"].as_str().unwrap_or_default().to_owned();
        if text.trim().is_empty() {
            // Why "Didn't catch that": no speech found in it, or what Whisper made of it not counted as said.
            // Never the words themselves: only how many, and how unlike speech each part sounded.
            let set_aside: Vec<String> = reply["dropped"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|part| {
                    let words = part["text"]
                        .as_str()
                        .unwrap_or_default()
                        .split_whitespace()
                        .count();
                    format!(
                        "{words} words at {:.2}",
                        part["no_speech"].as_f64().unwrap_or(f64::NAN)
                    )
                })
                .collect();
            info!(
                "speech recognition found no words: {:.1} s of audio, {} ms of it speech, set aside as not speech: [{}]",
                audio.len() as f32 / super::mic::RATE as f32,
                reply["speech_ms"],
                set_aside.join(", ")
            );
        }
        Ok(text)
    }

    /// The helper's next JSON line; an `error` in it becomes an `Answered`.
    async fn read_native_line(lines: &mut Lines<BufReader<ChildStdout>>) -> anyhow::Result<Value> {
        let line = lines
            .next_line()
            .await?
            .context("speech recognition stopped")?;
        let message: Value = serde_json::from_str(&line)?;
        if let Some(error) = message["error"].as_str() {
            return Err(Answered(error.to_owned()).into());
        }
        Ok(message)
    }
}

impl Drop for Whisper {
    // Dropped mid-way (the user closed the island), the recording is still removed.
    fn drop(&mut self) {
        std::fs::remove_file(&self.audio).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(models: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "isle-whisper-test-{}-{}",
            std::process::id(),
            models.join("-")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for model in models {
            std::fs::write(dir.join(model_file(model).unwrap()), b"").unwrap();
        }
        dir
    }

    #[test]
    fn lists_the_downloaded_models() {
        let dir = folder(&["small", "base"]);
        assert_eq!(downloaded(&dir), vec!["base", "small"]);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A stand-in for `isle-whisper` that crashes on the GPU, as a broken driver makes it.
    fn crashing_helper() -> (PathBuf, PathBuf) {
        let dir = folder(&["tiny"]);
        let script = dir.join("isle-whisper");
        std::fs::write(
            &script,
            "#!/bin/sh\n\
             case \" $* \" in *\" --cpu \"*) ;; *) kill -ABRT $$ ;; esac\n\
             echo '{\"ready\":true,\"device\":\"cpu\"}'\n\
             read line && echo '{\"text\":\"buka Files\"}'\n",
        )
        .unwrap();
        let executable = std::os::unix::fs::PermissionsExt::from_mode(0o755);
        std::fs::set_permissions(&script, executable).unwrap();
        (dir, script)
    }

    #[tokio::test]
    async fn falls_back_to_the_processor_when_the_gpu_crashes() {
        let (dir, script) = crashing_helper();
        let mut whisper = Whisper::start_with(script, "tiny", "id", false).unwrap();
        whisper.audio = dir.join("voice.pcm");
        let text = whisper.transcribe(&[0; 1600]).await.unwrap();
        assert_eq!(text, "buka Files");
        assert!(GPU_FAILED.load(Ordering::Relaxed));
        assert!(!whisper.on_gpu);
        // The recording is gone once heard.
        assert!(!dir.join("voice.pcm").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn names_where_it_runs() {
        assert_eq!(
            device_name(r#"{"device":"Intel(R) UHD Graphics 630 (CFL GT2)","gpus":[]}"#),
            "the GPU (Intel(R) UHD Graphics 630 (CFL GT2))"
        );
        assert_eq!(
            device_name("{\"device\":\"cpu\",\"gpus\":[]}\n"),
            "the processor (no graphics card found)"
        );
        assert_eq!(
            device_name(r#"{"device":"cpu","gpus":["Intel(R) UHD Graphics 630 (CFL GT2)"]}"#),
            "the processor (integrated graphics are not used)"
        );
        assert!(device_name(r#"{"error":"needs AVX2"}"#).contains("needs AVX2"));
        assert!(device_name("").contains("processor"));
    }

    #[test]
    fn wav_header_encoding_is_valid_16khz_mono() {
        let samples: Vec<i16> = vec![0, 100, -100, 32767, -32768];
        let wav = encode_wav_16k_mono(&samples);
        assert_eq!(wav.len(), 44 + samples.len() * 2);
        assert_eq!(&wav[0..4], b"RIFF");
        let chunk_size = u32::from_le_bytes(wav[4..8].try_into().unwrap());
        assert_eq!(chunk_size, 36 + (samples.len() * 2) as u32);
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        let subchunk1_size = u32::from_le_bytes(wav[16..20].try_into().unwrap());
        assert_eq!(subchunk1_size, 16);
        let audio_format = u16::from_le_bytes(wav[20..22].try_into().unwrap());
        assert_eq!(audio_format, 1);
        let num_channels = u16::from_le_bytes(wav[22..24].try_into().unwrap());
        assert_eq!(num_channels, 1);
        let sample_rate = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        assert_eq!(sample_rate, 16000);
        let byte_rate = u32::from_le_bytes(wav[28..32].try_into().unwrap());
        assert_eq!(byte_rate, 32000);
        let block_align = u16::from_le_bytes(wav[32..34].try_into().unwrap());
        assert_eq!(block_align, 2);
        let bits_per_sample = u16::from_le_bytes(wav[34..36].try_into().unwrap());
        assert_eq!(bits_per_sample, 16);
        assert_eq!(&wav[36..40], b"data");
        let data_size = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        assert_eq!(data_size, (samples.len() * 2) as u32);

        for (i, &sample) in samples.iter().enumerate() {
            let offset = 44 + i * 2;
            let s = i16::from_le_bytes(wav[offset..offset + 2].try_into().unwrap());
            assert_eq!(s, sample);
        }
    }

    #[test]
    fn parses_handy_json_output_with_log_prefix() {
        let stdout = "\
[2026-11-11][20:39:51][handy_app_lib::system_languages][INFO] System languages: [\"en-US\"]
[2026-11-11][20:39:51][handy_app_lib::managers::model][INFO] Seeded 73 catalog model(s)
[2026-11-11][20:39:51][transcribe_worker][INFO] [transcribe_cpp] load_backend: loaded Vulkan backend
[2026-11-11][20:39:51][handy_app_lib::managers::transcription][INFO] Transcription completed in 0.12s
{\"audio_secs\":1.0,\"best_ms\":122,\"model\":\"handy-computer/parakeet-unified-en-0.6b-gguf/parakeet-unified-en-0.6b-Q8_0.gguf\",\"text\":\"  hello handy parakeet  \"}
";
        let parsed = parse_handy_output(stdout).unwrap();
        assert_eq!(parsed, "hello handy parakeet");
    }

    #[test]
    fn handy_binary_detection() {
        if Path::new("/usr/bin/handy").is_file() {
            assert!(handy().is_some());
            assert!(installed());
            let rep = report();
            assert!(rep.contains("Parakeet Unified English 0.6B"));
            assert!(rep.contains("Vulkan GPU"));
        }
    }
}
