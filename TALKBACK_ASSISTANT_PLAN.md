# Live Talkback Assistant (`Super + I` / `240×240`) — Micro-Step Implementation Plan

## Architecture Overview

Upgrades `Super + I` (`isle-ui --toggle` -> `/tmp/isle_assistant` `"toggle"`) from opening the full `640×380` text chat drawer into a **compact `240×240` vertical-drop live voice talkback overlay**:

1. **Vertical Drop Geometry (`240×38` -> `240×240`)**: Keeping width anchored at `COMPACT_WIDTH` (`240px`), the height spring expands smoothly down to `240px` (`height = width`) using a new window CSS class `isle-mode-talkback`. Existing 3-tier geometry (`240×38`, `600×300`, `640×380`) remains completely intact for `--assistant` (`isle-mode-assistant`) and hover/tabs.
2. **Enlarged Animated Face (`136×136`)**: Reuses the Cairo `Bot` character (`ui/bot.js` + `Face` in `ui/assistant.js`) scaled to `136×136` dead-center, showing expressive eye/body states for `listening` (pulsing to mic `level`), `thinking` / `acting` (upward thinking gaze + gentle motion), and `reply` (talking mouth/body pulse synced to **Jenny Dioco** Piper TTS playback).
3. **End-to-End Hands-Free Voice Loop**:
   - `Super + I` opens `240×240`, unmutes TTS if needed, and starts `isled` `assistant.Listen`.
   - `isled` Parakeet STT captures speech & emits `assistant-level` (`0..1`) + `state.heard`.
   - `isled` streams the LLM answer through `speak.rs` (`piper` + `en_GB-jenny_dioco-medium.onnx` -> `paplay`).
   - While Jenny Dioco speaks, the UI polls `assistant.Speaking()` (or `speak::is_speaking()`) and drives a smooth syllabic `face.level` animation. When speech ends: if `state.listen == true` (a follow-up question), it auto-resumes listening; otherwise it waits briefly and smoothly collapses back to `240×38`.
   - Pressing `Super + I` again or `Escape` immediately stops listening/speaking (`assistant.Stop`) and collapses to `240×38`.

---

## Global Guardrails (Apply to Every Micro-Step)

- **NEVER** modify `crates/isle-daemon/src/caller.rs`.
- **PRESERVE** X11 `override_redirect` and existing 3-tier geometry (`240×38`, `600×300`, `640×380`).
- **NEVER** log or hardcode API keys.
- Notice which mode classes map to which target dimensions:
  - `isle-mode-assistant` -> `640×380`
  - `isle-mode-talkback` -> `240×240`
  - Default expanded -> `600×300` (or `isle-h-<N>`)
  - Compact -> `240×38`

---

## Micro-Steps (Ready for Individual `flash` Subagents)

### Micro-Step 1: Add `240×240` Talkback Geometry Mode to Rust Window
- **Target File**: `crates/isle-ui/src/window.rs`
- **Relevant Lines**:
  - Constants: lines `40–50`
  - `connect_css_classes_notify`: lines `424–443`
  - `update_target_geometry`: lines `504–541`
  - `start_animation` target check & settle log: lines `593–637`
