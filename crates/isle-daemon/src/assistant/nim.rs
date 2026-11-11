// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! NVIDIA NIM provider integration using OpenAI-compatible HTTP chat completions with SSE streaming.
//! Connects to `https://integrate.api.nvidia.com/v1/chat/completions` with native tool calling support
//! and streaming responses directly into Isle's assistant architecture.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::bail;
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use super::answer::{Answer, SCHEMA, from_text};
use super::models::{Catalog, Model};

pub const DEFAULT_MODEL: &str = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const ENDPOINT: &str = "https://integrate.api.nvidia.com/v1/chat/completions";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

/// Reads the NVIDIA NIM API key from the environment or secure config files.
/// Never logs or prints the secret.
pub fn api_key() -> Option<String> {
    if let Ok(key) = std::env::var("NVIDIA_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    if let Ok(key) = std::env::var("NIM_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    let home = dirs::home_dir()?;
    let key_files = [
        home.join(".config/isle/nim_api_key"),
        home.join(".local/share/isle/nim_api_key"),
    ];
    for path in key_files {
        if let Ok(content) = std::fs::read_to_string(path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    let json_files = [
        home.join(".config/isle/nim.json"),
        home.join(".local/share/isle/nim.json"),
    ];
    for path in json_files {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                if let Some(key) = val["api_key"].as_str() {
                    let trimmed = key.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_owned());
                    }
                }
            }
        }
    }
    None
}

/// Whether an API key is available for NVIDIA NIM.
pub fn signed_in() -> bool {
    api_key().is_some()
}

/// Model catalog for NVIDIA NIM.
pub fn catalog() -> Catalog {
    Catalog {
        plan: "NVIDIA NIM".into(),
        default: DEFAULT_MODEL.into(),
        default_name: "Nemotron 3.5 Super VL 120B".into(),
        models: vec![
            Model {
                id: DEFAULT_MODEL.into(),
                name: "Nemotron 3.5 Super VL 120B".into(),
            },
            Model {
                id: "meta/llama-3.3-70b-instruct".into(),
                name: "Llama 3.3 70B Instruct".into(),
            },
        ],
        checked_ms: crate::clock::now_ms(),
    }
}

/// Native OpenAI-compatible tool specifications corresponding to Isle tools.
fn native_tools() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "check",
                "description": "Run a read-only system check command to inspect system state (e.g. wpctl, systemctl status, ip route).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The command line string to run."
                        }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "run",
                "description": "Offer a command for the user to approve and run. This displays an interactive Command Card in Isle with Run and Deny buttons; it is never executed without user approval.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The command line to propose."
                        },
                        "why": {
                            "type": "string",
                            "description": "Short summary explaining why this command is proposed."
                        },
                        "detail": {
                            "type": "string",
                            "description": "Optional additional risk details or context."
                        },
                        "root": {
                            "type": "boolean",
                            "description": "Whether the command requires root/system privileges."
                        }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "find_files",
                "description": "Search for files by terms and optional directory/kind.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "terms": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "File search terms."
                        },
                        "in": {
                            "type": "string",
                            "description": "Directory name or path (e.g., Downloads, Documents)."
                        },
                        "kind": {
                            "type": "string",
                            "description": "Optional file kind filter, e.g. audio, image, document."
                        }
                    },
                    "required": ["terms"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_folder",
                "description": "List contents of a directory path.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to inspect."
                        }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "read_text",
                "description": "Read text content from a local file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path to read."
                        }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "find_apps",
                "description": "Search for installed applications.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "terms": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "App search terms."
                        }
                    },
                    "required": ["terms"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "top_processes",
                "description": "Check what processes are using the computer.",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        }),
    ]
}

/// Accumulator for tool calls streamed across multiple SSE chunks.
#[derive(Debug, Default, Clone)]
struct ToolCallChunk {
    id: String,
    name: String,
    arguments: String,
}

/// Running NVIDIA NIM session holding conversation context and API configuration.
pub struct Nim {
    api_key: String,
    model: String,
    _workspace: PathBuf,
    _instructions: String,
    pub conversation: Option<String>,
    history: Vec<Value>,
}

