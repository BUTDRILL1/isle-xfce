// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Focus Timer page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/timer.js.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import * as Format from '../format.js';
import { Ring, icon, iconButton, label, pillButton } from '../widgets.js';
import { Page } from '../page.js';

const RING_SIZE = 104;

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

        this._values = new Map();
        this._stepperRows = [];
        this._locked = false;

        this._buildUi();

        this.watch(['pomodoro'], () => this._update());
        this.watch(['pomodoroConfig'], () => this._syncSteppers());

        this._update();
        this._syncSteppers();
    }

    _buildUi() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 24,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-timer-layout'],
        });

        // 1. Ring with inside time and phase labels
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

        // Flexible spacer
        const spacer1 = new Gtk.Box({ hexpand: true });
        row.append(spacer1);

        // 2. Steppers
        const steppersBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-steppers'],
        });

        for (const s of STEPPERS) {
            steppersBox.append(this._buildStepper(s));
        }
        row.append(steppersBox);

        // Flexible spacer
        const spacer2 = new Gtk.Box({ hexpand: true });
        row.append(spacer2);

        // 3. Controls (Reset & Start/Pause pill)
        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
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
        this.append(row);
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

        this._ring.color = timerColor(state.phase);
        this._ring.progress = idle ? 0 : 1 - (remaining / (state.duration_ms || 1));
        this._time.set_text(Format.duration(remaining));
        this._phase.set_text(PHASES[state.phase] ?? 'Focus');

        // Play/Pause button updates
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

    _syncLock(locked) {
        if (locked === this._locked) return;
        this._locked = locked;
        for (const row of this._stepperRows) {
            if (locked) row.add_css_class('isle-stepper-locked');
            else row.remove_css_class('isle-stepper-locked');
        }
    }
});