- **Exact Changes**:
  1. Add constants after line `42`:
     ```rust
     /// Square Live Talkback proportions (240 × 240 px, vertical drop preserving notch width):
     pub const TALKBACK_WIDTH: f64 = 240.0;
     pub const TALKBACK_HEIGHT: f64 = 240.0;
     pub const TALKBACK_RADIUS: f64 = 28.0;
     ```
  2. In `connect_css_classes_notify` (lines `427–441`), check `let is_talkback = win.has_css_class("isle-mode-talkback");`:
     - Treat `is_asst || is_talkback || is_force` as active open states:
       - If `(is_asst || is_talkback || is_force) && !floating.0.is_expanded.get()` -> call `floating.set_expanded(true, if is_talkback { "talkback-hotkey" } else if is_asst { "assistant-hotkey" } else { "force-expand" })`.
       - Else if `!is_asst && !is_talkback && !is_force && !floating.0.is_hovered.get() && floating.0.is_expanded.get()` -> `floating.set_expanded(false, "mode-close")`.
       - Else -> `floating.update_target_geometry("css-classes-changed")`.
  3. In `update_target_geometry` (lines `506–531`), check `let is_talkback = self.0.window.has_css_class("isle-mode-talkback");`:
     - Under `else if is_expanded`:
       - If `is_asst` -> `(ASSISTANT_EXPANDED_WIDTH, ASSISTANT_EXPANDED_HEIGHT, EXPANDED_RADIUS, EXPANDED_SHOULDER)`
       - Else if `is_talkback` -> `(TALKBACK_WIDTH, TALKBACK_HEIGHT, TALKBACK_RADIUS, COMPACT_SHOULDER)`
       - Else -> standard expanded `(STANDARD_EXPANDED_WIDTH, Self::custom_expanded_height(...), EXPANDED_RADIUS, EXPANDED_SHOULDER)`.
  4. In `start_animation` (lines `594–631`), include `is_talkback`:
     - Resolve `target_w` and `target_h` with the same `if is_asst ... else if is_talkback ... else ...` logic.
     - Log `"TALKBACK_EXPANDED (240x240)"` when settling in `is_talkback`.
- **Verification**:
  ```bash
  cargo check -p isle-ui
  ```

---

### Micro-Step 2: Protect Talkback Mode from Accidental Hover-Leave Collapse & Focus Loss
- **Target File**: `crates/isle-ui/src/window.rs`
- **Relevant Lines**:
  - `connect_leave` 120ms debounce callback: lines `326–352`
  - `set_expanded(false, ...)`: lines `492–497`
- **Exact Changes**:
  1. In `connect_leave`'s 120ms timeout callback (around line `340`), check `if !contains && !is_hovered {`:
     - Guard: if `inner.window.has_css_class("isle-mode-talkback")`, do NOT collapse on pointer leave (because the user invoked `Super + I` hands-free via keyboard and the cursor may be outside `240×240`).
  2. In `set_expanded` when `expanded == false` (lines `492–497`):
     - Ensure `self.0.window.remove_css_class("isle-mode-talkback");` is also cleared if collapsed programmatically or manually, alongside `isle-force-expand`.
- **Verification**:
  ```bash
  cargo check -p isle-ui
  ```

---

### Micro-Step 3: Expose `speak::is_speaking()` in Rust Daemon (`isled`) + D-Bus Method
- **Target Files**:
  - `crates/isle-daemon/src/assistant/speak.rs`
  - `crates/isle-daemon/src/assistant/mod.rs`
- **Relevant Lines**:
  - `speak.rs`: lines `22–82` (`STATE`, `muted()`, `stop()`)
  - `assistant/mod.rs`: `#[interface(name = "io.github.zickrian.isle.Assistant")]` (`listen`, `stop`, etc. around lines `385–450`)
- **Exact Changes**:
  1. In `crates/isle-daemon/src/assistant/speak.rs`, add:
     ```rust
     /// Returns true if Piper or paplay is currently synthesizing/playing speech.
     pub fn is_speaking() -> bool {
         let Ok(mut state) = STATE.lock() else {
             return false;
         };
         let Some(proc) = state.process.as_mut() else {
             return false;
         };
         matches!(proc.paplay.try_wait(), Ok(None)) || matches!(proc.piper.try_wait(), Ok(None))
     }
     ```
  2. Read lines `380–455` of `crates/isle-daemon/src/assistant/mod.rs` to locate the D-Bus `#[interface]` block, and add a lightweight D-Bus method:
     ```rust
     async fn speaking(&self) -> bool {
         speak::is_speaking()
     }
     ```
     (Check whether `caller::` auth is used on read methods in that block — never modify `crates/isle-daemon/src/caller.rs`!).
  3. Also ensure `assistant.Stop` in `mod.rs` calls `speak::stop()` cleanly if it doesn't already.
- **Verification**:
  ```bash
  cargo test -p isle-daemon speak
  cargo check -p isle-daemon
  ```

---

