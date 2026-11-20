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
import { paletteFor, SHAPES } from './bot.js';
import { getSettingsStore } from './settingsStore.js';
import {
    getBatteryTelemetry,
    getCachedVolume,
    getPowerProfile,
    getTelemetryMonitor,
    getWifiSignal,
    isAcPluggedIn,
} from './telemetry.js';
import { BotIcon, PrivacyDots, Ring, WifiIndicator, icon, label, pillButton } from './widgets.js';

const POWER_COLORS = {
    'power-saver': '#ffd60a',
    'balanced': '#30d158',
    'performance': '#ff453a',
    'lightning': '#bf5af2',
};

export const CompactView = GObject.registerClass({
    GTypeName: 'IsleGtkCompactView',
    Signals: {
        'width-changed': {},
    },
}, class CompactView extends Gtk.Box {
    _init(daemon = null) {
        super._init({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact'],
        });

        this._daemon = daemon;
        this._isPeeking = false;
        this._peekTimerId = 0;
        this._settingsStore = getSettingsStore();

        // Container Stack: Main resting view vs Notification Peek Banner
        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 180,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            hhomogeneous: false,
            vhomogeneous: false,
        });
        this.append(this._stack);

        // ── 1. Main Resting Row ──────────────────────────────────────────
        const mainRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-row'],
        });

        // Left Slot: stacked battery digits + Bot avatar
        this._leftSlot = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-slot', 'isle-compact-start'],
        });
        this._batStack = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-vstat'],
        });
        this._batTop = label('', 'isle-compact-vdigit', { halign: Gtk.Align.CENTER });
        this._batBot = label('', 'isle-compact-vdigit', { halign: Gtk.Align.CENTER });
        this._batStack.append(this._batTop);
        this._batStack.append(this._batBot);
        this._leftSlot.append(this._batStack);

        this._botAvatar = new BotIcon(24, { shape: 'cloud', color: 'cloud', glow: 'match' });
        this._leftSlot.append(this._botAvatar);
        mainRow.append(this._leftSlot);

        this._syncBotPowerColor();
        this._telemetryMonitor = getTelemetryMonitor();
        this._telemetryMonitor.connect('power-changed', () => this._syncBotPowerColor());
        this._telemetryMonitor.connect('updated', () => this._syncCompactStats());
        this._telemetryMonitor.connect('volume-changed', () => this._syncVolumeLabel());
        this._chargeLimitUnsub = globalThis.isleOnChargeLimitChanged
            ? globalThis.isleOnChargeLimitChanged(() => this._syncBatteryCapColor())
            : null;
        this._syncBatteryCapColor();
        this.connect('destroy', () => {
            if (this._chargeLimitUnsub) {
                this._chargeLimitUnsub();
                this._chargeLimitUnsub = null;
            }
        });

        // Center Slot: Date, Time, and Meridiem
        this._centerBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 3,
            hexpand: true,
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

        // Right Slot: dynamic Wi-Fi + vertical live Sound + Privacy dot
        this._rightSlot = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 7,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-slot', 'isle-compact-end', 'isle-compact-trail'],
        });

        this._wifiIndicator = new WifiIndicator({ width: 18, height: 15 });
        this._rightSlot.append(this._wifiIndicator);

        this._volStack = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-compact-vstat'],
        });
        this._volTop = label('', 'isle-compact-vdigit', { halign: Gtk.Align.CENTER });
        this._volBot = label('', 'isle-compact-vdigit', { halign: Gtk.Align.CENTER });
        this._volStack.append(this._volTop);
        this._volStack.append(this._volBot);
        this._rightSlot.append(this._volStack);

        this._privacyDots = new PrivacyDots();
        this._rightSlot.append(this._privacyDots);

        this._syncCompactStats();
        this._syncVolumeLabel();
        this._applyCompactConfig();

        this._settingsUnsub = this._settingsStore.subscribe(
            ['compact', 'bot', 'appearance', 'behavior', 'chargeLimit'],
            (_state, topics) => {
                if (topics.includes('*') || topics.includes('compact')) this._applyCompactConfig();
                if (topics.includes('*') || topics.includes('bot')) this._syncBotPowerColor();
                if (topics.includes('*') || topics.includes('chargeLimit') || topics.includes('appearance')) {
                    this._syncBatteryCapColor();
                }
            }
        );
        this.connect('destroy', () => {
            if (this._settingsUnsub) {
                this._settingsUnsub();
                this._settingsUnsub = null;
            }
        });

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

        // ── 3. Alarm / Timer Ringing Alert View (Double-height Dynamic Island) ────────
        this._alarmBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            hexpand: true,
            css_classes: ['isle-compact-alarm-alert'],
        });

        // Top Row: Icon + Title + Pulse indicator
        const alarmTopRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
        });

        this._alarmAlertIcon = new Gtk.Image({
            gicon: icon('isle-timer'),
            pixel_size: 16,
        });
        alarmTopRow.append(this._alarmAlertIcon);

        this._alarmAlertTitle = label('Timer Done', 'isle-compact-peek-title', {
            hexpand: true,
            halign: Gtk.Align.START,
        });
        alarmTopRow.append(this._alarmAlertTitle);

        const pulseDot = new Gtk.Box({
            css_classes: ['isle-unseen-dot'],
            valign: Gtk.Align.CENTER,
        });
        alarmTopRow.append(pulseDot);
        this._alarmBox.append(alarmTopRow);

        // Bottom Row: [Dismiss] (left) | Time (center) | [Snooze] (right)
        const alarmBottomRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
        });

        this._alarmDismissBtn = pillButton('Dismiss', 'isle-pill-small', () => {
            print('[Isle Alarm] Dismiss button clicked');
            this._endAlarmAlert();
            if (this._onAlarmDismiss) this._onAlarmDismiss();
        });
        this._alarmDismissBtn.set_hexpand(false);
        alarmBottomRow.append(this._alarmDismissBtn);

        this._alarmAlertTime = label('00:00', 'isle-compact-alarm-time', {
            hexpand: true,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });
        alarmBottomRow.append(this._alarmAlertTime);

        this._alarmSnoozeBtn = pillButton('Snooze', 'isle-pill-accent isle-pill-small', () => {
            print('[Isle Alarm] Snooze button clicked');
            this._endAlarmAlert();
            if (this._onAlarmSnooze) this._onAlarmSnooze();
        });
        this._alarmSnoozeBtn.set_hexpand(false);
        alarmBottomRow.append(this._alarmSnoozeBtn);

        this._alarmBox.append(alarmBottomRow);
        this._stack.add_named(this._alarmBox, 'alarm');

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
                if (key === 'system') {
                    this._syncCompactStats();
                }
            });
        }
    }

    showNotificationPeek(notification) {
        if (!notification) return;
        const beh = this._settingsStore.get().behavior;
        if (!beh.peekEnabled) return;

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

        // Auto-contract back to 240px after configured duration
        const peekDuration = this._settingsStore.get().behavior.peekDurationMs || 3800;
        this._peekTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, peekDuration, () => {
            this._endPeek();
            return GLib.SOURCE_REMOVE;
        });
    }

    showAlarmAlert({ type = 'timer', timeStr = '00:00', labelText = "Time's Up!", onDismiss = null, onSnooze = null }) {
        this._onAlarmDismiss = onDismiss;
        this._onAlarmSnooze = onSnooze;

        this._alarmAlertTitle.set_text(labelText);
        this._alarmAlertTime.set_text(timeStr);
        this._alarmAlertIcon.set_from_gicon(icon(type === 'alarm' ? 'isle-bell' : 'isle-timer'));

        this._isAlarmAlert = true;
        this._stack.set_visible_child_name('alarm');

        const win = this.get_root();
        if (win) {
            win.remove_css_class('isle-mode-peek');
            if (!win.has_css_class('isle-mode-alarm-alert')) {
                win.add_css_class('isle-mode-alarm-alert');
            }
        }
    }

    _endAlarmAlert() {
        this._isAlarmAlert = false;
        this._stack.set_visible_child_name('main');
        const win = this.get_root();
        if (win && win.has_css_class('isle-mode-alarm-alert')) {
            win.remove_css_class('isle-mode-alarm-alert');
        }
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

    _setVerticalDigits(stack, topLbl, botLbl, value) {
        if (value >= 100) {
            const s = String(Math.round(value));
            topLbl.set_text(s.slice(0, 2));
            botLbl.set_text(s.slice(2));
        } else {
            const s = String(Math.max(0, Math.round(value))).padStart(2, '0');
            topLbl.set_text(s[0]);
            botLbl.set_text(s[1]);
        }
    }

    _syncBatteryCapColor(bat = null) {
        if (!this._batStack) return;
        const cap = globalThis.isleGetChargeLimit
            ? globalThis.isleGetChargeLimit()
            : { enabled: false };
        const battery = bat ?? getBatteryTelemetry(this._daemon?.state?.system?.battery);
        if (cap.enabled && Boolean(battery?.isPlugged || isAcPluggedIn())) {
            this._batStack.add_css_class('capped');
        } else {
            this._batStack.remove_css_class('capped');
        }
    }

    _syncCompactStats() {
        if (this._batStack && this._batTop && this._batBot) {
            const bat = getBatteryTelemetry(this._daemon?.state?.system?.battery);
            if (bat) {
                this._setVerticalDigits(this._batStack, this._batTop, this._batBot, bat.percent);
                if (bat.isCharging) this._batStack.add_css_class('charging');
                else this._batStack.remove_css_class('charging');
            }
            this._syncBatteryCapColor(bat);
        }
        if (this._wifiIndicator) {
            this._wifiIndicator.update(getWifiSignal());
        }
    }

    _syncVolumeLabel() {
        if (!this._volStack || !this._volTop || !this._volBot) return;
        const vol = getCachedVolume();
        if (vol.muted) {
            this._volTop.set_text('M');
            this._volBot.set_text('-');
            this._volStack.add_css_class('muted');
            this._volStack.remove_css_class('boost');
        } else {
            this._setVerticalDigits(this._volStack, this._volTop, this._volBot, vol.percent);
            this._volStack.remove_css_class('muted');
            if (vol.percent > 100) this._volStack.add_css_class('boost');
            else this._volStack.remove_css_class('boost');
        }
    }

    _applyCompactConfig() {
        const c = this._settingsStore.get().compact;
        this._batStack?.set_visible(Boolean(c.showBattery));
        this._botAvatar?.set_visible(Boolean(c.showBot));
        this._dateLabel?.set_visible(Boolean(c.showDate));
        this._wifiIndicator?.set_visible(Boolean(c.showWifi));
        this._volStack?.set_visible(Boolean(c.showVolume));
        this._privacyDots?.set_visible(Boolean(c.showPrivacyDots));
    }

    _syncBotPowerColor() {
        if (!this._botAvatar) return;
        const botCfg = this._settingsStore.get().bot;
        const shape = SHAPES[botCfg.shape] ? botCfg.shape : 'cloud';
        const palette = botCfg.colorMode === 'fixed'
            ? paletteFor(botCfg.color, botCfg.glow)
            : paletteFor(POWER_COLORS[getPowerProfile()] || '#30d158', botCfg.glow);
        this._botAvatar.look = { shape, palette };
    }

    _tickClock() {
        this._tick();
    }

    _tick() {
        const parts = Format.clockParts();
        this._clockLabel.set_text(parts.time);
        if (this._meridiemLabel && parts.meridiem) {
            this._meridiemLabel.set_text(parts.meridiem);
            this._meridiemLabel.set_visible(true);
        } else if (this._meridiemLabel) {
            this._meridiemLabel.set_visible(false);
        } else if (parts.meridiem) {
            this._meridiemLabel = label(parts.meridiem, 'isle-compact-meridiem', {
                valign: Gtk.Align.BASELINE,
            });
            this._centerBox.append(this._meridiemLabel);
        }
        const now = GLib.DateTime.new_now_local();
        const dateStr = now.format('%a') || '';
        this._dateLabel.set_text(dateStr);
    }

    destroy() {
        if (this._settingsUnsub) {
            this._settingsUnsub();
            this._settingsUnsub = null;
        }
        if (this._chargeLimitUnsub) {
            this._chargeLimitUnsub();
            this._chargeLimitUnsub = null;
        }
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
