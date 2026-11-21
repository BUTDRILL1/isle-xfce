// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! BUTLER assistant backend integration for Isle XFCE.
//! Spawns and communicates with `butler_bridge.py` over JSON-lines stdio protocol.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::timeout;

use super::answer::Answer;
use super::models::{Catalog, Model};

pub struct Butler {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    pub conversation: Option<String>,
}

pub fn python_bin() -> Option<PathBuf> {
    if let Some(home) = dirs::home_dir() {
        let p = home.join("Desktop/BUTLER/butenv/bin/python");
        if p.is_file() {
            return Some(p);
        }
    }
    let direct = Path::new("/home/butarch/Desktop/BUTLER/butenv/bin/python");
    if direct.is_file() {
        return Some(direct.to_path_buf());
    }
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("python3");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let fallback = Path::new("python3");
    Some(fallback.to_path_buf())
}

pub fn bridge_path() -> Option<PathBuf> {
    if let Ok(path_str) = std::env::var("ISLE_BUTLER_BRIDGE") {
        let p = PathBuf::from(path_str);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p1 = parent.join("../../scripts/butler_bridge.py");
            if p1.is_file() {
                if let Ok(canon) = p1.canonicalize() {
                    return Some(canon);
                }
            }
            let p2 = parent.join("scripts/butler_bridge.py");
            if p2.is_file() {
                if let Ok(canon) = p2.canonicalize() {
                    return Some(canon);
                }
            }
        }
    }
    let current_dir_script = Path::new("scripts/butler_bridge.py");
    if current_dir_script.is_file() {
        if let Ok(canon) = current_dir_script.canonicalize() {
            return Some(canon);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let p = home.join("Desktop/isle-xfce/scripts/butler_bridge.py");
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(data_dir) = dirs::data_dir() {
        let p = data_dir.join("isle/scripts/butler_bridge.py");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn signed_in() -> bool {
    let env_vars = [
        "NVIDIA_API_KEY",
        "NIM_API_KEY",
        "BUTLER_GEMINI_API_KEY",
        "BUTLER_CLAUDE_API_KEY",
        "BUTLER_NVIDIA_API_KEY",
    ];
    for var in env_vars {
        if let Ok(val) = std::env::var(var) {
            if !val.trim().is_empty() {
                return true;
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        let key_path = home.join(".config/isle/nim_api_key");
        if let Ok(content) = std::fs::read_to_string(key_path) {
            if !content.trim().is_empty() {
                return true;
            }
        }
        let auth_path = home.join(".config/isle/auth.json");
        if let Ok(content) = std::fs::read_to_string(auth_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                if let Some(map) = val.as_object() {
                    for v in map.values() {
                        if let Some(s) = v.as_str() {
                            if !s.trim().is_empty() {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        let butler_env = home.join("Desktop/BUTLER/.env");
        if butler_env.is_file() {
            return true;
        }
    }
    false
}

impl Butler {
    pub async fn start(
        backend: &str,
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        let python = python_bin().ok_or_else(|| anyhow::anyhow!("Python binary not found"))?;
        let bridge = bridge_path().ok_or_else(|| anyhow::anyhow!("Butler bridge script not found"))?;

        let mut child = Command::new(python)
            .arg("-u")
            .arg(&bridge)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("Failed to open stdin to bridge"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("Failed to open stdout from bridge"))?;
        let reader = BufReader::new(stdout).lines();

        let resume_str = resume.unwrap_or("");
        let init_msg = json!({
            "cmd": "init",
            "provider": backend,
            "model": model,
            "workspace": workspace,
            "instructions": instructions,
            "resume": resume_str,
        });

        let mut stdin_writer = stdin;
        let mut stdout_reader = reader;

        let line = format!("{}\n", init_msg.to_string());
        stdin_writer.write_all(line.as_bytes()).await?;
        stdin_writer.flush().await?;

        let init_fut = async {
            while let Some(line) = stdout_reader.next_line().await? {
                if let Ok(val) = serde_json::from_str::<Value>(&line) {
                    let msg_type = val["type"].as_str().unwrap_or("");
                    if msg_type == "ready" {
                        let cid = val["conversation_id"].as_str().map(|s| s.to_string());
                        return Ok(cid);
                    } else if msg_type == "error" {
                        let err_msg = val["message"].as_str().unwrap_or("Unknown bridge error");
                        anyhow::bail!("Bridge error during init: {}", err_msg);
                    }
                }
            }
            anyhow::bail!("Bridge closed stdout unexpectedly during init")
        };

        let conversation = timeout(Duration::from_secs(15), init_fut).await??;

        Ok(Self {
            child,
            stdin: stdin_writer,
            stdout: stdout_reader,
            conversation,
        })
    }

    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        let ask_msg = json!({
            "cmd": "ask",
            "text": prompt,
            "request_id": "req"
        });
        let line = format!("{}\n", ask_msg.to_string());
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;

        loop {
            let line_fut = self.stdout.next_line();
            let line_res = timeout(Duration::from_secs(120), line_fut).await?;
            let line = match line_res? {
                Some(l) => l,
                None => anyhow::bail!("Bridge closed stdout unexpectedly during ask"),
            };

            let val: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = val["type"].as_str().unwrap_or("");
            match msg_type {
                "activity" => {
                    if let Some(text) = val["text"].as_str() {
                        if let Some(tx) = activity {
                            let _ = tx.send(text.to_string());
                        }
                    }
                }
                "draft" => {
                    if let Some(text) = val["text"].as_str() {
                        if let Some(tx) = draft {
                            let _ = tx.send(text.to_string());
                        }
                    }
                }
                "confirm" => {
                    if let (Some(id), Some(tool)) = (val["id"].as_i64(), val["tool"].as_str()) {
                        let is_safe = tool.starts_with("files.search")
                            || tool.starts_with("files.read")
                            || tool.starts_with("files.list")
                            || tool.starts_with("weather.")
                            || tool.starts_with("web.")
                            || tool.starts_with("notes.list")
                            || tool.starts_with("reminders.list")
                            || tool.starts_with("skills.list")
                            || tool.starts_with("system.");
                        let confirm_reply = json!({
                            "cmd": "confirm_reply",
                            "id": id,
                            "allow": is_safe
                        });
                        let reply_line = format!("{}\n", confirm_reply.to_string());
                        self.stdin.write_all(reply_line.as_bytes()).await?;
                        self.stdin.flush().await?;
                    }
                }
                "answer" => {
                    if let Some(cid) = val["conversation_id"].as_str() {
                        self.conversation = Some(cid.to_string());
                    }
                    let say = val["say"].as_str().unwrap_or("").to_string();
                    let actions = val["actions"].as_array().cloned().unwrap_or_default();
                    let done = val["done"].as_bool().unwrap_or(true);
                    let listen = val["listen"].as_bool().unwrap_or(false);

                    let answer = Answer {
                        say,
                        actions,
                        listen,
                        done,
                        tools: Vec::new(),
                        checks: Vec::new(),
                        checked: false,
                        ran: Vec::new(),
                    };
                    return Ok(answer);
                }
                "error" => {
                    let err_msg = val["message"].as_str().unwrap_or("Unknown bridge error");
                    anyhow::bail!("Bridge error during ask: {}", err_msg);
                }
                _ => {}
            }
        }
    }
}

pub fn catalog() -> Catalog {
    Catalog {
        plan: "BUTLER Runtime".into(),
        default: "".into(),
        default_name: "Auto (Provider Default)".into(),
        models: vec![
            Model {
                id: "butler-default".into(),
                name: "BUTLER Default Runtime".into(),
            },
        ],
        checked_ms: crate::clock::now_ms(),
    }
}

impl Drop for Butler {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
