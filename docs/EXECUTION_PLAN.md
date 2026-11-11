# Isle XFCE/X11 — Master Execution Blueprint (Phases 3–7)

> **How to use this document with Gemini 3.8 Flash:**
> Each sub-phase below is scoped to **1–3 files** with exact line numbers, upstream reference files, concrete code changes, and verification commands.
> Tell Gemini 3.8 Flash:
> `"Execute Phase 3A from docs/EXECUTION_PLAN.md and stop for review."`

---

## Global Guardrails (MANDATORY FOR ALL PHASES)

1. **NEVER modify `crates/isle-daemon/src/caller.rs`** — `isle-ui` already claims `org.gnome.Shell` on the session bus in `ui/main.js` (lines 24–35).
2. **NEVER remove X11 `override_redirect`** or break X11 focus restoration in `crates/isle-ui/src/x11.rs` and `crates/isle-ui/src/window.rs`.
3. **NEVER alter the 3-tier geometry constants** in `crates/isle-ui/src/window.rs` (lines 23–38):
   - Compact: `240 × 38 px` (`18px` radius)
   - Standard Expanded: `600 × 300 px` (`24px` radius)
   - Assistant Expanded: `640 × 380 px` (`24px` radius)
4. **NEVER hardcode or log API keys** (`NVIDIA_API_KEY`, `NIM_API_KEY`, or `~/.config/isle/nim_api_key`).
5. **Always run checks before finishing a sub-phase:**
   - Rust check: `cargo check -p isle-ui && cargo check -p isle-daemon`
   - Rust tests: `cargo test -p isle-daemon`
   - JS syntax check: `node --check ui/*.js ui/pages/*.js`

---

## Phase 3 — Assistant & NVIDIA NIM End-to-End Completion

### Phase 3A: Fix NVIDIA NIM Streaming Drafts & Multi-Turn Tool History (Rust Backend)

- **Target File:** `crates/isle-daemon/src/assistant/nim.rs`
- **Upstream Reference:** `crates/isle-daemon/src/assistant/answer.rs` (lines 120–148, `partial_say`) and `crates/isle-daemon/src/assistant/agent.rs` (lines 411–419)

