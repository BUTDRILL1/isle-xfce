// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Piper Text-to-Speech integration with streaming sentence delivery and selective speech.
//! Uses Piper (`en_GB-jenny_dioco-medium`, Irish female accent) piped into `paplay`.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};

const MODEL_REL: &str = "piper/voices/en_GB-jenny_dioco-medium.onnx";
const BIN_REL: &str = "piper/piper/piper";
const MAX_SPOKEN_CHARS: usize = 700;

struct PiperProcess {
    piper: Child,
    paplay: Child,
}

struct SpeakState {
    process: Option<PiperProcess>,
    spoken_chars: usize,
    finished: bool,
}

static STATE: LazyLock<Mutex<SpeakState>> = LazyLock::new(|| {
    Mutex::new(SpeakState {
        process: None,
        spoken_chars: 0,
        finished: false,
    })
});

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("isle")
}

fn piper_bin() -> PathBuf {
    data_dir().join(BIN_REL)
}

fn model_path() -> PathBuf {
    data_dir().join(MODEL_REL)
}

/// Checks if piper executable and the Jenny Dioco model are installed.
pub fn installed() -> bool {
    piper_bin().is_file() && model_path().is_file()
}

/// Checks if speech output is currently muted by user flag file.
pub fn muted() -> bool {
    let flag = dirs::runtime_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("isle-speech-muted");
    flag.exists()
}

/// Resets state for a new turn.
pub fn begin_turn() {
    stop();
    if let Ok(mut state) = STATE.lock() {
        state.spoken_chars = 0;
        state.finished = false;
    }
}

/// Immediately terminates active synthesis and playback.
pub fn stop() {
    if let Ok(mut state) = STATE.lock() {
        if let Some(mut proc) = state.process.take() {
            let _ = proc.piper.kill();
            let _ = proc.paplay.kill();
            let _ = proc.piper.wait();
            let _ = proc.paplay.wait();
        }
    }
}

/// Checks if speech is currently active (Piper or paplay is still running).
pub fn is_speaking() -> bool {
    if let Ok(mut state) = STATE.lock() {
        if let Some(ref mut proc) = state.process {
            let piper_alive = matches!(proc.piper.try_wait(), Ok(None));
            let paplay_alive = matches!(proc.paplay.try_wait(), Ok(None));
            if piper_alive || paplay_alive {
                true
            } else {
                state.process = None;
                false
            }
        } else {
            false
        }
    } else {
        false
    }
}

/// Truncates text before any trailing JSON object or ```json fence so TTS never speaks JSON.
pub fn strip_json_blocks(text: &str) -> &str {
    let mut cut = text.len();
    if let Some(fence_idx) = text.find("```json") {
        cut = cut.min(fence_idx);
    }
    let bytes = text.as_bytes();
    for i in 0..cut {
        if bytes[i] == b'{' {
            let rest = text[i + 1..cut].trim_start();
            if rest.starts_with("\"actions\"")
                || rest.starts_with("\"done\"")
                || rest.starts_with("\"say\"")
                || rest.starts_with("\"listen\"")
                || rest.starts_with('}')
                || rest.is_empty()
            {
                cut = cut.min(i);
                break;
            }
        }
    }
    text[..cut].trim_end()
}

/// Clean markdown, code blocks, URLs, and formatting characters before speaking.
pub fn clean_text(text: &str) -> String {
    let text = strip_json_blocks(text);
    let mut cleaned = String::with_capacity(text.len());
    let mut in_code_block = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }

        let mut in_inline_code = false;
        let chars = line.chars();
        for c in chars {
            if c == '`' {
                in_inline_code = !in_inline_code;
                continue;
            }
            if in_inline_code {
                continue;
            }
            if matches!(c, '*' | '_' | '#' | '>' | '{' | '}' | '[' | ']' | '"') {
                continue;
            }
            cleaned.push(c);
        }
        cleaned.push(' ');
    }

    // Strip basic URLs
    let words: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|w| !w.starts_with("http://") && !w.starts_with("https://"))
        .collect();

    words.join(" ")
}

/// Extracts complete sentences and returns (sentences_to_speak, consumed_len).
pub fn split_sentences(text: &str) -> (Vec<String>, usize) {
    let mut sentences = Vec::new();
    let mut last_end = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();

    for i in 0..chars.len() {
        let (byte_idx, c) = chars[i];
        if c == '.' || c == '!' || c == '?' || c == '\n' {
            let next_is_space_or_end = if i + 1 < chars.len() {
                chars[i + 1].1.is_whitespace()
            } else {
                true
            };

            if next_is_space_or_end {
                let sentence = text[last_end..=byte_idx].trim();
                if !sentence.is_empty() {
                    sentences.push(sentence.to_string());
                }
                last_end = if i + 1 < chars.len() {
                    chars[i + 1].0
                } else {
                    text.len()
                };
            }
        }
    }

    (sentences, last_end)
}

