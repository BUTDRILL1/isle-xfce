// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Live Talkback Assistant View (`240×240` square mode).
//! Integrates centered `136×136` Face, pointer eye tracking, click-to-listen/stop,
//! and live voice state machine (listening -> thinking -> speaking -> auto-relisten/close).

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { Face } from './assistant.js';
import { paletteFor } from './bot.js';
import { getSettingsStore } from './settingsStore.js';
import { icon, iconButton } from './widgets.js';

export const TalkbackView = GObject.registerClass({
    GTypeName: 'IsleGtkTalkbackView',
    Signals: {
        'close-requested': {},
    },
}, class TalkbackView extends Gtk.Box {
    _init(daemon = null) {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-talkback-view'],
        });

        this._daemon = daemon;
        this._open = false;
        this._startTurn = 0;
        this._speakPollId = 0;
        this._autoCloseId = 0;
        this._settingsStore = getSettingsStore();

        const getLook = () => {
            const b = this._settingsStore.get().bot;
            const color = b.colorMode === 'fixed' ? b.color : 'cloud';
            return { shape: b.shape, palette: paletteFor(color, b.glow), size: 136 };
        };

        // 1. Centered 136x136 Face
        this._face = new Face(getLook());
        this._face.set_halign(Gtk.Align.CENTER);
        this._face.set_valign(Gtk.Align.CENTER);
        this._face.add_css_class('isle-talkback-face');

        const faceClick = new Gtk.GestureClick();
        faceClick.connect('released', () => this._toggleListen());
        this._face.add_controller(faceClick);

        const motionCtrl = new Gtk.EventControllerMotion();
        motionCtrl.connect('motion', (ctrl, x, y) => {
            this._face.setPointerTarget(x - 68, y - 68);
        });
        this._face.add_controller(motionCtrl);

        this.append(this._face);

        // 2. 1-line ellipsized status label
        this._statusLbl = new Gtk.Label({
            label: 'Listening…',
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 26,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-talkback-status'],
        });
        this.append(this._statusLbl);

        // 3. Bottom controls row: subtle mute toggle & close
        const bottomRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
        });

        this._settingsStore.syncTtsMuteFlag();
        this._isMuted = !this._settingsStore.get().assistant.ttsEnabled;

        this._muteBtn = iconButton(this._isMuted ? 'isle-speaker-off-symbolic' : 'isle-speaker-2-symbolic', 'isle-button-flat', () => {
            const nextMuted = !this._isMuted;
            this._isMuted = nextMuted;
            this._settingsStore.update(s => {
                s.assistant.ttsEnabled = !nextMuted;
            }, 'assistant');
            this._settingsStore.syncTtsMuteFlag();
            this._muteBtn.get_child()?.set_from_gicon(icon(this._isMuted ? 'isle-speaker-off-symbolic' : 'isle-speaker-2-symbolic', 12));
        }, { size: 12, accessibleName: 'Toggle TTS voice output' });
        bottomRow.append(this._muteBtn);

        this._settingsUnsub = this._settingsStore.subscribe(['bot', 'assistant'], (_state, topics) => {
            if (topics.includes('*') || topics.includes('bot')) {
                const b = this._settingsStore.get().bot;
                const color = b.colorMode === 'fixed' ? b.color : 'cloud';
                this._face?.setLook({ shape: b.shape, palette: paletteFor(color, b.glow) });
            }
            if (topics.includes('*') || topics.includes('assistant')) {
                this._isMuted = !this._settingsStore.get().assistant.ttsEnabled;
                this._settingsStore.syncTtsMuteFlag();
                this._muteBtn?.get_child()?.set_from_gicon(icon(this._isMuted ? 'isle-speaker-off-symbolic' : 'isle-speaker-2-symbolic', 12));
            }
        });
        this.connect('destroy', () => {
            if (this._settingsUnsub) {
                this._settingsUnsub();
                this._settingsUnsub = null;
            }
        });

        const closeBtn = iconButton('isle-close-symbolic', 'isle-button-flat', () => {
            this.close();
        }, { size: 12, accessibleName: 'Close Talkback' });
        bottomRow.append(closeBtn);

        this.append(bottomRow);

        // Connect daemon signals
        if (this._daemon) {
            this._daemon.connect('changed', (d, key) => {
                if (key === 'assistant' && this._open) {
                    this._onStateChanged();
                }
            });
            this._daemon.connect('assistant-level', (d, level) => {
                if (this._open && this._face) {
                    this._face.level = level;
                }
            });
        }
    }

    get isOpen() {
        return this._open;
    }

    open() {
        this._open = true;
        this._clearTimers();

        this._settingsStore.syncTtsMuteFlag();
        this._isMuted = !this._settingsStore.get().assistant.ttsEnabled;
        this._muteBtn.get_child()?.set_from_gicon(icon(this._isMuted ? 'isle-speaker-off-symbolic' : 'isle-speaker-2-symbolic', 12));

        this._face.bot.restart();
        this._face.setForm('listening');
        this._face.setSpeaking(false);
        this._statusLbl.set_text('Listening…');

        if (this._daemon && this._daemon.state && this._daemon.state.assistant) {
            this._startTurn = this._daemon.state.assistant.turn || 0;
        }

        if (this._daemon) {
            const context = JSON.stringify(this._settingsStore.buildAssistantContext());
            this._daemon.call('assistant', 'Listen', context).catch(err => {
                console.warn(`Isle: Talkback Listen D-Bus call failed: ${err.message}`);
                this._face.setForm('confused');
                this._statusLbl.set_text('Error starting voice');
            });
        }
    }

    close() {
        if (!this._open) return;
        this._open = false;
        this._clearTimers();
        this._face.setSpeaking(false);

        if (this._daemon) {
            this._daemon.call('assistant', 'Stop').catch(() => {});
        }

        this.emit('close-requested');
    }

    _clearTimers() {
        if (this._speakPollId) {
            GLib.source_remove(this._speakPollId);
            this._speakPollId = 0;
        }
        if (this._autoCloseId) {
            GLib.source_remove(this._autoCloseId);
            this._autoCloseId = 0;
        }
    }

    _toggleListen() {
        const state = this._daemon?.state?.assistant;
        if (state?.phase === 'listening') {
            this.close();
            return;
        }
        this.open();
    }

    _onStateChanged() {
        const state = this._daemon?.state?.assistant;
        if (!state) return;

        const phase = state.phase;
        if (phase === 'listening') {
            this._face.setSpeaking(false);
            this._face.setForm('listening');
            this._statusLbl.set_text(state.heard ? `“${state.heard}”` : 'Listening…');
        } else if (phase === 'transcribing' || phase === 'thinking' || phase === 'acting') {
            this._face.level = 0;
            this._face.setForm(phase === 'acting' ? 'running' : 'thinking');
            this._statusLbl.set_text(state.activity || (phase === 'transcribing' ? 'Hearing…' : 'Thinking…'));
        } else if (phase === 'reply') {
            const currentTurn = state.turn || 0;
            if (currentTurn !== this._startTurn || this._statusLbl.get_text() !== 'Speaking…') {
                this._startTurn = currentTurn;
                this._face.setForm('reply');
                this._face.gesture('nod');
                this._statusLbl.set_text('Speaking…');
                this._face.setSpeaking(true);

                if (this._speakPollId) GLib.source_remove(this._speakPollId);
                let checks = 0;
                const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                    if (!this._open || this._speakPollId !== pollId) {
                        return GLib.SOURCE_REMOVE;
                    }
                    checks++;
                    this._daemon.attemptQuietly('assistant', 'Speaking').then(({ result }) => {
                        if (!this._open || this._speakPollId !== pollId) return;
                        const speaking = Array.isArray(result) ? Boolean(result[0]) : Boolean(result);
                        if ((!speaking && checks > 3) || checks > 140) {
                            this._speakPollId = 0;
                            GLib.source_remove(pollId);
                            this._face.setSpeaking(false);
                            this._face.setForm('listening');
                            this._statusLbl.set_text('Listening…');

                            this._autoCloseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                                this._autoCloseId = 0;
                                if (this._open && this._daemon) {
                                    this._startTurn = this._daemon?.state?.assistant?.turn || 0;
                                    this._daemon.call('assistant', 'Listen', JSON.stringify(
                                        this._settingsStore.buildAssistantContext()
                                    )).catch(() => {});
                                }
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    }).catch(() => {});
                    return GLib.SOURCE_CONTINUE;
                });
                this._speakPollId = pollId;
            }
        } else if (phase === 'error') {
            this._face.setSpeaking(false);
            if (state.heard_nothing) {
                this._statusLbl.set_text('Didn’t catch that');
                this._autoCloseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                    this._autoCloseId = 0;
                    this.close();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._face.setForm('confused');
                this._face.gesture('shake');
                this._statusLbl.set_text(state.error || 'Error occurred');
            }
        }
    }
});
