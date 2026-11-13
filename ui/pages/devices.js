// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Devices & System Audio page for Isle XFCE GTK4 runtime.
//! Displays connected Bluetooth devices, PipeWire/Pulse audio sink & source controls, and battery telemetry.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { Slider, deviceIcon, icon, iconButton, label, setButtonIcon } from '../widgets.js';
import { Page } from '../page.js';
import { getTelemetryMonitor, getBatteryTelemetry, sampleNetworkThroughput } from '../telemetry.js';

function runCommandAsync(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        return new Promise(resolve => {
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    resolve(stdout?.trim() ?? '');
                } catch {
                    resolve('');
                }
            });
        });
    } catch {
        return Promise.resolve('');
    }
}

async function queryAudioLevels() {
    const sinkOut = await runCommandAsync(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@']);
    const sourceOut = await runCommandAsync(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SOURCE@']);

    const parse = (str) => {
        const m = str.match(/Volume:\s+([0-9.]+)/);
        const muted = str.includes('[MUTED]');
        const vol = m ? parseFloat(m[1]) : 0.5;
        return { vol, muted };
    };

    return {
        sink: parse(sinkOut),
        source: parse(sourceOut),
    };
}

export const DevicesPage = GObject.registerClass({
    GTypeName: 'IsleGtkDevicesPage',
}, class DevicesPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'devices',
            height,
            available: true,
        });

        this._sinkVolume = 0.5;
        this._sinkMuted = false;
        this._sourceVolume = 1.0;
        this._sourceMuted = false;

        this._buildUi();

        this.watch(['system'], () => this._update());
        this._update();
        this._refreshAudio();

        this._monitor = getTelemetryMonitor();
        this._monitorHandler = this._monitor.connect('updated', () => this._updateLiveTelemetry());
    }

    get available() {
        return true;
    }

    onActivate() {
        this._refreshAudio();
    }

    _buildUi() {
        this._mainScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-devices-scroll'],
        });

        this._container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-devices-content'],
        });

        // 1. System Telemetry Chips (Battery & Network)
        this._telemetryRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });

        // Battery Chip
        this._batteryCard = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-device-card'],
        });
        this._batteryIcon = new Gtk.Image({
            gicon: icon('isle-battery-symbolic'),
            pixel_size: 18,
            valign: Gtk.Align.CENTER,
        });
        const batteryTexts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            valign: Gtk.Align.CENTER,
        });
        this._batteryPercentLbl = label('--%', 'isle-device-name');
        this._batteryStatusLbl = label('Battery', 'isle-device-connected');
        batteryTexts.append(this._batteryPercentLbl);
        batteryTexts.append(this._batteryStatusLbl);
        this._batteryCard.append(this._batteryIcon);
        this._batteryCard.append(batteryTexts);
        this._telemetryRow.append(this._batteryCard);

        // Network Chip
        this._netCard = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-device-card'],
        });
        this._netIcon = new Gtk.Image({
            gicon: icon('isle-wifi-symbolic'),
            pixel_size: 18,
            valign: Gtk.Align.CENTER,
        });
        const netTexts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            valign: Gtk.Align.CENTER,
        });
        this._netNameLbl = label('Network', 'isle-device-name');
        this._netStatusLbl = label('Connected', 'isle-device-connected');
        netTexts.append(this._netNameLbl);
        netTexts.append(this._netStatusLbl);
        this._netCard.append(this._netIcon);
        this._netCard.append(netTexts);
        this._telemetryRow.append(this._netCard);

        this._container.append(this._telemetryRow);

        // 2. Audio Controls Card (Sink & Source)
        const audioCard = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-device-card'],
        });

        // Audio Output (Sink)
        const sinkRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this._sinkMuteBtn = iconButton('isle-speaker-2-symbolic', 'isle-button-flat', () => this._toggleSinkMute(), {
            size: 16,
            accessibleName: 'Toggle mute speaker',
        });
        const sinkLbl = label('Output', 'isle-device-name', { width_chars: 6 });
        this._sinkSlider = new Slider({ scrollStep: 0.05 });
        this._sinkSlider.connect('released', (_slider, val) => {
            this._sinkVolume = val;
            runCommandAsync(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', val.toFixed(2)]);
            this._sinkPercentLbl.set_text(`${Math.round(val * 100)}%`);
        });
        this._sinkPercentLbl = label('50%', 'isle-device-level');

        sinkRow.append(this._sinkMuteBtn);
        sinkRow.append(sinkLbl);
        sinkRow.append(this._sinkSlider);
        sinkRow.append(this._sinkPercentLbl);
        audioCard.append(sinkRow);

        // Audio Input (Source / Mic)
        const sourceRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this._sourceMuteBtn = iconButton('isle-mic-symbolic', 'isle-button-flat', () => this._toggleSourceMute(), {
            size: 16,
            accessibleName: 'Toggle mute microphone',
        });
        const sourceLbl = label('Input', 'isle-device-name', { width_chars: 6 });
        this._sourceSlider = new Slider({ scrollStep: 0.05 });
        this._sourceSlider.connect('released', (_slider, val) => {
            this._sourceVolume = val;
            runCommandAsync(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SOURCE@', val.toFixed(2)]);
            this._sourcePercentLbl.set_text(`${Math.round(val * 100)}%`);
        });
        this._sourcePercentLbl = label('100%', 'isle-device-level');

        sourceRow.append(this._sourceMuteBtn);
        sourceRow.append(sourceLbl);
        sourceRow.append(this._sourceSlider);
        sourceRow.append(this._sourcePercentLbl);
        audioCard.append(sourceRow);

        this._container.append(audioCard);

        // 3. Bluetooth Section
        const btHeading = label('Connected Bluetooth Devices', 'isle-device-texts', {
            halign: Gtk.Align.START,
            margin_top: 2,
        });
        this._container.append(btHeading);

        this._btList = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
        });
        this._container.append(this._btList);

        this._mainScroll.set_child(this._container);
        this.append(this._mainScroll);
    }

    async _refreshAudio() {
        const levels = await queryAudioLevels();
        this._sinkVolume = levels.sink.vol;
        this._sinkMuted = levels.sink.muted;
        this._sourceVolume = levels.source.vol;
        this._sourceMuted = levels.source.muted;

        this._sinkSlider.value = this._sinkVolume;
        this._sinkPercentLbl.set_text(`${Math.round(this._sinkVolume * 100)}%`);
        setButtonIcon(this._sinkMuteBtn, this._sinkMuted ? 'isle-speaker-off-symbolic' : 'isle-speaker-2-symbolic');

        this._sourceSlider.value = this._sourceVolume;
        this._sourcePercentLbl.set_text(`${Math.round(this._sourceVolume * 100)}%`);
        setButtonIcon(this._sourceMuteBtn, this._sourceMuted ? 'isle-mic-off-symbolic' : 'isle-mic-symbolic');
    }

    _toggleSinkMute() {
        this._sinkMuted = !this._sinkMuted;
        setButtonIcon(this._sinkMuteBtn, this._sinkMuted ? 'isle-speaker-off-symbolic' : 'isle-speaker-2-symbolic');
        runCommandAsync(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']);
    }

    _toggleSourceMute() {
        this._sourceMuted = !this._sourceMuted;
        setButtonIcon(this._sourceMuteBtn, this._sourceMuted ? 'isle-mic-off-symbolic' : 'isle-mic-symbolic');
        runCommandAsync(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SOURCE@', 'toggle']);
    }

    _updateLiveTelemetry() {
        const sys = this.daemon?.state?.system ?? {};

        // Live battery telemetry update
        if (this._batteryPercentLbl) {
            const batInfo = getBatteryTelemetry(sys.battery);
            if (batInfo) {
                this._batteryPercentLbl.set_text(batInfo.fullText);
                const status = batInfo.isCharging ? 'Charging' : (batInfo.isPlugged ? 'Plugged in' : 'Battery');
                this._batteryStatusLbl.set_text(status);
                const iconName = batInfo.percent <= 20 ? 'isle-battery-low-symbolic' : 'isle-battery-symbolic';
                this._batteryIcon.set_from_gicon(icon(iconName));
            }
        }

        // Live network throughput update
        if (this._netStatusLbl) {
            const net = sys.network;
            const connected = Boolean(net?.connected);
            const netSpeed = sampleNetworkThroughput();
            this._netStatusLbl.set_text(connected ? netSpeed.formatted : 'Disconnected');
        }
    }

    _update() {
        const sys = this.daemon?.state?.system ?? {};

        // Battery update
        if (sys.battery) {
            const batInfo = getBatteryTelemetry(sys.battery);
            if (batInfo) {
                this._batteryPercentLbl.set_text(batInfo.fullText);
                const status = batInfo.isCharging ? 'Charging' : (batInfo.isPlugged ? 'Plugged in' : 'Battery');
                this._batteryStatusLbl.set_text(status);
                const iconName = batInfo.percent <= 20 ? 'isle-battery-low-symbolic' : 'isle-battery-symbolic';
                this._batteryIcon.set_from_gicon(icon(iconName));
            } else {
                const pct = Math.round(sys.battery.percent || 0);
                this._batteryPercentLbl.set_text(`${pct}%`);
                const status = sys.battery.charging ? 'Charging' : (sys.battery.plugged ? 'Plugged in' : 'On battery');
                this._batteryStatusLbl.set_text(status);
                const iconName = pct <= 20 ? 'isle-battery-low-symbolic' : 'isle-battery-symbolic';
                this._batteryIcon.set_from_gicon(icon(iconName));
            }
        }

        // Network update
        if (sys.network) {
            const net = sys.network;
            const connected = Boolean(net.connected);
            const netSpeed = sampleNetworkThroughput();
            this._netNameLbl.set_text(net.name || (connected ? 'Connected' : 'Offline'));
            this._netStatusLbl.set_text(connected ? netSpeed.formatted : 'Disconnected');
            const iconName = connected ? 'isle-wifi-symbolic' : 'isle-wifi-off-symbolic';
            this._netIcon.set_from_gicon(icon(iconName));
        }

        // Bluetooth devices update
        let child = this._btList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._btList.remove(child);
            child = next;
        }

        const devices = sys.bluetooth || [];
        if (devices.length === 0) {
            const noneLbl = label('No Bluetooth devices connected', 'isle-device-none', {
                halign: Gtk.Align.START,
                margin_start: 4,
            });
            this._btList.append(noneLbl);
        } else {
            for (const dev of devices) {
                this._btList.append(this._buildDeviceCard(dev));
            }
        }
    }

    _buildDeviceCard(dev) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-device-card'],
        });

        // Device Icon Tile
        const tile = new Gtk.Box({
            css_classes: ['isle-device-tile'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        const img = new Gtk.Image({
            gicon: icon(deviceIcon(dev.icon)),
            pixel_size: 16,
            css_classes: ['isle-device-icon'],
        });
        tile.append(img);
        card.append(tile);

        // Texts: Name & Status
        const texts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-device-texts'],
        });
        const nameLbl = label(dev.name || 'Bluetooth Device', 'isle-device-name');
        nameLbl.set_ellipsize(Pango.EllipsizeMode.END);
        nameLbl.set_halign(Gtk.Align.START);

        const statusRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.START,
            css_classes: ['isle-device-status'],
        });
        const dot = new Gtk.Box({
            css_classes: ['isle-device-dot'],
            valign: Gtk.Align.CENTER,
        });
        const connLbl = label('Connected', 'isle-device-connected');
        statusRow.append(dot);
        statusRow.append(connLbl);

        texts.append(nameLbl);
        texts.append(statusRow);
        card.append(texts);

        // Battery level if available
        if (dev.battery !== null && dev.battery !== undefined) {
            const batLevel = Math.round(dev.battery);
            const levelLbl = label(`${batLevel}%`, 'isle-device-level', {
                valign: Gtk.Align.CENTER,
            });
            card.append(levelLbl);
        }

        return card;
    }
});
