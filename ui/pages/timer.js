// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Timer, Stopwatch & Alarm page for Isle XFCE GTK4 runtime.
//! Expanded with multi-mode sub-navigation and system GNOME Clocks integration.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import * as Format from '../format.js';
import { Ring, icon, iconButton, label, pillButton } from '../widgets.js';
import { Page } from '../page.js';

const RING_SIZE = 92;

const PHASES = {
    idle: 'Focus',
    focus: 'Focus',
    short_break: 'Break',
    long_break: 'Long break',
};

const DEFAULT_STATE = {
    phase: 'idle',
    running: false,
    remaining_ms: 25 * 60000,
    duration_ms: 25 * 60000,
    today_sessions: 0,
};

const STEPPERS = [
    { key: 'focus_minutes', label: 'Work', min: 1, max: 180, defaultVal: 25 },
    { key: 'short_break_minutes', label: 'Break', min: 1, max: 60, defaultVal: 5 },
];

export function timerColor(phase) {
    switch (phase) {
    case 'short_break':
        return [0.25, 0.75, 0.45];
    case 'long_break':
        return [0.25, 0.55, 0.95];
    case 'focus':
    case 'idle':
    default:
        return [0.95, 0.45, 0.25];
    }
}

export const TimerPage = GObject.registerClass({
    GTypeName: 'IsleGtkTimerPage',
}, class TimerPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'focus',
            height,
        });

        this._mode = 'timer'; // 'timer' | 'stopwatch' | 'alarm'
        this._values = new Map();
        this._stepperRows = [];
        this._locked = false;

        // Stopwatch state
        this._swRunning = false;
        this._swElapsedMs = 0;
        this._swStartTime = 0;
        this._swTimerId = 0;
        this._swLaps = [];

        // Alarm state
        this._alarmHour = 7;
        this._alarmMin = 0;
        this._alarmActive = false;
        this._alarmTimerId = 0;

        globalThis.isleTimerPage = this;

        this._buildUi();

        this.watch(['pomodoro'], () => this._update());
        this.watch(['pomodoroConfig'], () => this._syncSteppers());

        this._update();
        this._syncSteppers();
    }

    getDesiredHeight() {
        return 245;
    }

    _buildUi() {
        const root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-timer-page-container'],
        });

        // 1. Top Sub-Navigation Bar
        root.append(this._buildSubNav());

        // 2. Mode Content Stack
        this._contentStack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 150,
            hexpand: true,
            vexpand: true,
        });

        this._contentStack.add_named(this._buildTimerView(), 'timer');
        this._contentStack.add_named(this._buildStopwatchView(), 'stopwatch');
        this._contentStack.add_named(this._buildAlarmView(), 'alarm');
        this._contentStack.set_visible_child_name('timer');

        root.append(this._contentStack);
        this.append(root);
    }

    _buildSubNav() {
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-timer-subnav'],
        });

        // Mode pills box
        const modesBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-timer-modes-box'],
        });

        this._modeButtons = {};
        const modes = [
            { id: 'timer', label: 'Timer' },
            { id: 'stopwatch', label: 'Stopwatch' },
            { id: 'alarm', label: 'Alarm' },
        ];

        for (const m of modes) {
            const btn = new Gtk.Button({
                label: m.label,
                css_classes: ['isle-timer-mode-btn', ...(m.id === 'timer' ? ['active'] : [])],
                valign: Gtk.Align.CENTER,
            });
            btn.connect('clicked', () => this._setMode(m.id));
            this._modeButtons[m.id] = btn;
            modesBox.append(btn);
        }
        bar.append(modesBox);

        // Spacer
        const spacer = new Gtk.Box({ hexpand: true });
        bar.append(spacer);

        // System Clocks app launcher
        const clockBtn = pillButton('System Clocks', 'isle-pill-small', () => {
            try {
                Gio.AppInfo.create_from_commandline('gnome-clocks', null, Gio.AppInfoCreateFlags.NONE).launch([], null);
            } catch (e) {
                console.warn(`Isle: could not open gnome-clocks: ${e.message}`);
            }
        });
        bar.append(clockBtn);

        return bar;
    }

    _setMode(mode) {
        if (mode === this._mode) return;
        this._mode = mode;
        for (const [id, btn] of Object.entries(this._modeButtons)) {
            if (id === mode) btn.add_css_class('active');
            else btn.remove_css_class('active');
        }
        this._contentStack.set_visible_child_name(mode);
        this.emit('height-changed');
    }

    // ── Mode 1: Timer (Pomodoro / Focus) ───────────────────────────
    _buildTimerView() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 20,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-timer-layout'],
        });

        const inside = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });

        this._time = label('25:00', 'isle-timer-time', { halign: Gtk.Align.CENTER });
        this._phase = label('Focus', 'isle-timer-phase', { halign: Gtk.Align.CENTER });
        inside.append(this._time);
        inside.append(this._phase);

        this._ring = new Ring({
            size: RING_SIZE,
            lineWidth: 5,
            trackOpacity: 0.14,
            child: inside,
        });
        row.append(this._ring);

        const spacer1 = new Gtk.Box({ hexpand: true });
        row.append(spacer1);

        // Steppers
        const steppersBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-steppers'],
        });

        for (const s of STEPPERS) {
            steppersBox.append(this._buildStepper(s));
        }
        row.append(steppersBox);

        const spacer2 = new Gtk.Box({ hexpand: true });
        row.append(spacer2);

        // Controls
        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
            css_classes: ['isle-timer-controls'],
        });

        this._reset = iconButton('isle-reset', 'isle-button-round', () => {
            this.daemon.call('pomodoro', 'Stop');
        }, { size: 14, accessibleName: 'Reset the timer' });
        controls.append(this._reset);

        const pillBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-start-pill-box'],
        });
        this._playIcon = new Gtk.Image({
            gicon: icon('isle-play-symbolic'),
            pixel_size: 13,
            valign: Gtk.Align.CENTER,
        });
        this._playLabel = label('Start', 'isle-start-pill-label');
        pillBox.append(this._playIcon);
        pillBox.append(this._playLabel);

        this._play = new Gtk.Button({
            child: pillBox,
            css_classes: ['isle-button', 'isle-start-pill'],
            valign: Gtk.Align.CENTER,
            can_focus: true,
        });
        this._play.connect('clicked', () => this._toggle());
        controls.append(this._play);

        row.append(controls);
        return row;
    }

    _buildStepper({ key, label: name, min, max, defaultVal }) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-stepper'],
        });
        this._stepperRows.push(row);

        const nameLbl = label(name, 'isle-stepper-name');
        nameLbl.set_xalign(0);
        row.append(nameLbl);

        const valLbl = label(String(defaultVal), 'isle-stepper-value');
        this._values.set(key, valLbl);
        row.append(valLbl);

        const minusBtn = iconButton('isle-minus-symbolic', 'isle-button-flat isle-stepper-button', () => {
            this._step(key, -1, min, max);
        }, { size: 12, accessibleName: `Shorter ${name.toLowerCase()}` });

        const plusBtn = iconButton('isle-plus-symbolic', 'isle-button-flat isle-stepper-button', () => {
            this._step(key, 1, min, max);
        }, { size: 12, accessibleName: `Longer ${name.toLowerCase()}` });

        row.append(minusBtn);
        row.append(plusBtn);

        return row;
    }

    _step(key, step, min, max) {
        if (this._locked) return;
        const config = this._asked ?? this.daemon?.state?.pomodoroConfig;
        const current = (config && config[key] !== undefined) ? config[key] : (key === 'focus_minutes' ? 25 : 5);
        const next = Math.min(max, Math.max(min, current + step));
        this._setMinutes(key, next);
    }

    _setMinutes(key, minutes) {
        const config = this._asked ?? this.daemon?.state?.pomodoroConfig ?? {};
        const valLbl = this._values.get(key);
        if (valLbl) valLbl.set_text(String(minutes));
        if (minutes === config[key]) return;
        this._asked = { ...config, [key]: minutes };
        this.daemon.call('pomodoro', 'SetConfig', JSON.stringify(this._asked));
    }

    _syncSteppers() {
        const config = this.daemon?.state?.pomodoroConfig;
        if (this._asked && (!config || STEPPERS.every(({ key }) => config[key] === this._asked[key])))
            this._asked = null;

        for (const { key, defaultVal } of STEPPERS) {
            const valLbl = this._values.get(key);
            if (!valLbl) continue;
            const shown = this._asked ?? config;
            const val = shown?.[key] !== undefined ? String(shown[key]) : String(defaultVal);
            valLbl.set_text(val);
        }
    }

    _toggle() {
        const state = this.daemon?.state?.pomodoro;
        this.daemon.call('pomodoro', state?.running ? 'Pause' : 'Start');
    }

    _remaining(state) {
        if (!state.running || !state.ends_at_ms)
            return state.remaining_ms;
        return Math.max(0, state.ends_at_ms - Format.nowMs());
    }

    _update() {
        const state = this.daemon?.state?.pomodoro ?? DEFAULT_STATE;
        const idle = state.phase === 'idle';
        const remaining = this._remaining(state);

        if (this._lastRunning && !state.running && remaining === 0) {
            this._fireTimerDone();
        }
        this._lastRunning = Boolean(state.running);

        this._ring.color = timerColor(state.phase);
        this._ring.progress = idle ? 0 : 1 - (remaining / (state.duration_ms || 1));
        this._time.set_text(Format.duration(remaining));
        this._phase.set_text(PHASES[state.phase] ?? 'Focus');

        if (this._playIcon) {
            this._playIcon.set_from_gicon(icon(state.running ? 'isle-pause-symbolic' : 'isle-play-symbolic'));
        }
        if (this._playLabel) {
            this._playLabel.set_text(state.running ? 'Pause' : idle ? 'Start' : 'Resume');
        }

        this._reset.set_visible(!idle);
        this._syncLock(!idle);

        if (state.running) {
            this.later('tick', 250, () => this._update(), { keep: true });
        } else {
            this.cancel('tick');
        }
    }

    _fireTimerDone() {
        if (globalThis.isleSoundEnabled !== false) {
            try {
                GLib.spawn_command_line_async('canberra-gtk-play -i complete');
            } catch (_) {}
        }

        if (globalThis.isleShowAlert) {
            globalThis.isleShowAlert({
                type: 'timer',
                timeStr: '00:00',
                labelText: "Timer Done!",
                onDismiss: () => {
                    this.daemon?.call('pomodoro', 'Stop');
                },
                onSnooze: () => {
                    this._setMinutes('focus_minutes', 5);
                    this.daemon?.call('pomodoro', 'Start');
                },
            });
        }
    }

    _syncLock(locked) {
        if (locked === this._locked) return;
        this._locked = locked;
        for (const row of this._stepperRows) {
            if (locked) row.add_css_class('isle-stepper-locked');
            else row.remove_css_class('isle-stepper-locked');
        }
    }

    // ── Mode 2: Stopwatch ──────────────────────────────────────────
    _buildStopwatchView() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 20,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-stopwatch-layout'],
        });

        // Left: Time Display & Lap indicator
        const timeBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.START,
        });

        const displayRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            valign: Gtk.Align.BASELINE,
        });

        this._swMinSec = label('00:00', 'isle-stopwatch-display');
        this._swMs = label('.00', 'isle-stopwatch-ms');
        displayRow.append(this._swMinSec);
        displayRow.append(this._swMs);
        timeBox.append(displayRow);

        this._swLapHint = label('Ready', 'isle-timer-phase');
        timeBox.append(this._swLapHint);
        row.append(timeBox);

        // Middle: Scrollable Laps list
        const lapScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-lap-scroll'],
        });
        lapScroll.set_size_request(160, 80);

        this._swLapBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
        });
        lapScroll.set_child(this._swLapBox);
        row.append(lapScroll);

        // Right: Controls (Reset, Lap, Start/Pause)
        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
        });

        this._swResetBtn = iconButton('isle-reset', 'isle-button-round', () => {
            this._resetStopwatch();
        }, { size: 14, accessibleName: 'Reset stopwatch' });
        this._swResetBtn.set_visible(false);
        controls.append(this._swResetBtn);

        this._swLapBtn = pillButton('Lap', 'isle-pill-small', () => {
            this._addLap();
        });
        this._swLapBtn.set_visible(false);
        controls.append(this._swLapBtn);

        this._swStartBtn = pillButton('Start', 'isle-pill-accent isle-pill-small', () => {
            this._toggleStopwatch();
        });
        controls.append(this._swStartBtn);

        row.append(controls);
        return row;
    }

    _toggleStopwatch() {
        if (!this._swRunning) {
            this._swRunning = true;
            this._swStartTime = Date.now() - this._swElapsedMs;
            this._swStartBtn.set_label('Pause');
            this._swStartBtn.remove_css_class('isle-pill-accent');
            this._swStartBtn.add_css_class('isle-pill-small');
            this._swResetBtn.set_visible(true);
            this._swLapBtn.set_visible(true);
            this._swLapHint.set_text('Running');

            this._swTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                this._swElapsedMs = Date.now() - this._swStartTime;
                this._renderStopwatch();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._swRunning = false;
            if (this._swTimerId) {
                GLib.Source.remove(this._swTimerId);
                this._swTimerId = 0;
            }
            this._swStartBtn.set_label('Resume');
            this._swStartBtn.add_css_class('isle-pill-accent');
            this._swLapHint.set_text('Paused');
        }
    }

    _resetStopwatch() {
        this._swRunning = false;
        if (this._swTimerId) {
            GLib.Source.remove(this._swTimerId);
            this._swTimerId = 0;
        }
        this._swElapsedMs = 0;
        this._swLaps = [];
        this._swStartBtn.set_label('Start');
        this._swStartBtn.add_css_class('isle-pill-accent');
        this._swResetBtn.set_visible(false);
        this._swLapBtn.set_visible(false);
        this._swLapHint.set_text('Ready');
        this._renderStopwatch();

        // Clear lap items
        let child = this._swLapBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._swLapBox.remove(child);
            child = next;
        }
    }

    _addLap() {
        if (!this._swRunning) return;
        const total = this._swElapsedMs;
        const prevTotal = this._swLaps.length > 0 ? this._swLaps[0].total : 0;
        const split = total - prevTotal;
        const lapNum = this._swLaps.length + 1;

        const lapData = { num: lapNum, split, total };
        this._swLaps.unshift(lapData);

        const lapRow = label(
            `Lap ${lapNum}: ${this._formatMs(split)} (${this._formatMs(total)})`,
            'isle-lap-row'
        );
        this._swLapBox.prepend(lapRow);
        this._swLapHint.set_text(`Lap ${lapNum}: ${this._formatMs(split)}`);
    }

    _formatMs(ms) {
        const totalSec = Math.floor(ms / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        const hundredths = Math.floor((ms % 1000) / 10);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(mins)}:${pad(secs)}.${pad(hundredths)}`;
    }

    _renderStopwatch() {
        const totalSec = Math.floor(this._swElapsedMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        const hundredths = Math.floor((this._swElapsedMs % 1000) / 10);
        const pad = n => String(n).padStart(2, '0');

        this._swMinSec.set_text(`${pad(mins)}:${pad(secs)}`);
        this._swMs.set_text(`.${pad(hundredths)}`);
    }

    // ── Mode 3: Alarm ──────────────────────────────────────────────
    _buildAlarmView() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 20,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-alarm-layout'],
        });

        // Left: Time Display + Remaining Hint
        const timeBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.START,
        });

        this._alarmTimeLbl = label('07:00', 'isle-alarm-time-display');
        this._alarmHintLbl = label('Alarm is Off', 'isle-alarm-hint');
        timeBox.append(this._alarmTimeLbl);
        timeBox.append(this._alarmHintLbl);
        row.append(timeBox);

        // Middle: Hour & Min Steppers + Presets
        const middleBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        const steppersRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        // Hour Stepper
        const hourBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            css_classes: ['isle-stepper'],
        });
        hourBox.append(label('Hr', 'isle-stepper-name'));
        this._alarmHourVal = label(String(this._alarmHour).padStart(2, '0'), 'isle-stepper-value');
        hourBox.append(this._alarmHourVal);
        hourBox.append(iconButton('isle-minus-symbolic', 'isle-button-flat isle-stepper-button', () => {
            this._stepAlarmHour(-1);
        }, { size: 11 }));
        hourBox.append(iconButton('isle-plus-symbolic', 'isle-button-flat isle-stepper-button', () => {
            this._stepAlarmHour(1);
        }, { size: 11 }));
        steppersRow.append(hourBox);

        // Min Stepper
        const minBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            css_classes: ['isle-stepper'],
        });
        minBox.append(label('Min', 'isle-stepper-name'));
        this._alarmMinVal = label(String(this._alarmMin).padStart(2, '0'), 'isle-stepper-value');
        minBox.append(this._alarmMinVal);
        minBox.append(iconButton('isle-minus-symbolic', 'isle-button-flat isle-stepper-button', () => {
            this._stepAlarmMin(-5);
        }, { size: 11 }));
        minBox.append(iconButton('isle-plus-symbolic', 'isle-button-flat isle-stepper-button', () => {
            this._stepAlarmMin(5);
        }, { size: 11 }));
        steppersRow.append(minBox);

        middleBox.append(steppersRow);

        // Presets row (+15m, +30m, +1h)
        const presetRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        const presets = [
            { text: '+15m', mins: 15 },
            { text: '+30m', mins: 30 },
            { text: '+1h', mins: 60 },
        ];
        for (const p of presets) {
            presetRow.append(pillButton(p.text, 'isle-pill-small isle-alarm-preset', () => {
                this._addAlarmOffset(p.mins);
            }));
        }
        middleBox.append(presetRow);
        row.append(middleBox);

        // Right: Toggle Alarm Button
        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
        });

        this._alarmToggleBtn = pillButton('Set Alarm', 'isle-pill-small', () => {
            this._toggleAlarm();
        });
        controls.append(this._alarmToggleBtn);

        row.append(controls);
        return row;
    }

    _stepAlarmHour(delta) {
        this._alarmHour = (this._alarmHour + delta + 24) % 24;
        this._alarmHourVal.set_text(String(this._alarmHour).padStart(2, '0'));
        this._renderAlarmTime();
    }

    _stepAlarmMin(delta) {
        this._alarmMin = (this._alarmMin + delta + 60) % 60;
        this._alarmMinVal.set_text(String(this._alarmMin).padStart(2, '0'));
        this._renderAlarmTime();
    }

    _addAlarmOffset(mins) {
        const now = new Date(Date.now() + mins * 60000);
        this._alarmHour = now.getHours();
        this._alarmMin = now.getMinutes();
        this._alarmHourVal.set_text(String(this._alarmHour).padStart(2, '0'));
        this._alarmMinVal.set_text(String(this._alarmMin).padStart(2, '0'));
        this._renderAlarmTime();
        if (!this._alarmActive) {
            this._toggleAlarm();
        }
    }

    _renderAlarmTime() {
        const pad = n => String(n).padStart(2, '0');
        this._alarmTimeLbl.set_text(`${pad(this._alarmHour)}:${pad(this._alarmMin)}`);
        if (this._alarmActive) {
            this._updateAlarmCountdown();
        }
    }

    _toggleAlarm() {
        this._alarmActive = !this._alarmActive;
        if (this._alarmActive) {
            this._alarmToggleBtn.set_label('Alarm On');
            this._alarmToggleBtn.add_css_class('isle-pill-accent');
            this._updateAlarmCountdown();
            this._alarmTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                if (!this._alarmActive) return GLib.SOURCE_REMOVE;
                this._updateAlarmCountdown();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._alarmToggleBtn.set_label('Set Alarm');
            this._alarmToggleBtn.remove_css_class('isle-pill-accent');
            this._alarmHintLbl.set_text('Alarm is Off');
            if (this._alarmTimerId) {
                GLib.Source.remove(this._alarmTimerId);
                this._alarmTimerId = 0;
            }
        }
    }

    _updateAlarmCountdown() {
        const now = new Date();
        const target = new Date();
        target.setHours(this._alarmHour, this._alarmMin, 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }

        const diffMs = target.getTime() - now.getTime();
        const diffHrs = Math.floor(diffMs / (3600 * 1000));
        const diffMins = Math.floor((diffMs % (3600 * 1000)) / 60000);

        if (diffMs <= 15000) {
            this._fireAlarm();
            return;
        }

        this._alarmHintLbl.set_text(`Rings in ${diffHrs}h ${diffMins}m`);
    }

    _fireAlarm() {
        this._alarmActive = false;
        if (this._alarmTimerId) {
            GLib.Source.remove(this._alarmTimerId);
            this._alarmTimerId = 0;
        }
        this._alarmToggleBtn.set_label('Set Alarm');
        this._alarmToggleBtn.remove_css_class('isle-pill-accent');
        this._alarmHintLbl.set_text("Time's Up!");

        // 1. Play alert sound
        if (globalThis.isleSoundEnabled !== false) {
            try {
                GLib.spawn_command_line_async('canberra-gtk-play -i alarm-clock-elapsed');
            } catch (_) {}
        }

        // 2. Dispatch Dynamic Island alert
        const pad = n => String(n).padStart(2, '0');
        const timeStr = `${pad(this._alarmHour)}:${pad(this._alarmMin)}`;

        if (globalThis.isleShowAlert) {
            globalThis.isleShowAlert({
                type: 'alarm',
                timeStr,
                labelText: this._alarmLabel || 'Alarm Ringing!',
                onDismiss: () => {
                    this._alarmHintLbl.set_text('Alarm is Off');
                },
                onSnooze: () => {
                    this._addAlarmOffset(5);
                },
            });
        }
    }

    startTimer(minutes = 25, label = 'Timer') {
        const mins = Math.max(1, Math.min(180, Math.round(Number(minutes) || 25)));
        this._setMode('timer');
        this._setMinutes('focus_minutes', mins);
        this.daemon.call('pomodoro', 'Start');
        return { ok: true, detail: `${mins} minute timer started` };
    }

    setAlarm(timeStr = '07:00', label = 'Alarm') {
        let hour = 7;
        let min = 0;
        if (typeof timeStr === 'string') {
            const m = timeStr.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
            if (m) {
                hour = parseInt(m[1], 10);
                min = m[2] ? parseInt(m[2], 10) : 0;
                const ampm = m[3]?.toLowerCase();
                if (ampm === 'pm' && hour < 12) hour += 12;
                if (ampm === 'am' && hour === 12) hour = 0;
            }
        }
        hour = Math.max(0, Math.min(23, hour));
        min = Math.max(0, Math.min(59, min));

        this._alarmHour = hour;
        this._alarmMin = min;
        this._alarmLabel = label || 'Alarm';
        if (this._alarmHourVal) this._alarmHourVal.set_text(String(hour).padStart(2, '0'));
        if (this._alarmMinVal) this._alarmMinVal.set_text(String(min).padStart(2, '0'));
        this._renderAlarmTime();

        if (!this._alarmActive) {
            this._toggleAlarm();
        }

        // Sync with GNOME Clocks
        this._syncGnomeClocksAlarm(this._alarmLabel, hour, min);

        const pad = n => String(n).padStart(2, '0');
        return { ok: true, detail: `alarm set for ${pad(hour)}:${pad(min)}` };
    }

    _syncGnomeClocksAlarm(name, hour, min) {
        try {
            const settings = new Gio.Settings({ schema_id: 'org.gnome.clocks' });
            const existing = settings.get_value('alarms').deep_unpack();
            const id = GLib.uuid_string_random ? GLib.uuid_string_random().replace(/-/g, '') : Math.random().toString(36).slice(2);

            const now = new Date();
            const target = new Date();
            target.setHours(hour, min, 0, 0);
            if (target.getTime() <= now.getTime()) {
                target.setDate(target.getDate() + 1);
            }
            const pad = n => String(n).padStart(2, '0');
            const ringTime = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(hour)}:${pad(min)}:00`;

            const newEntry = {
                name: new GLib.Variant('s', name || 'Alarm'),
                id: new GLib.Variant('s', id),
                hour: new GLib.Variant('i', hour),
                minute: new GLib.Variant('i', min),
                ring_time: new GLib.Variant('s', ringTime),
                days: new GLib.Variant('ai', []),
                snooze_minutes: new GLib.Variant('i', 5),
                ring_minutes: new GLib.Variant('i', 5),
                sound_uri: new GLib.Variant('s', 'file:///usr/share/sounds/gnome/default/alarms/school-bell.oga'),
            };

            const combined = [...existing, newEntry];
            settings.set_value('alarms', new GLib.Variant('aa{sv}', combined));
            settings.apply();
        } catch (e) {
            console.warn(`Isle: could not sync alarm to gnome-clocks: ${e.message}`);
        }
    }
});
