// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Compact resting island view for Isle XFCE.
//! Faithful port of upstream compact.js using authentic layouts, CSS classes, and Cairo drawings.
//! Includes iOS-style dynamic peek alert banners for incoming notifications.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

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
        this._isPeeking = false;
        this._peekTimerId = 0;

        // Container Stack: Main resting view vs Notification Peek Banner
        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 180,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        this.append(this._stack);

        // ── 1. Main Resting Row ──────────────────────────────────────────
        const mainRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-row'],
        });

        // Left Slot: leading activity (Bot avatar)
        this._leftSlot = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-slot', 'isle-compact-start'],
        });
        this._botAvatar = new BotIcon(20, { shape: 'cloud', color: 'cloud', glow: 'match' });
        this._leftSlot.append(this._botAvatar);
        mainRow.append(this._leftSlot);

        // Center Slot: Date, Time, and Meridiem
        this._centerBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-clock-box'],
        });

        const now = GLib.DateTime.new_now_local();
        const dateStr = now.format('%a') || 'Thu';
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
        mainRow.append(this._centerBox);

        // Right Slot: trailing activity (Audio equalizer bars + Privacy dot)
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

        mainRow.append(this._rightSlot);
        this._stack.add_named(mainRow, 'main');

        // ── 2. Notification Peek Alert Row (Dynamic Island style) ────────
        this._peekRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-peek'],
        });

        this._peekIconBox = new Gtk.Box({
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.START,
            css_classes: ['isle-compact-peek-badge'],
        });
        this._peekIconImage = new Gtk.Image({ pixel_size: 20 });
        this._peekIconBox.append(this._peekIconImage);
        this._peekRow.append(this._peekIconBox);

        const peekTexts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            css_classes: ['isle-compact-peek-texts'],
        });

        this._peekTitle = label('', 'isle-compact-peek-title', {
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        this._peekTitle.set_ellipsize(Pango.EllipsizeMode.END);
        this._peekTitle.set_max_width_chars(20);
        peekTexts.append(this._peekTitle);

        this._peekSubtitle = label('', 'isle-compact-peek-subtitle', {
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        this._peekSubtitle.set_ellipsize(Pango.EllipsizeMode.END);
        this._peekSubtitle.set_max_width_chars(28);
        peekTexts.append(this._peekSubtitle);

        this._peekRow.append(peekTexts);

        this._peekTime = label('now', 'isle-compact-peek-time', {
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
        });
        this._peekRow.append(this._peekTime);

        this._stack.add_named(this._peekRow, 'peek');
        this._stack.set_visible_child_name('main');

        // Click Gesture: click on peek immediately opens notifications tab
        const click = new Gtk.GestureClick();
        click.connect('released', () => {
            if (this._isPeeking) {
                this._endPeek();
                const win = this.get_root();
                if (win) {
                    win.add_css_class('isle-force-expand');
                }
                if (globalThis.isleExpanded) {
                    globalThis.isleExpanded.showPage('notifications');
                }
            }
        });
        this.add_controller(click);

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

    showNotificationPeek(notification) {
        if (!notification) return;

        // Populate peek alert details
        const title = (notification.title || notification.appName || 'Notification').replace(/\s+/g, ' ').trim();
        const body = (notification.body || '').replace(/\s+/g, ' ').trim();

        this._peekTitle.set_text(title);
        this._peekSubtitle.set_text(body || 'New message');
        this._peekSubtitle.set_visible(Boolean(body));

        // Load icon
        const iconNameOrPath = notification.appIcon || '';
        if (iconNameOrPath && iconNameOrPath.startsWith('/') && GLib.file_test(iconNameOrPath, GLib.FileTest.EXISTS)) {
            this._peekIconImage.set_from_file(iconNameOrPath);
        } else if (iconNameOrPath) {
            this._peekIconImage.set_from_gicon(icon(iconNameOrPath));
        } else {
            this._peekIconImage.set_from_gicon(icon('isle-bell'));
        }

        this._isPeeking = true;
        this._stack.set_visible_child_name('peek');

        // Add window peek class for spring expansion to 380px
        const win = this.get_root();
        if (win && !win.has_css_class('isle-mode-peek')) {
            win.add_css_class('isle-mode-peek');
        }

        // Cancel previous timer if any
        if (this._peekTimerId) {
            GLib.source_remove(this._peekTimerId);
            this._peekTimerId = 0;
        }

        // Auto-contract back to 240px after 3.8s
        this._peekTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3800, () => {
            this._endPeek();
            return GLib.SOURCE_REMOVE;
        });
    }

    _endPeek() {
        if (this._peekTimerId) {
            GLib.source_remove(this._peekTimerId);
            this._peekTimerId = 0;
        }
        this._isPeeking = false;
        this._stack.set_visible_child_name('main');

        const win = this.get_root();
        if (win && win.has_css_class('isle-mode-peek')) {
            win.remove_css_class('isle-mode-peek');
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
        if (this._peekTimerId) {
            GLib.source_remove(this._peekTimerId);
            this._peekTimerId = 0;
        }
    }
});