### Micro-Step 4: Parameterize `Face` Size & Add Speaking Envelope Helper in `ui/assistant.js`
- **Target File**: `ui/assistant.js`
- **Relevant Lines**: lines `23–25` and `91–147` (`Face` class)
- **Exact Changes**:
  1. Update `Face._init(look = {})`:
     ```javascript
     const faceSize = look.size || FACE_SIZE;
     this._faceSize = faceSize;
     this.set_content_width(faceSize);
     this.set_content_height(faceSize);
     ```
  2. Add a method `setSpeaking(active)` on `Face`:
     - Stores `this._speakingActive = Boolean(active);`.
     - Inside the existing `add_tick_callback` (lines `115–120`):
       - When `this._speakingActive` is `true`, compute a natural syllabic voice envelope for `level` instead of leaving `level = 0`:
         ```javascript
         let activeLevel = this.level;
         if (this._speakingActive) {
             // Smooth multi-sine speech cadence (2.8Hz + 6.3Hz) for lively talking motion
             const cadence = 0.45 + 0.35 * Math.sin(timeSec * 17.5) + 0.2 * Math.cos(timeSec * 39.0);
             activeLevel = Math.max(0.18, Math.min(1.0, cadence));
         }
         this.bot.step(timeSec, this._look, activeLevel);
         ```
       - Pause ticking or only queue redraws when `this.get_mapped()` is `true` so a hidden large `Face` uses **0% CPU**! (Crucial for keeping Isle lightweight!)
- **Verification**:
  ```bash
  gjs -c "import('file:///home/butarch/Desktop/isle-xfce/ui/assistant.js')" 2>&1 || true
  ```
  (Or `node --check ui/assistant.js` after stripping GI imports / syntax check via `gjs` when `isle-ui` loads).

---

### Micro-Step 5: Create `TalkbackView` Layout & Core Widget (`ui/talkback.js` — Part 1)
- **Target File**: `ui/talkback.js` (new file)
- **Dependencies**:
  - `Face` from `./assistant.js`
  - `paletteFor` from `./bot.js`
  - `label`, `icon`, `iconButton` from `./widgets.js`
- **Exact Changes**:
  1. Register `TalkbackView = GObject.registerClass({ GTypeName: 'IsleGtkTalkbackView', Signals: { 'close-requested': {} } }, class TalkbackView extends Gtk.Box { ... })`.
  2. Build vertical `240×240` layout (`orientation: VERTICAL`, `halign: CENTER`, `valign: CENTER`, `hexpand: true`, `vexpand: true`, `spacing: 8`, `css_classes: ['isle-talkback-view']`):
     - Centered **`136×136` `Face`** (`new Face({ shape: 'circle', size: 136 })`, `halign: CENTER`, `valign: CENTER`, `css_classes: ['isle-talkback-face']`).
     - Attach a `Gtk.GestureClick` to the face so clicking it toggles listening/stopping (`this._onFaceClicked()`).
     - Subtle pointer motion controller so eyes subtly follow pointer when idle/listening (`this._face.setPointerTarget(x - 120, y - 120)`).
     - Below the face: 1-line centered ellipsized status/caption label `this._statusLbl` (`Pango.EllipsizeMode.END`, `max_width_chars: 26`, `css_classes: ['isle-talkback-status']`, default `'Listening…'`).
     - Small subtle mute indicator / hint pill or clickable speaker icon at the bottom (`12px`) so the user can see or toggle Jenny Dioco voice if muted.
- **Verification**:
  File exists, imports cleanly, has `open()`, `close()`, `get isOpen()` stubs ready for Micro-Step 6.

---

### Micro-Step 6: Wire Live Voice Pipeline (`Listen` -> `Thinking` -> Jenny Dioco `Talking` -> Auto-Close) in `ui/talkback.js`
- **Target File**: `ui/talkback.js`
- **Relevant D-Bus Signals & Calls (`ui/dbus.js`)**:
  - Signal `'changed'` (`key === 'assistant'`) reading `this._daemon.state.assistant` (`phase`, `heard`, `activity`, `reply`, `listen`, `turn`, `error`, `heard_nothing`)
  - Signal `'assistant-level'` passing `level` (`0.0 .. 1.0`) during Parakeet mic recording
  - D-Bus calls:
    - `daemon.call('assistant', 'Listen', contextJson)`
    - `daemon.call('assistant', 'Stop')`
    - `daemon.call('assistant', 'Speaking')` (from Micro-Step 3)
