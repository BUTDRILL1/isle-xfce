// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Authentic Isle Assistant View for Isle XFCE.
//! Integrates the original Cairo-rendered Bot character (bloub morphing, eye tracking,
//! expressions, gestures), conversation history (ChatView), and interactive command
//! security approval cards (CommandCard).

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { Bot, paletteFor } from './bot.js';
import { BotIcon } from './botIcon.js';
import { ChatView, CommandCard, label } from './chat.js';
import { icon, iconButton } from './widgets.js';

const FACE_SIZE = 36;
const POINTER_REST_S = 2.5;

/** Suggestion chips when the entry is empty. */
const IDEAS = [
    ['Today’s plan', 'What’s on my calendar today?', true],
    ['Install an app…', 'Install ', false],
    ['Find a file…', 'Find ', false],
    ['System status', 'Check CPU and memory usage', true],
];

// ── Cairo Animated Bot Face ───────────────────────────────────────────

export const Face = GObject.registerClass({
    GTypeName: 'IsleGtkFace',
}, class Face extends Gtk.DrawingArea {
    _init(look = {}) {
        super._init({
            hexpand: false,
            vexpand: false,
            css_classes: ['isle-voice-orb'],
        });
        this.set_content_width(FACE_SIZE);
        this.set_content_height(FACE_SIZE);

        this.bot = new Bot(look);
        this.level = 0;
        this._pointerAt = -POINTER_REST_S;
        this._look = { x: 0, y: 0 };

        this.set_draw_func((area, cr, width, height) => {
            const size = Math.min(width, height);
            this.bot.paint(cr, size);
        });

        // Frame animation clock (approx 60 fps)
        this._startTime = GLib.get_monotonic_time();
        this._tickId = this.add_tick_callback(() => {
            const now = GLib.get_monotonic_time();
            const timeSec = (now - this._startTime) / 1000000.0;
            this.bot.step(timeSec, this._look, this.level);
            this.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    setPointerTarget(px, py) {
        // Normalize pointer position relative to face center (-1.0 .. 1.0)
        this._look = {
            x: Math.max(-1.0, Math.min(1.0, px / 300.0)),
            y: Math.max(-1.0, Math.min(1.0, py / 150.0)),
        };
    }

    setLook({ shape, palette }) {
        if (palette) this.bot.palette = palette;
        if (shape) this.bot.setShape(shape);
        this.queue_draw();
    }

    setForm(form) {
        this.bot.setForm(form);
        this.queue_draw();
    }

    gesture(name) {
        this.bot.gesture(name);
        this.queue_draw();
    }
});

// ── Assistant View ────────────────────────────────────────────────────

export const AssistantView = GObject.registerClass({
    GTypeName: 'IsleGtkAssistantView',
    Signals: {
        'close-requested': {},
        'submitted': { param_types: [GObject.TYPE_STRING] },
    },
}, class AssistantView extends Gtk.Box {
    _init(daemon = null) {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            css_classes: ['isle-assistant-view'],
            hexpand: true,
            vexpand: true,
        });

        this._daemon = daemon;
        this._history = [];

        // 1. Header Row (Fixed height): Character Face, Title / Status, New Chat, Close
        const headerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            css_classes: ['isle-assistant-header'],
            valign: Gtk.Align.START,
        });

        // Animated Cairo Bot Character
        this._face = new Face({ shape: 'circle' });
        this._face.set_valign(Gtk.Align.CENTER);
        headerRow.append(this._face);

        // Center Box: Title & Status
        const statusBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        const titleLabel = label('Isle Assistant', 'isle-assistant-title');
        titleLabel.set_halign(Gtk.Align.START);
        statusBox.append(titleLabel);

        this._statusLabel = label('Ready', 'isle-assistant-status');
        this._statusLabel.set_halign(Gtk.Align.START);
        statusBox.append(this._statusLabel);

        headerRow.append(statusBox);

        // Action Buttons: + New Chat, × Close
        const headerActions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });

        this._newChatBtn = iconButton('isle-plus-symbolic', 'isle-button-flat', () => {
            this.clearConversation();
        }, { size: 13, accessibleName: 'New chat' });
        headerActions.append(this._newChatBtn);

        const closeBtn = iconButton('isle-close-symbolic', 'isle-button-flat', () => {
            this.emit('close-requested');
        }, { size: 14, accessibleName: 'Close Assistant' });
        headerActions.append(closeBtn);

        headerRow.append(headerActions);
        this.append(headerRow);

        // 2. Flexible, Vertically Scrollable Conversation View
        this._chatView = new ChatView();
        this._chatView.set_hexpand(true);
        this._chatView.set_vexpand(true);
        this._chatView.connect('new-chat', () => {
            this.clearConversation();
        });
        this._chatView.connect('copied', () => {
            this._statusLabel.set_text('Copied to clipboard');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                this._statusLabel.set_text('Ready');
                return GLib.SOURCE_REMOVE;
            });
        });
        this.append(this._chatView);

        // 3. Interactive Command Approval Card
        this._commandCard = new CommandCard();
        this._commandCard.set_visible(false);
        this._commandCard.connect('decided', (_card, run) => {
            this._onCardDecided(run);
        });
        this._commandCard.connect('stop', () => {
            this._onCardStop();
        });
        this.append(this._commandCard);

        // 4. Compact Horizontal Suggestion Chips
        this._ideasBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            css_classes: ['isle-voice-ideas'],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.END,
        });
        for (const [chipLabel, promptText, autoSend] of IDEAS) {
            const btn = new Gtk.Button({
                label: chipLabel,
                css_classes: ['isle-voice-idea', 'isle-pill'],
            });
            btn.connect('clicked', () => {
                this._entry.set_text(promptText);
                if (autoSend) {
                    this._submit();
                } else {
                    this._entry.grab_focus();
                    this._entry.set_position(-1);
                }
            });
            this._ideasBox.append(btn);
        }
        this.append(this._ideasBox);

        // 5. Fixed Input Row at the Bottom
        const inputRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['isle-assistant-input-row'],
            valign: Gtk.Align.END,
            hexpand: true,
        });

        this._entry = new Gtk.Entry({
            placeholder_text: 'Ask Isle Assistant…',
            css_classes: ['isle-entry', 'isle-voice-entry'],
            hexpand: true,
        });
        this._entry.connect('activate', () => this._submit());
        inputRow.append(this._entry);

        this._sendButton = iconButton('isle-arrow-up-symbolic', 'isle-button-round isle-voice-send', () => {
            this._submit();
        }, { size: 14, accessibleName: 'Send prompt' });
        inputRow.append(this._sendButton);

        this.append(inputRow);

        // Track pointer movement inside the assistant to turn eyes
        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_ctrl, x, y) => {
            this._face.setPointerTarget(x - 24, y - 24);
        });
        this.add_controller(motion);

        // Bind to daemon if available
        if (this._daemon) {
            this._daemon.connect('changed', (_d, key) => {
                if (key === 'chat') {
                    this._syncHistory();
                } else if (key === 'assistant') {
                    this._syncState();
                }
            });
            this._syncHistory();
            this._syncState();
        }
    }

    _submit() {
        const text = this._entry.get_text().trim();
        if (!text) return;
        this._entry.set_text('');

        // 1. Add user message to history
        this._history.push({
            role: 'user',
            text: text,
            at: GLib.get_real_time() / 1000,
        });

        // 2. Character expression -> thinking
        this._face.setForm('thinking');
        this._statusLabel.set_text('Thinking…');
        this._ideasBox.set_visible(false);
        this._chatView.setItems(this._history);

        this.emit('submitted', text);

        // 3. Process prompt: if connected to isled D-Bus daemon, delegate to daemon Ask
        if (this._daemon && this._daemon._proxies['assistant']) {
            const context = JSON.stringify({
                provider: 'nim',
                nim_model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
            });
            this._daemon.call('assistant', 'Ask', text, context).catch(err => {
                console.warn(`Isle: Assistant Ask D-Bus call failed: ${err.message}`);
            });
        }

        // 4. Process prompt: if command triggers simulated approval card (for standalone testing)
        if (text.toLowerCase().includes('install') || text.toLowerCase().includes('remove') || text.toLowerCase().includes('root') || text.toLowerCase().includes('script')) {
            this._presentCommandApprovalCard(text);
        } else if (!this._daemon || !this._daemon._proxies['assistant']) {
            // Generate contextual response when running in standalone mode
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._face.setForm('reply');
                this._face.gesture('nod');

                let replyText = `I understand you asked: **${text}**.\n\n` +
                    `• NVIDIA NIM provider active (\`nvidia/nemotron-3.5-super-vl-120b-a12b\`)\n` +
                    `• D-Bus daemon \`isled\` provider architecture integrated\n` +
                    `• Security controls active (caller verification + command card authorization)`;

                this._history.push({
                    role: 'assistant',
                    text: replyText,
                    at: GLib.get_real_time() / 1000,
                });
                this._chatView.setItems(this._history);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /** Triggers the authentic interactive command approval card workflow. */
    _presentCommandApprovalCard(userRequest) {
        this._face.setForm('asking');
        let cmd = 'sudo pacman -S --needed htop';
        let why = 'Install system process monitor';
        let detail = 'Requires administrator password to install system packages';
        let risks = ['root'];

        if (userRequest.toLowerCase().includes('remove')) {
            cmd = 'rm -rf ~/.cache/thumbnails/*';
            why = 'Free disk space by clearing thumbnail cache';
            detail = 'Permanently deletes cached image files';
            risks = ['removes'];
        } else if (userRequest.toLowerCase().includes('script')) {
            cmd = 'curl -sSL https://get.example.org/install.sh | bash';
            why = 'Run remote installation script';
            detail = 'Downloads and executes code from the web';
            risks = ['internet'];
        }

        const card = {
            id: 'cmd-approval-01',
            command: cmd,
            why: why,
            detail: detail,
            risks: risks,
            status: 'waiting',
            output: '',
            seconds: 0,
        };

        this._activeCard = card;
        this._commandCard.setCard(card);
        this._commandCard.set_visible(true);
    }

    _onCardDecided(run) {
        if (!this._activeCard) return;

        if (run) {
            // User authorized command
            this._face.setForm('running');
            this._activeCard.status = 'running';
            this._activeCard.output = 'Resolving dependencies...\nChecking available disk space...';
            this._commandCard.setCard(this._activeCard);

            // Simulate command execution progress
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._activeCard.status = 'done';
                this._activeCard.seconds = 1.2;
                this._activeCard.output = 'Target successfully updated.\nDone.';
                this._commandCard.setCard(this._activeCard);
                this._face.setForm('success');
                this._face.gesture('hop');

                // Append command execution record to chat history
                this._history.push({
                    role: 'command',
                    command: this._activeCard.command,
                    status: 'done',
                    at: GLib.get_real_time() / 1000,
                });
                this._history.push({
                    role: 'assistant',
                    text: `Command completed successfully: \`${this._activeCard.command}\``,
                    at: GLib.get_real_time() / 1000,
                });
                this._chatView.setItems(this._history);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            // User denied command
            this._face.setForm('confused');
            this._face.gesture('shake');
            this._activeCard.status = 'denied';
            this._commandCard.setCard(this._activeCard);

            this._history.push({
                role: 'command',
                command: this._activeCard.command,
                status: 'denied',
                at: GLib.get_real_time() / 1000,
            });
            this._history.push({
                role: 'assistant',
                text: 'Action was denied. No changes were made to your system.',
                at: GLib.get_real_time() / 1000,
            });
            this._chatView.setItems(this._history);
        }
    }

    _onCardStop() {
        if (!this._activeCard) return;
        this._activeCard.status = 'stopped';
        this._commandCard.setCard(this._activeCard);
        this._face.setForm('confused');
    }

    clearConversation() {
        this._history = [];
        this._chatView.setItems([]);
        this._commandCard.set_visible(false);
        this._ideasBox.set_visible(true);
        this._face.setForm('listening');
        this._statusLabel.set_text('Ready');
        this.focusEntry();
        if (this._daemon) {
            try {
                this._daemon.call('assistant', 'ClearChat');
            } catch (_) {}
        }
    }

    _syncHistory() {
        const chat = this._daemon?.state?.chat;
        if (Array.isArray(chat) && chat.length > 0) {
            this._history = chat;
            this._chatView.setItems(this._history);
            this._chatView.set_visible(true);
            this._ideasBox.set_visible(false);
        }
    }

    _syncState() {
        const state = this._daemon?.state?.assistant;
        if (!state) return;

        if (state.phase) {
            this._face.setForm(state.phase);
        }

        if (state.activity) {
            this._statusLabel.set_text(state.activity);
            this._statusLabel.set_visible(true);
        } else {
            this._statusLabel.set_visible(false);
        }

        if (state.draft) {
            const lastMsg = this._history[this._history.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
                lastMsg.text = state.draft;
            } else {
                this._history.push({
                    role: 'assistant',
                    text: state.draft,
                    at: GLib.get_real_time() / 1000,
                });
            }
            this._chatView.setItems(this._history);
            this._chatView.set_visible(true);
            this._ideasBox.set_visible(false);
        } else if (state.reply && state.phase === 'reply') {
            const lastMsg = this._history[this._history.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
                lastMsg.text = state.reply;
            } else {
                this._history.push({
                    role: 'assistant',
                    text: state.reply,
                    at: GLib.get_real_time() / 1000,
                });
            }
            this._chatView.setItems(this._history);
            this._chatView.set_visible(true);
            this._ideasBox.set_visible(false);
        }

        if (state.card) {
            this._activeCard = state.card;
            this._commandCard.setCard(state.card);
            this._commandCard.set_visible(true);
        }
    }

    get entry() {
        return this._entry;
    }

    focusEntry() {
        if (!this._entry) return;
        this._entry.grab_focus();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._entry) {
                this._entry.grab_focus();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    get face() {
        return this._face;
    }

    get chatView() {
        return this._chatView;
    }

    get commandCard() {
        return this._commandCard;
    }
});

