// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Isle Settings page for Isle XFCE expanded view.
//! Configures glass opacity, clock format, timer/alarm sound, and system settings shortcut.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { Page } from '../page.js';
import { icon, label, pillButton } from '../widgets.js';
import * as Format from '../format.js';

export const SettingsPage = GObject.registerClass({
    GTypeName: 'IsleGtkSettingsPage',
}, class SettingsPage extends Page {
    _init(daemon, { height = 240 } = {}) {
        super._init(daemon, {
            name: 'settings',
            height,
        });

        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-settings-scrolled'],
        });

        const rootBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 2,
            margin_bottom: 4,
            margin_start: 16,
            margin_end: 16,
            hexpand: true,
        });

        // 1. Header Row
        const headerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        const titleBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        const headerIcon = new Gtk.Image({
            gicon: icon('isle-settings'),
            pixel_size: 15,
        });
        const titleLbl = label('Isle Settings', 'isle-title');
        titleBox.append(headerIcon);
        titleBox.append(titleLbl);
        headerRow.append(titleBox);

        const closeBtn = pillButton('Done', 'isle-pill-small', () => {
            this.emit('request-close');
        });
        closeBtn.set_size_request(54, 24);
        headerRow.append(closeBtn);
        rootBox.append(headerRow);

        // 2. Glass Opacity: Presets (10%, 15%, 25%, 50%) + Slider
        rootBox.append(this._buildGlassOpacitySection());

        // 3. Clock Format: 12-hour vs 24-hour
        rootBox.append(this._buildClockFormatSection());

        // 4. Sound Toggle for Timer/Alarm
        rootBox.append(this._buildSoundSection());

        // 5. System Settings launcher (xfce4-settings-manager)
        rootBox.append(this._buildSystemSettingsSection());

        scrolled.set_child(rootBox);
        this.append(scrolled);
    }

    _buildGlassOpacitySection() {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            css_classes: ['isle-settings-card'],
        });

        const topRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        const labelBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
        });
        const title = label('Glass Opacity', 'isle-title');
        const subtitle = label('Frosted glass background transparency', 'isle-subtitle');
        labelBox.append(title);
        labelBox.append(subtitle);
        topRow.append(labelBox);

        const presetsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 5,
            valign: Gtk.Align.CENTER,
        });

        const presets = [10, 15, 25, 50];
        const buttons = [];
        const currentVal = globalThis.isleGetGlassOpacity ? globalThis.isleGetGlassOpacity() : 15;

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 50,
                step_increment: 1,
                page_increment: 5,
                value: currentVal,
            }),
            hexpand: true,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            css_classes: ['isle-settings-scale'],
        });

        const updateButtons = (val) => {
            const rounded = Math.round(val);
            buttons.forEach(({ btn, preset }) => {
                if (rounded === preset) {
                    btn.add_css_class('isle-pill-accent');
                    btn.remove_css_class('isle-pill-small');
                } else {
                    btn.remove_css_class('isle-pill-accent');
                    btn.add_css_class('isle-pill-small');
                }
            });
        };

        presets.forEach(p => {
            const btn = pillButton(`${p}%`, (p === currentVal ? 'isle-pill-accent' : 'isle-pill-small'), () => {
                scale.set_value(p);
                if (globalThis.isleSetGlassOpacity) globalThis.isleSetGlassOpacity(p);
                updateButtons(p);
            });
            btn.set_size_request(44, 26);
            buttons.push({ btn, preset: p });
            presetsBox.append(btn);
        });

        topRow.append(presetsBox);
        card.append(topRow);

        scale.connect('value-changed', () => {
            const val = Math.round(scale.get_value());
            if (globalThis.isleSetGlassOpacity) globalThis.isleSetGlassOpacity(val);
            updateButtons(val);
        });
        card.append(scale);

        return card;
    }

    _buildClockFormatSection() {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            css_classes: ['isle-settings-card'],
        });

        const labelBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
        });
        const title = label('Clock Format', 'isle-title');
        const subtitle = label('Time presentation across island and compact notch', 'isle-subtitle');
        labelBox.append(title);
        labelBox.append(subtitle);
        card.append(labelBox);

        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        const is12 = Format.uses12Hour();
        let btn12, btn24;

        const updateClockBtns = (mode12) => {
            if (mode12) {
                btn12.add_css_class('isle-pill-accent');
                btn12.remove_css_class('isle-pill-small');
                btn24.remove_css_class('isle-pill-accent');
                btn24.add_css_class('isle-pill-small');
            } else {
                btn24.add_css_class('isle-pill-accent');
                btn24.remove_css_class('isle-pill-small');
                btn12.remove_css_class('isle-pill-accent');
                btn12.add_css_class('isle-pill-small');
            }
        };

        btn12 = pillButton('12-Hour', (is12 ? 'isle-pill-accent' : 'isle-pill-small'), () => {
            Format.setClockFormat('12h');
            updateClockBtns(true);
            if (globalThis.isleSaveSettings) globalThis.isleSaveSettings();
            if (globalThis.isleExpanded?._tickClock) globalThis.isleExpanded._tickClock();
            if (globalThis.isleCompact?._tickClock) globalThis.isleCompact._tickClock();
        });
        btn12.set_size_request(76, 28);

        btn24 = pillButton('24-Hour', (!is12 ? 'isle-pill-accent' : 'isle-pill-small'), () => {
            Format.setClockFormat('24h');
            updateClockBtns(false);
            if (globalThis.isleSaveSettings) globalThis.isleSaveSettings();
            if (globalThis.isleExpanded?._tickClock) globalThis.isleExpanded._tickClock();
            if (globalThis.isleCompact?._tickClock) globalThis.isleCompact._tickClock();
        });
        btn24.set_size_request(76, 28);

        btnBox.append(btn12);
        btnBox.append(btn24);
        card.append(btnBox);

        return card;
    }

    _buildSoundSection() {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            css_classes: ['isle-settings-card'],
        });

        const labelBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
        });
        const title = label('Timer & Alarm Audio', 'isle-title');
        const subtitle = label('Play audible alert when countdown timer or alarm finishes', 'isle-subtitle');
        labelBox.append(title);
        labelBox.append(subtitle);
        card.append(labelBox);

        const soundEnabled = globalThis.isleSoundEnabled !== false;
        let soundBtn;

        const updateSoundBtn = (enabled) => {
            if (enabled) {
                soundBtn.set_label('Sound On');
                soundBtn.add_css_class('isle-pill-accent');
                soundBtn.remove_css_class('isle-pill-small');
            } else {
                soundBtn.set_label('Muted');
                soundBtn.remove_css_class('isle-pill-accent');
                soundBtn.add_css_class('isle-pill-small');
            }
        };

        soundBtn = pillButton((soundEnabled ? 'Sound On' : 'Muted'), (soundEnabled ? 'isle-pill-accent' : 'isle-pill-small'), () => {
            const nextState = globalThis.isleSoundEnabled === false;
            globalThis.isleSoundEnabled = nextState;
            updateSoundBtn(nextState);
            if (globalThis.isleSaveSettings) globalThis.isleSaveSettings();
            if (nextState) {
                try {
                    GLib.spawn_command_line_async('canberra-gtk-play -i bell');
                } catch (_) {}
            }
        });
        soundBtn.set_size_request(88, 28);
        card.append(soundBtn);

        return card;
    }

    _buildSystemSettingsSection() {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            css_classes: ['isle-settings-card'],
        });

        const labelBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
        });
        const title = label('System Preferences', 'isle-title');
        const subtitle = label('Launch XFCE settings manager for hardware & displays', 'isle-subtitle');
        labelBox.append(title);
        labelBox.append(subtitle);
        card.append(labelBox);

        const launchBtn = pillButton('Open Settings', 'isle-pill-small', () => {
            try {
                GLib.spawn_command_line_async('xfce4-settings-manager');
                print('[Isle Settings] Launched xfce4-settings-manager');
            } catch (err) {
                console.warn('[Isle Settings] Failed to launch xfce4-settings-manager:', err.message);
            }
        });
        launchBtn.set_size_request(110, 28);
        card.append(launchBtn);

        return card;
    }
});
