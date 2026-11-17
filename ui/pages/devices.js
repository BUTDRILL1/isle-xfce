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
import {
    getBatteryTelemetry,
    getConnectedPeripherals,
    getTelemetryMonitor,
    getWifiSignal,
    sampleNetworkThroughput,
} from '../telemetry.js';

const ALSA_AUTOMUTE_PY = `
import ctypes, sys
a = ctypes.CDLL('libasound.so.2'); vp = ctypes.c_void_p
a.snd_mixer_open.argtypes = [ctypes.POINTER(vp), ctypes.c_int]
a.snd_mixer_attach.argtypes = [vp, ctypes.c_char_p]
a.snd_mixer_selem_register.argtypes = [vp, vp, vp]
a.snd_mixer_load.argtypes = [vp]; a.snd_mixer_close.argtypes = [vp]
a.snd_mixer_first_elem.argtypes = [vp]; a.snd_mixer_first_elem.restype = vp
a.snd_mixer_elem_next.argtypes = [vp]; a.snd_mixer_elem_next.restype = vp
a.snd_mixer_selem_get_name.argtypes = [vp]; a.snd_mixer_selem_get_name.restype = ctypes.c_char_p
a.snd_mixer_selem_set_enum_item.argtypes = [vp, ctypes.c_int, ctypes.c_uint]
h = vp()
if a.snd_mixer_open(ctypes.byref(h), 0) == 0 and a.snd_mixer_attach(h, sys.argv[1].encode()) == 0:
    a.snd_mixer_selem_register(h, None, None); a.snd_mixer_load(h)
    e = a.snd_mixer_first_elem(h)
    while e:
        if a.snd_mixer_selem_get_name(e) == b'Auto-Mute Mode':
            a.snd_mixer_selem_set_enum_item(e, 0, int(sys.argv[2]))
        e = a.snd_mixer_elem_next(e)
    a.snd_mixer_close(h)
`;

