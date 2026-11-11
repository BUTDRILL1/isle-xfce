# Isle TTS Plan: Piper + Jenny Dioco (Irish female), streamed, selective

## Goal
Speak ONLY: final answers, questions back to the user, approval prompts (command card), conclusions.
NEVER speak: thinking, "Searching…" steps, tool output, command logs, errors, code blocks.
Streaming: speech starts sentence-by-sentence while the final reply streams.
Light: no resident process. Piper runs only while speaking (~100 MB RAM), CPU only.

## Guardrails
- Never touch `crates/isle-daemon/src/caller.rs`. No new D-Bus methods/interfaces. No new windows.
- Never log reply text or secrets. Do not change geometry constants in `window.rs`.
- Checks: `cargo check -p isle-daemon -p isle-ui`, `cargo test -p isle-daemon`, `node --check ui/*.js ui/pages/*.js`.

## Architecture
```
nim.rs (SSE stream) --final reply detected--> speak::stream(say_so_far)
mod.rs  Phase::Reply publish ---------------> speak::finish(answer.say)
mod.rs  command card status "waiting" ------> speak::offer(why)
mod.rs  Ask / Listen / Cancel / End / NewChat -> speak::begin_turn() or speak::stop()
speak.rs: sentence splitter -> `piper --output-raw` stdin -> `paplay --raw` (22050 Hz s16 mono)
Mute: flag file  $XDG_RUNTIME_DIR/isle-speech-muted  (UI creates/removes it; no IPC)
```

## Public API of `crates/isle-daemon/src/assistant/speak.rs` (FIXED, all agents rely on it)
```rust
pub fn installed() -> bool;            // piper binary + voice model present
pub fn muted() -> bool;                // flag file exists
pub fn begin_turn();                   // stop current speech, reset spoken counter (new request)
pub fn stream(say_so_far: &str);       // FINAL reply only: speak newly completed sentences
pub fn finish(say: &str);              // speak the unspoken remainder of `say`, then close piper stdin
pub fn offer(why: &str);               // speak an approval question: "Shall I run this? <why>"
pub fn stop();                         // kill piper+paplay immediately
```
All functions are non-blocking, never panic, never error to the caller (log a warn without text).
Paths: piper `~/.local/share/isle/piper/piper/piper`, voice `~/.local/share/isle/piper/voices/en_GB-jenny_dioco-medium.onnx`.

## Rules inside speak.rs
- Lazy spawn piper on first sentence of a turn; `piper --model <onnx> --output-raw` piped into
  `paplay --raw --rate=22050 --channels=1 --format=s16le`. Close stdin at `finish`. Both exit by themselves.
- Track `spoken_chars` per turn; `finish(say)` speaks `say[spoken_chars..]`.
- Sentence split on `. ! ? \n` followed by space/end; hold back an incomplete tail in `stream`.
- Clean text before speaking: drop fenced code blocks, inline `code` content, URLs, `**`, `_`, `#`, list bullets; skip if empty.
- Cap a turn at ~700 spoken chars (then stop speaking, UI still shows the full text).
- While playing, poll `muted()` every 100 ms; if muted, `stop()`.
- `begin_turn()` and `stop()` kill the child processes (process group) so nothing lingers.
- Never speak when `!installed()` or `muted()`.

## Streaming "final" detection (nim.rs only; other providers just use `finish`)
- System prompt in `Nim::start`: add "Write the JSON keys in this order: done, actions, say, listen."
- In the SSE loop, once `"done":true` AND `"actions":[]` are seen BEFORE `"say"` starts, and no `tool_calls` seen: call `speak::stream(&say_so_far)`.
- If a `tool_calls` delta arrives later: `speak::stop()` (it was not final).
- If detection never triggers, nothing streams; `finish()` at Reply speaks everything (safe fallback).
- Do NOT change `SCHEMA` in answer.rs (shared by other providers).

## Phases
- **T1 speak.rs** (new file + `mod speak;` in assistant/mod.rs only) + unit tests (splitter, cleaner, remainder logic).
- **T2 hooks** (after T1): nim.rs detection, mod.rs calls (`begin_turn` on Ask/Listen, `stop` on Cancel/End/NewChat/ClearChat,
  `finish` at Phase::Reply publish, `offer` once per new card with status "waiting" using card["why"]).
  Never call speak for Phase::Error.
- **T3 UI mute toggle** (ui/assistant.js only): speaker icon button in the header (isle-speaker-2-symbolic / isle-speaker-off-symbolic),
  toggles flag file `GLib.get_user_runtime_dir()/isle-speech-muted`; state restored on open.
- **T4 installer** (`scripts/setup-tts.sh`, no sudo): download piper 2023.11.14-2 linux x86_64 tarball from GitHub releases and the
  Jenny Dioco voice (.onnx + .onnx.json) from huggingface rhasspy/piper-voices v1.0.0 en/en_GB/jenny_dioco/medium into the paths above.
  Verify: synthesize a test sentence to a wav, check size > 0, measure peak RSS and time.

