// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Compact resting island view for Isle XFCE.
//! Faithful port of upstream compact.js using authentic layouts, CSS classes, and Cairo drawings.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import * as Format from './format.js';
import * as Playback from './playback.js';
import { Bars, BotIcon, PrivacyDots, Ring, icon, label } from './widgets.js';

export const CompactView = GObject.registerClass({
    GTypeName: 'IsleGtkCompactView',
    Signals: {
        'width-changed': {},
    },
}, class CompactView extends Gtk.Box {
    _init(daemon = null) {
        super._init({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact'],
        });

        this._daemon = daemon;

        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-row'],
        });
        this.append(row);

        // 1. Left Slot: leading activity (Pomodoro Ring / Bot avatar)
        this._leftSlot = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-slot', 'isle-compact-start'],
        });
        this._botAvatar = new BotIcon(20, { shape: 'cloud', color: 'cloud', glow: 'match' });
        this._leftSlot.append(this._botAvatar);
        row.append(this._leftSlot);

        // 2. Center Slot: Date, Time (tabular numerals), and Meridiem
        this._centerBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-clock-box'],
        });

        const now = GLib.DateTime.new_now_local();
        const dateStr = now.format('%a') || 'Tue';
        this._dateLabel = label(dateStr, 'isle-compact-date', {
            valign: Gtk.Align.BASELINE,
        });
        this._centerBox.append(this._dateLabel);

        const clockParts = Format.clockParts();
        this._clockLabel = label(clockParts.time, 'isle-compact-clock', {
            valign: Gtk.Align.BASELINE,
        });
        this._centerBox.append(this._clockLabel);

        if (clockParts.meridiem) {
            this._meridiemLabel = label(clockParts.meridiem, 'isle-compact-meridiem', {
                valign: Gtk.Align.BASELINE,
            });
            this._centerBox.append(this._meridiemLabel);
        }

        row.append(this._centerBox);

        // 3. Right Slot: trailing activity (Audio equalizer bars + Privacy dot)
        this._rightSlot = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-slot', 'isle-compact-end', 'isle-compact-trail'],
        });

        this._audioBars = new Bars({ height: 14 });
        this._rightSlot.append(this._audioBars);

        this._privacyDots = new PrivacyDots();
        this._rightSlot.append(this._privacyDots);

        row.append(this._rightSlot);

        // Synchronize clock every second
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });

        if (this._daemon) {
            this._daemon.connect('changed', (_daemon, key) => {
                if (key === 'nowPlaying') {
                    const isPlaying = Playback.isPlaying(this._daemon.state.nowPlaying);
                    this._audioBars.set_opacity(isPlaying ? 1.0 : 0.43);
                }
            });
        }
    }

    _tick() {
        const parts = Format.clockParts();
        this._clockLabel.set_text(parts.time);
        if (this._meridiemLabel && parts.meridiem) {
            this._meridiemLabel.set_text(parts.meridiem);
        }
        const now = GLib.DateTime.new_now_local();
        const dateStr = now.format('%a') || '';
        this._dateLabel.set_text(dateStr);
    }

    destroy() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }
});