function setAlsaAutoMuteAsync(alsaCard, enabled) {
    if (alsaCard === null || alsaCard === undefined) return Promise.resolve('');
    return runCommandAsync(['python3', '-c', ALSA_AUTOMUTE_PY, `hw:${alsaCard}`, enabled ? '1' : '0']);
}

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
    _init(daemon, { height = 150, notificationCenter = null } = {}) {
        super._init(daemon, {
            name: 'devices',
            height,
            available: true,
        });

        this._notificationCenter = notificationCenter;
        this._sinkVolume = 0.5;
        this._sinkMuted = false;
        this._sourceVolume = 1.0;
        this._sourceMuted = false;
        this._airplaneMode = false;
        this._connectedCount = 0;
        this._lastPeripheralsKey = null;
        this._lastEndpointsKey = null;

        this._buildUi();

        this.watch(['system'], () => this._update());
        this._update();
        this._refreshAudio();
        this._syncDndBtn();
        this._refreshAirplaneState();

        if (this._notificationCenter) {
            this._dndHandler = this._notificationCenter.connect('dnd-changed', () => this._syncDndBtn());
        }

        this._monitor = getTelemetryMonitor();
        this._monitorHandler = this._monitor.connect('updated', () => this._updateLiveTelemetry());
        this._volHandler = this._monitor.connect('volume-changed', () => this._refreshAudio());
        this.connect('map', () => this._updateLiveTelemetry());
    }

    get available() {
        return true;
    }

    getDesiredHeight() {
        if (this._connectedCount > 0) {
            return Math.min(375, 315 + this._connectedCount * 62);
        }
        return 275;
    }

    onActivate() {
        this._refreshAudio();
        this._refreshAirplaneState();
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
            vexpand: false,
            valign: Gtk.Align.START,
            css_classes: ['isle-devices-content'],
        });

        // 1. System Telemetry Chips (Battery & Network) + DND & Airplane Square Toggles
        this._telemetryRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            homogeneous: false,
            hexpand: true,
        });

        // Battery Chip
        this._batteryCard = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-device-card', 'isle-device-top-card'],
        });
        const batTile = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['isle-device-tile'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        this._batteryIcon = new Gtk.Image({
            gicon: icon('isle-battery-symbolic'),
            pixel_size: 16,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        batTile.append(this._batteryIcon);
        const batteryTexts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        this._batteryPercentLbl = label('--%', 'isle-device-name', { halign: Gtk.Align.START });
        this._batteryStatusLbl = label('Battery', 'isle-device-connected', { halign: Gtk.Align.START });
        this._batteryPercentLbl.set_ellipsize(Pango.EllipsizeMode.END);
        this._batteryStatusLbl.set_ellipsize(Pango.EllipsizeMode.END);
        batteryTexts.append(this._batteryPercentLbl);
        batteryTexts.append(this._batteryStatusLbl);
        this._batteryCard.append(batTile);
        this._batteryCard.append(batteryTexts);
        this._telemetryRow.append(this._batteryCard);

        // Network Chip
        this._netCard = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-device-card', 'isle-device-top-card'],
        });
        const netTile = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['isle-device-tile'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        this._netIcon = new Gtk.Image({
            gicon: icon('isle-wifi-symbolic'),
            pixel_size: 16,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        netTile.append(this._netIcon);
        const netTexts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        this._netNameLbl = label('Network', 'isle-device-name', { halign: Gtk.Align.START });
        this._netStatusLbl = label('Connected', 'isle-device-connected', { halign: Gtk.Align.START });
        this._netNameLbl.set_ellipsize(Pango.EllipsizeMode.END);
        this._netStatusLbl.set_ellipsize(Pango.EllipsizeMode.END);
        netTexts.append(this._netNameLbl);
        netTexts.append(this._netStatusLbl);
        this._netCard.append(netTile);
        this._netCard.append(netTexts);
        this._telemetryRow.append(this._netCard);

        // DND Square Toggle
        this._dndBtn = iconButton('isle-moon', 'isle-status-square-btn isle-dnd-btn', () => {
            this._toggleDnd();
        }, { size: 18, accessibleName: 'Do Not Disturb' });
        this._dndBtn.set_size_request(48, 48);
        this._dndBtn.set_tooltip_text('Do Not Disturb');
        this._dndBtn.set_valign(Gtk.Align.CENTER);
        this._telemetryRow.append(this._dndBtn);

        // Airplane Mode Square Toggle
        this._airplaneBtn = iconButton('isle-airplane-symbolic', 'isle-status-square-btn isle-airplane-btn', () => {
            this._toggleAirplaneMode();
        }, { size: 18, accessibleName: 'Airplane Mode' });
        this._airplaneBtn.set_size_request(48, 48);
        this._airplaneBtn.set_tooltip_text('Airplane Mode');
        this._airplaneBtn.set_valign(Gtk.Align.CENTER);
        this._telemetryRow.append(this._airplaneBtn);

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

        // Output Sink Switcher Pills
        this._sinkChipsRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            margin_start: 24,
        });
        audioCard.append(this._sinkChipsRow);

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

        // Input Source Switcher Pills
        this._sourceChipsRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            margin_start: 24,
        });
        audioCard.append(this._sourceChipsRow);

        this._container.append(audioCard);

        // 3. Unified Connected Devices Section (auto-hides when 0 devices)
        this._btHeading = label('Connected Devices', 'isle-device-texts', {
            halign: Gtk.Align.START,
            margin_top: 2,
            visible: false,
        });
        this._container.append(this._btHeading);

        this._btList = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            visible: false,
        });
        this._container.append(this._btList);

        this._mainScroll.set_child(this._container);
        this.append(this._mainScroll);
    }

    _toggleDnd() {
        if (!this._notificationCenter) return;
        this._notificationCenter.dnd = !this._notificationCenter.dnd;
        this._syncDndBtn();
    }

    _syncDndBtn() {
        if (!this._dndBtn || !this._notificationCenter) return;
        const on = Boolean(this._notificationCenter.dnd);
        if (on) this._dndBtn.add_css_class('active');
        else this._dndBtn.remove_css_class('active');
    }

    async _refreshAirplaneState() {
        if (!this._airplaneBtn) return;
        const out = await runCommandAsync(['rfkill', '-J']);
        let blocked = false;
        try {
            const data = JSON.parse(out);
            const devs = data?.rfkilldevices ?? [];
            if (devs.length > 0) {
                blocked = devs.every(d => d.soft === 'blocked' || d.hard === 'blocked');
            }
        } catch (_) {}
        this._airplaneMode = blocked;
        if (blocked) this._airplaneBtn.add_css_class('active');
        else this._airplaneBtn.remove_css_class('active');
    }

    async _toggleAirplaneMode() {
        const next = !this._airplaneMode;
        this._airplaneMode = next;
        if (next) this._airplaneBtn.add_css_class('active');
        else this._airplaneBtn.remove_css_class('active');

        await runCommandAsync(['rfkill', next ? 'block' : 'unblock', 'all']);
        await runCommandAsync(['nmcli', 'radio', 'wifi', next ? 'off' : 'on']);
        this._refreshAirplaneState();
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

        this._refreshAudioEndpoints();
    }

    async _refreshAudioEndpoints() {
        const [stdout, cardsJson] = await Promise.all([
            runCommandAsync(['wpctl', 'status']),
            runCommandAsync(['pactl', '-f', 'json', 'list', 'cards']),
        ]);
        if (!stdout) return;

        const sinks = [];
        const sources = [];
        let inAudio = false;
        let section = null;
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === 'Audio') { inAudio = true; section = null; continue; }
            if (trimmed === 'Video' || trimmed === 'Settings') { break; }
            if (!inAudio) continue;
            if (trimmed.includes('Sinks:')) { section = 'sinks'; continue; }
            if (trimmed.includes('Sources:')) { section = 'sources'; continue; }
            if (trimmed.includes('Filters:') || trimmed.includes('Streams:') || trimmed.includes('Devices:')) {
                section = null;
                continue;
            }
            if (!section) continue;
            const m = line.match(/([* ]?)\s*(\d+)\.\s+([^\[]+)/);
            if (!m) continue;
            const isDefault = m[1].includes('*');
            const id = m[2];
            const rawName = m[3].trim();
            let shortName = rawName
                .replace(/^Ryzen HD Audio Controller\s*/i, '')
                .replace(/^Renoir\/Cezanne HDMI\/DP Audio Controller\s*/i, 'HDMI ')
                .trim() || rawName;
            if (section === 'sinks' && /^Speaker$/i.test(shortName)) {
                shortName = 'PC Speakers';
            }
            (section === 'sinks' ? sinks : sources).push({ id, name: shortName, isDefault });
        }

        // Include inactive ALSA UCM output ports (e.g. PC Speakers when Headphones are plugged in)
        if (cardsJson) {
            try {
                const cards = JSON.parse(cardsJson);
                for (const card of cards) {
                    const profiles = card.profiles || {};
                    const ports = card.ports || {};
                    const activeProfile = card.active_profile;
                    for (const [portKey, port] of Object.entries(ports)) {
                        if (!portKey.startsWith('[Out]')) continue;
                        if (port.availability === 'not available') continue;
                        if (port.type !== 'Speaker' && port.type !== 'Headphones') continue;
                        const label = port.type === 'Speaker' ? 'PC Speakers' : 'Headphones';
                        if (sinks.some(s => s.name === label)) continue;
                        const targetProfile = (port.profiles || []).find(
                            p => p !== activeProfile && profiles[p]?.available && (profiles[p]?.sinks || 0) > 0
                        );
                        if (!targetProfile) continue;
                        sinks.push({
                            id: null,
                            name: label,
                            isDefault: false,
                            cardName: card.name,
                            profileName: targetProfile,
                            alsaCard: card.properties?.['alsa.card'],
                            autoMute: port.type !== 'Speaker',
                        });
                    }
                }
            } catch (_e) {}
        }

        const key = JSON.stringify({ sinks, sources });
        if (key === this._lastEndpointsKey) return;
        this._lastEndpointsKey = key;

        const populate = (row, items) => {
            if (!row) return;
            while (row.get_first_child()) {
                row.remove(row.get_first_child());
            }
            row.set_visible(items.length > 0);
            for (const item of items) {
                const btn = new Gtk.Button({
                    label: item.name,
                    css_classes: ['isle-output-chip', item.isDefault ? 'active' : 'idle'],
                });
                btn.connect('clicked', () => {
                    this._lastEndpointsKey = null;
                    const switchPromise = item.cardName && item.profileName
                        ? setAlsaAutoMuteAsync(item.alsaCard, item.autoMute).then(() =>
                            runCommandAsync(['pactl', 'set-card-profile', item.cardName, item.profileName]))
                        : runCommandAsync(['wpctl', 'set-default', item.id]);
                    switchPromise.then(() => {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                            this._refreshAudio();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                });
                row.append(btn);
            }
        };

        populate(this._sinkChipsRow, sinks);
        populate(this._sourceChipsRow, sources);
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

    _syncTopCards() {
        const sys = this.daemon?.state?.system ?? {};

        // 1. Battery Card
        const batInfo = getBatteryTelemetry(sys.battery);
        if (batInfo) {
            const stateStr = batInfo.isCharging ? 'Charging' : (batInfo.isPlugged ? 'Plugged in' : 'On Battery');
            this._batteryPercentLbl.set_text(`${batInfo.percent}% · ${stateStr}`);
            this._batteryStatusLbl.set_text(batInfo.timeStr || (batInfo.isPlugged ? 'AC Connected' : 'Discharging'));
            const iconName = batInfo.percent <= 20 ? 'isle-battery-low-symbolic' : 'isle-battery-symbolic';
            this._batteryIcon.set_from_gicon(icon(iconName));
        } else if (sys.battery) {
            const pct = Math.round(sys.battery.percent || 0);
            const stateStr = sys.battery.charging ? 'Charging' : (sys.battery.plugged ? 'Plugged in' : 'On Battery');
            this._batteryPercentLbl.set_text(`${pct}% · ${stateStr}`);
            this._batteryStatusLbl.set_text('Battery');
            const iconName = pct <= 20 ? 'isle-battery-low-symbolic' : 'isle-battery-symbolic';
            this._batteryIcon.set_from_gicon(icon(iconName));
        }

        // 2. Network Card
        const net = sys.network;
        const wifiSig = getWifiSignal();
        const connected = Boolean(net?.connected || wifiSig.connected);
        const netSpeed = sampleNetworkThroughput();
        const ssid = net?.name || net?.connection || (connected ? 'Wi-Fi' : 'Offline');
        this._netNameLbl.set_text(connected && wifiSig.quality > 0 ? `${ssid} · ${wifiSig.quality}%` : ssid);
        this._netStatusLbl.set_text(connected ? `↓ ${netSpeed.downSpeedStr} · ↑ ${netSpeed.upSpeedStr}` : 'Disconnected');
        const iconName = connected ? 'isle-wifi-symbolic' : 'isle-wifi-off-symbolic';
        this._netIcon.set_from_gicon(icon(iconName));
    }

    _syncConnectedDevices() {
        const sys = this.daemon?.state?.system ?? {};
        const devices = getConnectedPeripherals(sys.bluetooth || []);
        const key = JSON.stringify(devices);
        if (key === this._lastPeripheralsKey) return;
        this._lastPeripheralsKey = key;

        let child = this._btList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._btList.remove(child);
            child = next;
        }

        const hasDevices = devices.length > 0;
        this._btHeading.set_visible(hasDevices);
        this._btList.set_visible(hasDevices);

        for (const dev of devices) {
            this._btList.append(this._buildDeviceCard(dev));
        }

        if (this._connectedCount !== devices.length) {
            this._connectedCount = devices.length;
            this.emit('height-changed');
        }
    }

    _updateLiveTelemetry() {
        if (!this.get_mapped()) return;
        this._syncTopCards();
        this._syncConnectedDevices();
    }

    _update() {
        this._syncTopCards();
        this._syncConnectedDevices();
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
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['isle-device-tile'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        const img = new Gtk.Image({
            gicon: icon(deviceIcon(dev.icon)),
            pixel_size: 16,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            vexpand: true,
            css_classes: ['isle-device-icon'],
        });
        tile.append(img);
        card.append(tile);

        // Texts: Name & Kind/Status
        const texts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-device-texts'],
        });
        const nameLbl = label(dev.name || 'Connected Device', 'isle-device-name');
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
        const connLbl = label(dev.kind ? `${dev.kind} · Connected` : 'Connected', 'isle-device-connected');
        statusRow.append(dot);
        statusRow.append(connLbl);

        texts.append(nameLbl);
        texts.append(statusRow);
        card.append(texts);

        // Battery level if available
        if (dev.battery !== null && dev.battery !== undefined && !isNaN(dev.battery)) {
            const batLevel = Math.round(dev.battery);
            const levelLbl = label(`${batLevel}%`, 'isle-device-level', {
                valign: Gtk.Align.CENTER,
            });
            card.append(levelLbl);
        }

        return card;
    }
});