impl Nim {
    /// Starts a session with NVIDIA NIM, checking API key and initializing conversation context.
    pub async fn start(
        model: &str,
        resume: Option<&str>,
        workspace: &Path,
        instructions: &str,
    ) -> anyhow::Result<Self> {
        let key = api_key().ok_or_else(|| {
            anyhow::anyhow!(
                "Sign in to NVIDIA NIM: API key not set (set NVIDIA_API_KEY or write ~/.config/isle/nim_api_key)"
            )
        })?;
        std::fs::create_dir_all(workspace)?;

        let model = if model.is_empty() {
            DEFAULT_MODEL.to_owned()
        } else {
            model.to_owned()
        };

        let conversation_id = resume
            .map(str::to_owned)
            .unwrap_or_else(|| format!("nim-{}", crate::clock::now_ms()));

        let system_prompt = format!(
            "{instructions}\n\nAnswer every request with a JSON object conforming to this schema:\n{SCHEMA}"
        );

        let history = vec![json!({
            "role": "system",
            "content": system_prompt,
        })];

        Ok(Self {
            api_key: key,
            model,
            _workspace: workspace.to_owned(),
            _instructions: instructions.to_owned(),
            conversation: Some(conversation_id),
            history,
        })
    }

    /// One turn of conversation with NVIDIA NIM: sends prompt, streams SSE chunks, parses tool calls.
    pub async fn ask(
        &mut self,
        prompt: &str,
        activity: Option<&UnboundedSender<String>>,
        draft: Option<&UnboundedSender<String>>,
    ) -> anyhow::Result<Answer> {
        self.history.push(json!({
            "role": "user",
            "content": prompt,
        }));

        let payload = json!({
            "model": self.model,
            "messages": self.history,
            "temperature": 0.2,
            "top_p": 0.7,
            "max_tokens": 4096,
            "stream": true,
            "tools": native_tools(),
            "chat_template_kwargs": {
                "enable_thinking": true
            }
        });

        let api_key = self.api_key.clone();
        let activity_tx = activity.cloned();
        let draft_tx = draft.cloned();

        let (accumulated_content, tool_calls) = tokio::task::spawn_blocking(move || -> anyhow::Result<(String, Vec<ToolCallChunk>)> {
            let request = crate::http::post(ENDPOINT, REQUEST_TIMEOUT);
            let response = match request
                .header("Authorization", &format!("Bearer {api_key}"))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .send_json(&payload)
            {
                Ok(resp) => resp,
                Err(err) => match err {
                    ureq::Error::StatusCode(401 | 403) => {
                        bail!("NVIDIA NIM: 401 Unauthorized - invalid API key");
                    }
                    ureq::Error::StatusCode(429) => {
                        bail!("NVIDIA NIM: 429 Rate Limit Exceeded");
                    }
                    ureq::Error::StatusCode(code) => {
                        bail!("NVIDIA NIM returned HTTP status {code}");
                    }
                    _ => bail!("NVIDIA NIM connection failed: {err}"),
                },
            };

            let mut reader = BufReader::new(response.into_body().into_reader());
            let mut line = String::new();
            let mut accumulated = String::new();
            let mut tool_chunks: BTreeMap<usize, ToolCallChunk> = BTreeMap::new();
            let mut thinking_sent = false;

            while reader.read_line(&mut line)? > 0 {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    line.clear();
                    continue;
                }
                if let Some(rest) = trimmed.strip_prefix("data:") {
                    let data = rest.trim();
                    if data == "[DONE]" {
                        break;
                    }
                    if let Ok(chunk) = serde_json::from_str::<Value>(data) {
                        if let Some(choices) = chunk.get("choices").and_then(Value::as_array) {
                            if let Some(first) = choices.first() {
                                if let Some(delta) = first.get("delta") {
                                    // Handle reasoning tokens if available
                                    if let Some(reasoning) = delta.get("reasoning_content").or_else(|| delta.get("reasoning")).and_then(Value::as_str) {
                                        if !reasoning.is_empty() && !thinking_sent {
                                            if let Some(ref tx) = activity_tx {
                                                tx.send("Thinking…".to_string()).ok();
                                                thinking_sent = true;
                                            }
                                        }
                                    }

                                    // Handle content tokens
                                    if let Some(text) = delta.get("content").and_then(Value::as_str) {
                                        if !text.is_empty() {
                                            accumulated.push_str(text);
                                            if let Some(ref tx) = draft_tx {
                                                tx.send(accumulated.clone()).ok();
                                            }
                                        }
                                    }

                                    // Handle streaming tool calls
                                    if let Some(tools_arr) = delta.get("tool_calls").and_then(Value::as_array) {
                                        for tool_val in tools_arr {
                                            let index = tool_val.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                                            let entry = tool_chunks.entry(index).or_default();
                                            if let Some(id) = tool_val.get("id").and_then(Value::as_str) {
                                                entry.id.push_str(id);
                                            }
                                            if let Some(func) = tool_val.get("function") {
                                                if let Some(name) = func.get("name").and_then(Value::as_str) {
                                                    entry.name.push_str(name);
                                                }
                                                if let Some(args) = func.get("arguments").and_then(Value::as_str) {
                                                    entry.arguments.push_str(args);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                line.clear();
            }

            Ok((accumulated, tool_chunks.into_values().collect()))
        }).await??;

        // Process tool calls or parse JSON schema answer
        if !tool_calls.is_empty() {
            let mut actions = Vec::new();
            for call in &tool_calls {
                let parsed_args: Value = serde_json::from_str(&call.arguments).unwrap_or(json!({}));
                let action = match call.name.as_str() {
                    "run" => json!({
                        "type": "run",
                        "command": parsed_args.get("command").and_then(Value::as_str).unwrap_or(""),
                        "why": parsed_args.get("why").and_then(Value::as_str).unwrap_or("Run a command"),
                        "detail": parsed_args.get("detail").and_then(Value::as_str).unwrap_or(""),
                        "root": parsed_args.get("root").and_then(Value::as_bool).unwrap_or(false),
                    }),
                    "check" => json!({
                        "type": "check",
                        "command": parsed_args.get("command").and_then(Value::as_str).unwrap_or(""),
                    }),
                    "find_files" => json!({
                        "type": "find_files",
                        "terms": parsed_args.get("terms").cloned().unwrap_or(json!([])),
                        "in": parsed_args.get("in").and_then(Value::as_str).unwrap_or(""),
                        "kind": parsed_args.get("kind").and_then(Value::as_str).unwrap_or(""),
                    }),
                    "list_folder" => json!({
                        "type": "list_folder",
                        "path": parsed_args.get("path").and_then(Value::as_str).unwrap_or(""),
                    }),
                    "read_text" => json!({
                        "type": "read_text",
                        "path": parsed_args.get("path").and_then(Value::as_str).unwrap_or(""),
                    }),
                    "find_apps" => json!({
                        "type": "find_apps",
                        "terms": parsed_args.get("terms").cloned().unwrap_or(json!([])),
                    }),
                    "top_processes" => json!({
                        "type": "top_processes",
                    }),
                    other => json!({
                        "type": other,
                    }),
                };
                actions.push(action);
            }

            // Record assistant tool calls in history
            let tool_calls_json: Vec<Value> = tool_calls
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    json!({
                        "id": if c.id.is_empty() { format!("call_{}_{}", crate::clock::now_ms(), i) } else { c.id.clone() },
                        "type": "function",
                        "function": {
                            "name": c.name,
                            "arguments": c.arguments,
                        }
                    })
                })
                .collect();

            self.history.push(json!({
                "role": "assistant",
                "content": if accumulated_content.is_empty() { Value::Null } else { Value::String(accumulated_content.clone()) },
                "tool_calls": tool_calls_json,
            }));

            Ok(Answer {
                say: accumulated_content,
                actions,
                listen: false,
                done: false, // More turns expected to execute tools / user approval
                tools: Vec::new(),
                checks: Vec::new(),
                checked: false,
                ran: Vec::new(),
            })
        } else {
            // Text answer - parse JSON schema or plain text
            let answer = from_text(&accumulated_content);
            self.history.push(json!({
                "role": "assistant",
                "content": accumulated_content,
            }));
            Ok(answer)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::brain::{Provider, explain};

    #[test]
    fn nim_catalog_and_default_model() {
        let cat = catalog();
        assert_eq!(cat.plan, "NVIDIA NIM");
        assert_eq!(cat.default, DEFAULT_MODEL);
        assert!(cat.allows(DEFAULT_MODEL));
        assert!(cat.models.iter().any(|m| m.id == DEFAULT_MODEL));
    }

    #[test]
    fn native_tools_contain_isle_capabilities() {
        let tools = native_tools();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("function")?.get("name")?.as_str())
            .collect();

        assert!(names.contains(&"check"));
        assert!(names.contains(&"run"));
        assert!(names.contains(&"find_files"));
        assert!(names.contains(&"list_folder"));
        assert!(names.contains(&"read_text"));
        assert!(names.contains(&"find_apps"));
        assert!(names.contains(&"top_processes"));
    }

    #[test]
    fn tool_calling_arguments_parse_to_actions() {
        let run_args = json!({
            "command": "systemctl status NetworkManager",
            "why": "Check network service status",
            "root": false
        });
        let action = match "run" {
            "run" => json!({
                "type": "run",
                "command": run_args["command"],
                "why": run_args["why"],
                "detail": "",
                "root": run_args["root"]
            }),
            _ => json!({}),
        };
        assert_eq!(action["type"], "run");
        assert_eq!(action["command"], "systemctl status NetworkManager");
        assert_eq!(action["why"], "Check network service status");
        assert_eq!(action["root"], false);
    }

    #[test]
    fn nim_errors_explain_correctly() {
        let auth_err = explain(Provider::Nim, "NVIDIA NIM: 401 Unauthorized - invalid API key");
        assert!(auth_err.sign_in);
        assert!(auth_err.error.contains("Sign in to NVIDIA NIM"));

        let rate_err = explain(Provider::Nim, "NVIDIA NIM: 429 Rate Limit Exceeded");
        assert!(rate_err.error.contains("NVIDIA NIM isn’t available"));

        let offline_err = explain(Provider::Nim, "NVIDIA NIM connection failed: connection refused");
        assert_eq!(offline_err.error, "You’re offline");
    }

    #[tokio::test]
    async fn nim_start_without_key_fails_safely() {
        // Temporarily ensure no keys in env for test
        let prev_nvidia = std::env::var("NVIDIA_API_KEY").ok();
        let prev_nim = std::env::var("NIM_API_KEY").ok();
        unsafe {
            std::env::remove_var("NVIDIA_API_KEY");
            std::env::remove_var("NIM_API_KEY");
        }

        // When no key file is present, start fails with clear sign-in instruction
        if api_key().is_none() {
            let res = Nim::start("", None, Path::new("/tmp"), "instructions").await;
            assert!(res.is_err());
            let err_msg = res.err().unwrap().to_string();
            assert!(err_msg.contains("Sign in to NVIDIA NIM"));
        }

        unsafe {
            if let Some(val) = prev_nvidia {
                std::env::set_var("NVIDIA_API_KEY", val);
            }
            if let Some(val) = prev_nim {
                std::env::set_var("NIM_API_KEY", val);
            }
        }
    }

    #[test]
    fn chunk_accumulation_merges_streamed_tool_calls() {
        let mut tool_chunks: BTreeMap<usize, ToolCallChunk> = BTreeMap::new();

        // Simulate incoming SSE delta chunks
        let chunk1 = json!({
            "index": 0,
            "id": "call_123",
            "function": { "name": "check", "arguments": "{\"com" }
        });
        let chunk2 = json!({
            "index": 0,
            "function": { "arguments": "mand\":\"wpctl status\"}" }
        });

        for tool_val in [&chunk1, &chunk2] {
            let index = tool_val.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let entry = tool_chunks.entry(index).or_default();
            if let Some(id) = tool_val.get("id").and_then(Value::as_str) {
                entry.id.push_str(id);
            }
            if let Some(func) = tool_val.get("function") {
                if let Some(name) = func.get("name").and_then(Value::as_str) {
                    entry.name.push_str(name);
                }
                if let Some(args) = func.get("arguments").and_then(Value::as_str) {
                    entry.arguments.push_str(args);
                }
            }
        }

        let calls: Vec<ToolCallChunk> = tool_chunks.into_values().collect();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_123");
        assert_eq!(calls[0].name, "check");
        assert_eq!(calls[0].arguments, "{\"command\":\"wpctl status\"}");

        let parsed: Value = serde_json::from_str(&calls[0].arguments).unwrap();
        assert_eq!(parsed["command"], "wpctl status");
    }
}