fn write_to_piper(proc: &mut PiperProcess, text: &str) -> bool {
    let cleaned = clean_text(text);
    if cleaned.trim().is_empty() {
        return true;
    }
    if let Some(stdin) = proc.piper.stdin.as_mut() {
        if writeln!(stdin, "{}", cleaned).is_ok() && stdin.flush().is_ok() {
            return true;
        }
    }
    false
}

fn ensure_process(state: &mut SpeakState) -> bool {
    if state.process.is_some() {
        return true;
    }
    if !installed() || muted() {
        return false;
    }

    let mut piper_cmd = Command::new(piper_bin());
    piper_cmd
        .arg("--model")
        .arg(model_path())
        .arg("--output-raw")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut piper = match piper_cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            log::warn!("Failed to spawn piper: {e}");
            return false;
        }
    };

    let piper_stdout = match piper.stdout.take() {
        Some(out) => out,
        None => return false,
    };

    let mut paplay_cmd = Command::new("paplay");
    paplay_cmd
        .arg("--raw")
        .arg("--rate=22050")
        .arg("--channels=1")
        .arg("--format=s16le")
        .stdin(Stdio::from(piper_stdout))
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let paplay = match paplay_cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            log::warn!("Failed to spawn paplay: {e}");
            let _ = piper.kill();
            return false;
        }
    };

    state.process = Some(PiperProcess { piper, paplay });
    true
}

/// Feeds newly formed complete sentences during streaming of final answer.
pub fn stream(say_so_far: &str) {
    if !installed() || muted() {
        return;
    }
    let say_so_far = strip_json_blocks(say_so_far);

    let mut state = match STATE.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    if state.finished || state.spoken_chars >= MAX_SPOKEN_CHARS {
        return;
    }

    if say_so_far.len() <= state.spoken_chars {
        return;
    }

    let new_content = &say_so_far[state.spoken_chars..];
    let (sentences, consumed) = split_sentences(new_content);

    if !sentences.is_empty() {
        if ensure_process(&mut state) {
            for sentence in sentences {
                if let Some(proc) = state.process.as_mut() {
                    let _ = write_to_piper(proc, &sentence);
                }
            }
            state.spoken_chars += consumed;
        }
    }
}

/// Speaks any remaining unspoken content when the reply turn completes.
pub fn finish(say: &str) {
    if !installed() || muted() {
        return;
    }
    let say = strip_json_blocks(say);

    let mut state = match STATE.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    if state.finished {
        return;
    }
    state.finished = true;

    if say.len() > state.spoken_chars && state.spoken_chars < MAX_SPOKEN_CHARS {
        let remainder = &say[state.spoken_chars..];
        let cleaned = clean_text(remainder);
        if !cleaned.trim().is_empty() && ensure_process(&mut state) {
            if let Some(proc) = state.process.as_mut() {
                let _ = write_to_piper(proc, &cleaned);
            }
        }
        state.spoken_chars = say.len();
    }

    // Drop piper stdin to signal EOF so speech finishes and process exits cleanly
    if let Some(proc) = state.process.as_mut() {
        proc.piper.stdin.take();
    }
}

/// Speaks an interactive command approval question.
pub fn offer(why: &str) {
    if !installed() || muted() {
        return;
    }
    begin_turn();

    let mut state = match STATE.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    let text = if why.trim().is_empty() {
        "Shall I run this command for you?".to_string()
    } else {
        format!("Shall I run this: {}?", why.trim())
    };

    if ensure_process(&mut state) {
        if let Some(proc) = state.process.as_mut() {
            let _ = write_to_piper(proc, &text);
            proc.piper.stdin.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_text() {
        let input = "Here is `some code` and a link: https://example.com.\n```bash\necho ignore\n```\n**Bold** text!";
        let cleaned = clean_text(input);
        assert_eq!(cleaned.trim(), "Here is and a link: Bold text!");
    }

    #[test]
    fn test_split_sentences() {
        let input = "First sentence. Second sentence! Incomplete part";
        let (sentences, consumed) = split_sentences(input);
        assert_eq!(sentences.len(), 2);
        assert_eq!(sentences[0], "First sentence.");
        assert_eq!(sentences[1], "Second sentence!");
        assert_eq!(input[consumed..].trim(), "Incomplete part");
    }
}