#### Problem 1: Raw JSON streamed into chat bubble
In `crates/isle-daemon/src/assistant/nim.rs` (lines 383–390), SSE content chunks are appended to `accumulated` and sent raw to `draft_tx`. Because the system prompt instructs the model to reply with `SCHEMA` JSON (`{"say": "...", "actions": [...]}`), `draft_tx` receives raw JSON text instead of just the `"say"` string.
- **Fix in `nim.rs` (lines 17 and 383–390):**
  Import `partial_say` from `super::answer::{Answer, SCHEMA, from_text, partial_say};`.
  When sending to `draft_tx`:
  ```rust
  if let Some(ref tx) = draft_tx {
      if let Some(say) = partial_say(&accumulated) {
          tx.send(say).ok();
      } else if !accumulated.trim_start().starts_with('{') && !accumulated.trim_start().starts_with("```") {
          tx.send(accumulated.clone()).ok();
      }
  }
  ```

#### Problem 2: OpenAI-compatible `tool_calls` history mismatch on turn 2+
In `crates/isle-daemon/src/assistant/nim.rs` (lines 482–486), when native `tool_calls` are returned, `nim.rs` pushes an `assistant` message with `"tool_calls"` into `self.history`. On the next step of the agent loop, `agent.rs` (lines 411–419) calls `brain.ask("Results from this computer...")`, which in `nim.rs` (line 306) pushes a `"role": "user"` message. OpenAI-compatible APIs reject an `assistant` message containing `tool_calls` if it is not immediately followed by `"role": "tool"` messages for each `tool_call_id`.
- **Fix in `nim.rs`:**
  1. Add `pending_tool_ids: Vec<String>` to `pub struct Nim` (initialized to `Vec::new()`).
  2. When `tool_calls` are recorded (around lines 467–486), store their IDs in `self.pending_tool_ids`.
  3. At the start of `pub async fn ask(...)` (lines 306–309), if `!self.pending_tool_ids.is_empty()`, take the IDs via `std::mem::take(&mut self.pending_tool_ids)` and push a `"role": "tool"` message for each ID with `"tool_call_id": id` and `"content": prompt`, instead of a `"role": "user"` message.
  4. Add a unit test in `nim.rs` verifying that a multi-step tool call populates `"role": "tool"` messages with matching `tool_call_id`s and that `partial_say` extracts only the `say` text during streaming.

#### Verification for Phase 3A
```bash
cargo test -p isle-daemon assistant::nim
cargo check -p isle-daemon
```

---

### Phase 3B: Real CommandCard Execution & `Results` Handshake in `ui/assistant.js`

- **Target Files:**
  - `ui/assistant.js`
  - `ui/daemon.js`
- **Upstream References:**
  - `gnome-extension/src/controller.js` (lines 2784–2844, `_onAssistant`, `_decide`)
  - `gnome-extension/src/voice.js` (lines 1331–1340, `run` action)
  - `crates/isle-daemon/src/assistant/tasks.rs` (lines 56–120)

#### Exact Changes Required
1. **Remove fake CommandCard trigger when `isled` is connected (`ui/assistant.js` lines 281–315):**
   - Currently, lines 293–295 run `if (text.toLowerCase().includes('install') ...)` unconditionally, even when `this._daemon?.running` is true.
   - Change `_submit()` so that if `this._daemon && this._daemon._proxies['assistant'] && this._daemon.running`, it **only** calls `this._daemon.call('assistant', 'Ask', text, context)` and does **not** run the fake `_presentCommandApprovalCard(text)`. Keep the standalone fallback strictly inside `else` (when `isled` is not running).
2. **Wire `NewChat` and `ClearChat` properly (`ui/assistant.js` lines 416–429):**
   - When the user clicks the `+` (`_newChatBtn`), call `this._daemon.call('assistant', 'NewChat')` (in addition to clearing the view).
3. **Wire `phase === 'acting'`, CommandCard `Run`/`Deny`/`Stop`, and `Results(step, json)` (`ui/assistant.js` lines 353–491):**
   - Track `this._lastStep = 0` and `this._pendingDecision = null` on `AssistantView`.
   - In `_syncState()`:
     - Handle `state.phase === 'error'`: set `this._face.setForm('confused')`, display `state.error` (and `state.hint` if present) in `this._statusLabel` or as an assistant error message in the chat view so errors (like missing NIM API key or offline state) are clearly visible.
     - Handle `state.card`: if `state.card && state.card.command`, show `this._commandCard` and call `this._commandCard.setCard(state.card)`. If `!state.card` (or `state.card === null`) and `state.phase === 'listening'`, hide `this._commandCard`.
     - Handle `state.phase === 'acting' && state.step !== this._lastStep`:
       - Set `this._lastStep = state.step`.
       - Execute `this._handleActions(state.step, state.actions || [])`.
   - Implement `async _handleActions(step, actions)`:
     - For each action in `actions`:
       - If `action.type === 'run'`:
         - Wait for user decision via a Promise stored in `this._pendingDecision = { resolve }` (resolved when `_onCardDecided(run)` is called by clicking Run or Deny on `this._commandCard`).
         - If `run === true` and `Array.isArray(action.spawn)`:
           - Spawn `action.spawn` (or wrapped with `pkexec` if `action.scope === 'system'`) using `Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)` and wait for `systemd-run` to exit (`communicate_utf8_async`), returning `{ type: 'run', ok: true, detail: 'started' }` (or `{ type: 'run', ok: false, detail: stderr }` on failure).
         - If `run === false`:
           - Return `{ type: 'run', ok: false, detail: 'run failed: denied' }`.
       - For other desktop actions (`open_url`, `open_folder`, `media`, `focus`, `add_task`, `done_task`, `remove_task`, `remind`, `cancel_reminder`, `wifi`), execute them (see Phase 3C) and collect `{ type: action.type, ok, detail }`.
     - Send results back to `isled`:
       ```js
       this._daemon.call('assistant', 'Results', step, JSON.stringify(results));
       ```
   - In `_onCardStop()`:
     - If `this._daemon?.state?.assistant?.card?.stop` is an array of args (e.g. `["systemctl", "--user", "stop", "isle-run-..."]`), spawn that command via `Gio.Subprocess` to stop the running systemd unit.

#### Verification for Phase 3B
```bash
node --check ui/assistant.js ui/daemon.js
```

---

### Phase 3C: Port Desktop Actions for XFCE (`ui/actions.js`)

- **Target Files:**
  - Create `ui/actions.js`
  - Import into `ui/assistant.js`
- **Upstream Reference:** `gnome-extension/src/voice.js` (lines 1236–1348, `ACTIONS`)

#### Exact Changes Required
Create `ui/actions.js` exporting `export async function executeActions(actions, { daemon, decide })` that implements XFCE/X11-compatible versions of upstream's `ACTIONS`:
- `open_url`: `Gio.AppInfo.launch_default_for_uri(url, null)`
- `open_folder` / `open_file`: `Gio.AppInfo.launch_default_for_uri(file.get_uri(), null)`
- `open_app`: Search `Gio.AppInfo.get_all()` by name/id and call `appInfo.launch([], null)`
- `media`: Call `daemon.call('media', method)` (`PlayPause`, `Next`, `Previous`)
- `focus`: Call `daemon.call('pomodoro', command === 'stop' ? 'Stop' : 'Start')`
- `add_task`, `done_task`, `remove_task`: Call `daemon.call('todo', ...)`
- `remind`, `cancel_reminder`: Call `daemon.call('reminders', ...)`
- `volume`: Run `wpctl set-volume @DEFAULT_AUDIO_SINK@ ...` or `wpctl set-mute` via `Gio.Subprocess`
- `wifi`: Run `nmcli radio wifi on|off` via `Gio.Subprocess`
- `brightness`: Run `brightnessctl set ...` or `xfpm-power-backlight-helper` if available
- `run`: Await `decide(action)` and run `action.spawn` (for `scope === 'system'`, prefix with `pkexec` as upstream `tasks.js` does).

#### Verification for Phase 3C
```bash
node --check ui/actions.js ui/assistant.js
```

---

## Phase 4 — Voice Integration (`isle-whisper` + PipeWire Mic in Assistant)

### Phase 4A: Build Dependency & Whisper Verification
- **Target Crate:** `crates/isle-whisper` and `crates/isle-daemon/src/assistant/mic.rs`
- **Prerequisite:** Install `cmake` on the host (`sudo pacman -S --needed cmake` or equivalent) so `whisper-rs-sys` builds cleanly.
- **Check:** Run `cargo check --workspace` to verify `isle-whisper` compiles with Vulkan/CPU support.

### Phase 4B: Wire Microphone Button & Live Audio Level in `ui/assistant.js`
- **Target Files:** `ui/assistant.js` and `ui/daemon.js`
- **Upstream Reference:** `gnome-extension/src/voice.js` (lines 160–470)
- **Exact Changes Required:**
  1. In `ui/daemon.js` (lines 223–225), verify `_onSignal` forwards the `assistant` `Level` signal (`this.emit('assistant-level', level)`).
  2. In `ui/assistant.js`:
     - Add a Microphone button (`isle-mic-symbolic`) next to `this._entry` in `inputRow`.
     - Clicking the Mic button (or clicking `this._face` orb) calls `this._toggleListen()`:
       - When starting listen: calls `this._daemon.call('assistant', 'Listen', context)` and sets `this._face.setForm('listening')`, `this._statusLabel.set_text('Listening…')`.
       - When stopping listen while `phase === 'listening'`: calls `this._daemon.call('assistant', 'Stop')`.
     - Connect to `daemon` signal `'assistant-level'` and update `this._face.level = level` so the Cairo Bot character's mouth/body animates to the user's voice in real time (60fps).
     - When `state.heard` updates during `transcribing` / `thinking`, display the transcribed speech in the chat view or status label.

---

## Phase 5 — Feature Parity (Remaining Upstream Pages)

All daemon backends (`todo.rs`, `reminders.rs`, `calendar.rs`, `clipboard.rs`, `shelf.rs`, `app_usage.rs`, `system/`) **already exist and run in `isled`**.

### Phase 5A: Register Remaining D-Bus Interfaces in `ui/daemon.js`
- **Target File:** `ui/daemon.js` (lines 55–135)
- **Upstream Reference:** `gnome-extension/src/daemon.js` (lines 19–148)
- **Action:** Copy the missing XML interface definitions (`calendar`, `clipboard`, `shelf`, `share`, `appUsage`, `updates`, `agents`) from `gnome-extension/src/daemon.js` into `INTERFACES` in `ui/daemon.js`.

### Phase 5B: Port Tasks & Reminders Page (`ui/pages/tasks.js`)
- **Target Files:** Create `ui/pages/tasks.js` and mount in `ui/main.js` (lines 100–109, replacing the placeholder `reminders` page).
- **Upstream Reference:** `gnome-extension/src/pages/tasks.js`
- **Features:** Todo list (`daemon.state.tasks`), add task entry, checkbox toggle (`todo.SetDone`), delete (`todo.Remove`), Clear Done (`todo.ClearDone`), and active Reminders list (`daemon.state.reminders`, `reminders.Add`, `reminders.Dismiss`). Fit cleanly inside Standard Expanded (`600 × 300 px`).

### Phase 5C: Port Calendar & Schedule Page (`ui/pages/calendar.js`)
- **Target Files:** Create `ui/pages/calendar.js` and mount in `ui/main.js` (lines 120–129).
- **Upstream Reference:** `gnome-extension/src/pages/calendar.js`
- **Features:** Month/day strip + upcoming events from `daemon.state.calendar`, quick event creation (`calendar.Add`), and meeting join button if a meeting URL is present.

### Phase 5D: Port Shelf & Clipboard Pages (`ui/pages/shelf.js` & `ui/pages/clips.js`)
- **Target Files:** Create `ui/pages/shelf.js` and mount in `ui/main.js` (lines 110–119).
- **Upstream Reference:** `gnome-extension/src/pages/shelf.js` & `gnome-extension/src/pages/clips.js`
- **Features:** File drop target (`Gtk.DropTarget`), pinned shelf items (`daemon.state.shelf`), and recent clipboard history (`daemon.state.clipboard`, click to copy via `clipboard.Select`).

### Phase 5E: Port Devices & Apps Usage Pages (`ui/pages/devices.js` & `ui/pages/apps.js`)
- **Target Files:** Create `ui/pages/devices.js` and `ui/pages/apps.js`, mount in `ui/main.js` (lines 130–149).
- **Upstream Reference:** `gnome-extension/src/pages/devices.js` & `gnome-extension/src/pages/apps.js`
- **Features:** Connected Bluetooth/audio/battery devices from `daemon.state.system`, and daily app screen-time usage from `daemon.state.appUsage`.

---

## Phase 6 — Security, Reliability & XFCE Desktop Integration

### Phase 6A: D-Bus Reconnection & Daemon Crash Recovery
- **Target Files:** `ui/daemon.js` and `ui/assistant.js`
- **Action:**
  - Listen to `daemon.connect('running-changed', ...)` in `ui/assistant.js`.
  - If `isled` stops or restarts mid-request (`!daemon.running` while `phase` is `thinking` or `acting`), reset the assistant state to `error` (`"Isle daemon restarted — ask again"`), cancel any pending decision promise, and automatically reconnect when `isled` returns.

### Phase 6B: Global X11 Hotkey Support (Toggle Notch & Open Assistant)
- **Target Files:** `crates/isle-ui/src/x11.rs` and `crates/isle-ui/src/window.rs`
- **Action:**
  - Add a D-Bus action or CLI signal (`io.github.zickrian.isle.Ui` `Toggle` / `OpenAssistant`) so the user can bind `Super+I` in XFCE Keyboard Shortcuts (`xfconf-query` / Settings -> Keyboard) to immediately expand Isle and focus the Assistant entry from anywhere.

---

## Phase 7 — Production Readiness & Packaging

### Phase 7A: Configuration & API Key Setup (`isle-ui` / `isled`)
- **Action:**
  - Ensure `~/.config/isle/` directory creation with `0700` permissions.
  - Support reading default provider/model and NIM API key from `~/.config/isle/nim.json` or `~/.config/isle/config.json`.
  - Add a quick setup command or settings dialog so the user can paste their NVIDIA NIM key without editing files manually.

### Phase 7B: Systemd User Units & XFCE Autostart
- **Target Files:**
  - Create `packaging/systemd/isled.service` (`~/.config/systemd/user/isled.service`)
  - Create `packaging/systemd/isle-ui.service` or `~/.config/autostart/isle-ui.desktop`
  - Update `install.sh` to build release binaries (`cargo build --release -p isle-daemon -p isle-ui`), install them to `~/.local/bin/`, and enable the systemd user services.