- **Exact Changes**:
  1. **`open()`**:
     - Sets `this._open = true`, unmutes `/run/user/.../isle-speech-muted` if set (so talkback always speaks unless user explicitly re-mutes during session).
     - Sets `this._face.bot.restart()`, `this._face.setForm('listening')`, `this._face.setSpeaking(false)`, `this._statusLbl.set_text('Listening…')`.
     - Records `this._startTurn = this._daemon?.state?.assistant?.turn ?? 0`.
     - Calls `this._daemon.call('assistant', 'Listen', JSON.stringify({ provider: 'nim', nim_model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' }))`.
  2. **`close()`**:
     - Sets `this._open = false`, clears timers (`_speakPollId`, `_autoCloseId`), stops speaking animation (`this._face.setSpeaking(false)`), calls `daemon.call('assistant', 'Stop')`, emits `'close-requested'`.
  3. **`_onStateChanged()`**:
     - Only act when `this._open === true`.
     - `phase === 'listening'`:
       - `this._face.setSpeaking(false)`, `this._face.setForm('listening')`.
       - `this._statusLbl.set_text(state.heard ? `“${state.heard}”` : 'Listening…')`.
     - `phase === 'transcribing' || phase === 'thinking' || phase === 'acting'`:
       - `this._face.level = 0`, `this._face.setForm(phase === 'acting' ? 'running' : 'thinking')`.
       - `this._statusLbl.set_text(state.activity || (phase === 'transcribing' ? 'Hearing…' : 'Thinking…'))`.
     - `phase === 'reply'` (when `state.turn !== this._startTurn` or new reply arrives):
       - Stop listening indicators, set `this._face.setForm('reply')` and `this._face.gesture('nod')`.
       - Set `this._statusLbl.set_text('Speaking…')` (or concise first words of reply) and `this._face.setSpeaking(true)`.
       - Poll `daemon.call('assistant', 'Speaking')` every `180ms` (`_speakPollId`):
         - Once `Speaking()` returns `false` (after at least `500ms` grace so Piper has spawned) OR after a safety cap (`25s`):
           - Call `this._face.setSpeaking(false)`.
           - If `state.listen === true` (assistant asked a follow-up question): wait `300ms` and automatically call `Listen` again!
           - Else: set `this._face.setForm('happy')`, wait `600ms`, and call `this.close()` to collapse back to `240×38`!
     - `phase === 'error'`:
       - If `state.heard_nothing`: `this._statusLbl.set_text('Didn’t catch that')`, wait `900ms`, call `this.close()`.
       - Otherwise show concise error, `this._face.setForm('confused')`, `this._face.gesture('shake')`.
- **Verification**:
  Inspect `ui/talkback.js` state machine transitions cover every `Phase` (`idle`, `listening`, `transcribing`, `thinking`, `acting`, `reply`, `error`).

---

### Micro-Step 7: Add Talkback Styles to `ui/stylesheet-gtk.css`
- **Target File**: `ui/stylesheet-gtk.css`
- **Relevant Lines**: End of file (after line `2069`)
- **Exact Changes**:
  Append:
  ```css
  /* ── Live Talkback Square Mode (240x240) ── */
  .isle-talkback-view {
    padding: 16px 14px 14px 14px;
  }
  .isle-talkback-face {
    min-width: 136px;
    min-height: 136px;
  }
  .isle-talkback-status {
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.78);
    letter-spacing: -0.1px;
  }
  ```
- **Verification**:
  Zero CSS parse warnings in `journalctl --user -u isle-ui` on next restart.

---

### Micro-Step 8: Integrate `TalkbackView` & `Super + I` Toggle into `ui/main.js`
- **Target File**: `ui/main.js`
- **Relevant Lines**:
  - Imports: lines `14–28`
  - Overlay mounting & `syncMorphProgress`: lines `220–269`
  - `/tmp/isle_assistant` IPC handler (`open`, `toggle`, `close`): lines `271–316`
  - `keyController` (`Escape` handling): lines `393–406`
- **Exact Changes**:
  1. Import `TalkbackView` from `./talkback.js`.
  2. Instantiate `const talkbackView = new TalkbackView(daemon);`, add `overlay.add_overlay(talkbackView);`, set `talkbackView.set_visible(false);`.
  3. Connect `talkbackView.connect('close-requested', () => { win.remove_css_class('isle-mode-talkback'); syncMorphProgress(win.get_height()); });`.
  4. In `syncMorphProgress(height)`:
     - Check `const isTalkback = win.has_css_class('isle-mode-talkback');`.
     - When `isTalkback` is `true` (or `talkbackView` is closing above `height > 38` while `!expandedView.isAssistantOpen` and `!expandedView.get_visible()`):
       - Keep `expandedView` hidden (`set_visible(false)`, `set_opacity(0)`).
       - Fade out `compactView` from `height 38..85`.
       - Fade in `talkbackView` smoothly from `height 85..210` (`set_visible(true)`, `set_opacity(expAlpha)`).
     - Otherwise keep existing `compactView` <-> `expandedView` crossfade untouched.
  5. Update `/tmp/isle_assistant` `cmd === 'toggle'` (triggered by `Super + I` / `isle-ui --toggle`):
     ```javascript
     } else if (cmd === 'toggle') {
         if (win.has_css_class('isle-mode-talkback')) {
             talkbackView.close();
         } else {
             if (expandedView.isAssistantOpen) {
                 expandedView.toggleAssistant(false);
             }
             win.remove_css_class('isle-force-expand');
             win.add_css_class('isle-mode-talkback');
             talkbackView.open();
         }
     ```
     (Keep `cmd === 'open'` (`isle-ui --assistant`) opening the full `640×380` chat assistant unchanged.)
  6. In `keyController`: if `keyval === Gdk.KEY_Escape && win.has_css_class('isle-mode-talkback')`, call `talkbackView.close(); return true;`.
- **Verification**:
  Inspect `ui/main.js` to confirm `isle-mode-assistant` (`--assistant`) still opens `640×380` while `--toggle` (`Super + I`) opens `240×240` Talkback mode.

---

### Micro-Step 9: Compile Rust Binaries, Install, and Verify Logs
- **Scope**: Build both `isle-daemon` and `isle-ui` release binaries, stop services briefly to avoid `Text file busy`, install updated binaries to `~/.local/bin/`, and restart both services cleanly.
- **Exact Commands**:
  ```bash
  cargo build --release -p isle-daemon -p isle-ui && \
  systemctl --user stop isle-ui isled && \
  cp target/release/isle-daemon /home/butarch/.local/bin/isled && \
  cp target/release/isle-ui /home/butarch/.local/bin/isle-ui && \
  systemctl --user start isled isle-ui && \
  sleep 2 && \
  journalctl --user -u isle-ui -n 25 --no-pager
  ```
- **Verification**:
  - `0` compiler errors.
  - `0` `JS ERROR` or CSS errors in `journalctl`.
  - Check `isled` service unit path first (`systemctl --user show isled -p ExecStart`) to confirm exact binary filename (`isled` vs `isle-daemon`).

---

### Micro-Step 10: End-to-End Live Talkback Geometry & Animation Verification
- **Exact Commands**:
  1. Trigger `Super + I` behavior: `/home/butarch/.local/bin/isle-ui --toggle && sleep 0.7`
  2. Capture cropped screenshot at top center (`320x300+800+0`):
     `import -window root -crop 320x300+800+0 /home/butarch/.gemini/antigravity/brain/b1b2b5de-7285-4586-9ae0-3797d1933254/screen_talkback_open.png`
  3. Toggle closed: `/home/butarch/.local/bin/isle-ui --toggle && sleep 0.7`
  4. Verify `journalctl --user -u isle-ui -n 20 --no-pager` shows:
     - `Spring settled at (240.0x240.0) | target=TALKBACK_EXPANDED (240x240)`
     - Followed by `Spring settled at (240.0x38.0) | target=COMPACT (240x38)`
  5. Inspect `screen_talkback_open.png` visually via `read_file` to confirm `240×240` square proportions, centered `136×136` expressive face, and legible status label.
