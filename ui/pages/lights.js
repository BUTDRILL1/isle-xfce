// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! WiZ Smart Bulb control page for Isle XFCE GTK4 runtime.
//! Auto-discovers WiZ bulbs over local UDP and drives Static, Music Sync, and Screen Sync modes.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { Slider, icon, label } from '../widgets.js';
import { Page } from '../page.js';

const WIZ_PYTHON = '/usr/bin/python3';
const WIZ_BRIDGE = '/home/butarch/Desktop/isle-xfce/ui/wiz_bridge.py';

const STATIC_PRESETS = [
    { label: 'Warm', temp: 2700, hex: '#ffb46b' },
    { label: 'Daylight', temp: 4500, hex: '#fff1e0' },
    { label: 'Cool', temp: 6500, hex: '#dbe9ff' },
    { label: 'Red', r: 255, g: 45, b: 55, hex: '#ff2d37' },
    { label: 'Amber', r: 255, g: 159, b: 10, hex: '#ff9f0a' },
    { label: 'Emerald', r: 48, g: 209, b: 88, hex: '#30d158' },
    { label: 'Cyan', r: 50, g: 210, b: 255, hex: '#32d2ff' },
    { label: 'Purple', r: 165, g: 80, b: 255, hex: '#a550ff' },
];

const MUSIC_THEMES = [
    { id: 'rainbow', label: 'Rainbow' },
    { id: 'club', label: 'Club' },
    { id: 'fire', label: 'Fire' },
    { id: 'ocean', label: 'Ocean' },
    { id: 'sesh', label: 'Sesh' },
];

const SCREEN_REGIONS = [
    { id: 'full_screen', label: 'Full' },
    { id: 'top_center', label: 'Top' },
    { id: 'mid_left', label: 'Left' },
    { id: 'mid_right', label: 'Right' },
];

export const LightsPage = GObject.registerClass({
    GTypeName: 'IsleGtkLightsPage',
}, class LightsPage extends Page {
    _init(daemon, { height = 275 } = {}) {
        super._init(daemon, {
            name: 'lights',
            height,
            available: true,
        });

        this._connected = false;
        this._bulbIp = null;
        this._powerOn = true;
        this._mode = 'static';
        this._musicTheme = 'rainbow';
        this._musicSource = 'system';
        this._screenRegion = 'full_screen';
        this._brightness = 80;
        this._fps = 20;
        this._syncingUi = false;

        this._proc = null;
        this._stdinStream = null;
        this._stdoutData = null;

        this._buildUi();
        this._startBridge();
    }

    get available() {
        return true;
    }

    set available(_v) {
        super.available = true;
    }

    getDesiredHeight() {
        return 275;
    }

    _startBridge() {
        try {
            this._proc = Gio.Subprocess.new(
                [WIZ_PYTHON, '-u', WIZ_BRIDGE],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            this._stdinStream = new Gio.DataOutputStream({
                base_stream: this._proc.get_stdin_pipe(),
            });
            this._stdoutData = new Gio.DataInputStream({
                base_stream: this._proc.get_stdout_pipe(),
            });
            this._readNextLine();
        } catch (e) {
            this._statusLbl.set_text('Bridge error');
            console.warn(`Isle WiZ: failed to start bridge: ${e.message}`);
        }
    }

    _readNextLine() {
        if (!this._stdoutData) return;
        this._stdoutData.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                const [line] = stream.read_line_finish_utf8(res);
                if (line !== null) {
                    if (line.trim()) this._onBridgeMessage(line.trim());
                    this._readNextLine();
                }
            } catch (_e) {}
        });
    }

    _send(obj) {
        if (!this._stdinStream) return;
        try {
            this._stdinStream.put_string(JSON.stringify(obj) + '\n', null);
        } catch (e) {
            console.warn(`Isle WiZ: send failed: ${e.message}`);
        }
    }

    _onBridgeMessage(raw) {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'scan') {
                this._connected = Boolean(msg.connected);
                this._bulbIp = msg.ip || null;
                this._statusLbl.set_text(this._connected ? `Connected · ${this._bulbIp}` : 'Bulb not found');
                this._statusDot.set_css_classes(['isle-device-dot', this._connected ? 'connected' : 'idle']);
                if (this._connected) {
                    this._powerOn = Boolean(msg.state);
                    this._updatePowerBtn();
                    if (typeof msg.dimming === 'number') {
                        this._syncingUi = true;
                        this._brightness = Math.max(10, Math.min(100, msg.dimming));
                        this._brightSlider.value = (this._brightness - 10) / 90;
                        this._brightVal.set_text(`${this._brightness}%`);
                        this._syncingUi = false;
                    }
                }
            } else if (msg.type === 'power') {
                this._powerOn = Boolean(msg.state);
                this._updatePowerBtn();
            }
        } catch (_e) {}
    }

    _updatePowerBtn() {
        this._powerBtn.set_label(this._powerOn ? 'On' : 'Off');
        this._powerBtn.set_css_classes(['isle-output-chip', this._powerOn ? 'active' : 'idle']);
    }

    _buildUi() {
        const root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-lights-container'],
        });

        // 1. Header: Bulb icon + title + auto-scan status + rescan + Power On/Off
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        const bulbIcon = new Gtk.Image({
            gicon: icon('isle-bulb-symbolic'),
            pixel_size: 16,
            css_classes: ['isle-audio-icon'],
        });
        header.append(bulbIcon);
        header.append(label('WiZ Bulb', 'isle-device-name'));

        this._statusDot = new Gtk.Box({
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-device-dot', 'idle'],
        });
        this._statusDot.set_size_request(7, 7);
        header.append(this._statusDot);

        this._statusLbl = label('Scanning…', 'isle-device-meta', {
            hexpand: true,
            halign: Gtk.Align.START,
        });
        header.append(this._statusLbl);

        const rescanBtn = new Gtk.Button({
            label: 'Scan',
            css_classes: ['isle-output-chip', 'idle'],
            tooltip_text: 'Rescan LAN for WiZ bulb',
        });
        rescanBtn.connect('clicked', () => {
            this._statusLbl.set_text('Scanning…');
            this._send({ cmd: 'scan' });
        });
        header.append(rescanBtn);

        this._powerBtn = new Gtk.Button({
            label: 'On',
            css_classes: ['isle-output-chip', 'active'],
        });
        this._powerBtn.connect('clicked', () => {
            this._powerOn = !this._powerOn;
            this._updatePowerBtn();
            this._send({ cmd: 'power', on: this._powerOn });
        });
        header.append(this._powerBtn);

        root.append(header);

        // 2. Main Mode Switcher: Static | Music | Screen
        const modeRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
        });
        this._modeBtns = {};
        for (const m of [
            { id: 'static', label: 'Static' },
            { id: 'music', label: 'Music Sync' },
            { id: 'screen', label: 'Screen Shading' },
        ]) {
            const btn = new Gtk.Button({
                label: m.label,
                hexpand: true,
                css_classes: ['isle-output-chip', m.id === this._mode ? 'active' : 'idle'],
            });
            btn.connect('clicked', () => this._setMode(m.id));
            this._modeBtns[m.id] = btn;
            modeRow.append(btn);
        }
        root.append(modeRow);

        // 3. Mode-specific sub-controls card
        const subCard = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-device-card'],
        });

        // 3a. Static controls (swatches + color picker)
        this._staticBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        for (const p of STATIC_PRESETS) {
            const dot = new Gtk.Box({
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.CENTER,
                css_classes: ['isle-wiz-swatch'],
            });
            dot.set_size_request(18, 18);
            const provider = new Gtk.CssProvider();
            provider.load_from_data(`box { background-color: ${p.hex}; border-radius: 9px; }`, -1);
            dot.get_style_context().add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

            const btn = new Gtk.Button({
                child: dot,
                tooltip_text: p.label,
                css_classes: ['isle-wiz-swatch-btn'],
            });
            btn.connect('clicked', () => {
                this._powerOn = true;
                this._updatePowerBtn();
                this._send(p.temp ? { cmd: 'static', temp: p.temp } : { cmd: 'static', r: p.r, g: p.g, b: p.b });
            });
            this._staticBox.append(btn);
        }

        this._staticBox.append(new Gtk.Box({ hexpand: true }));

        const colorDialog = new Gtk.ColorDialog({ with_alpha: false, title: 'Pick Bulb Color' });
        const colorBtn = new Gtk.ColorDialogButton({
            dialog: colorDialog,
            tooltip_text: 'Custom RGB color',
        });
        const initRgba = new Gdk.RGBA();
        initRgba.parse('#ff9f0a');
        colorBtn.set_rgba(initRgba);
        colorBtn.connect('notify::rgba', () => {
            const c = colorBtn.get_rgba();
            this._powerOn = true;
            this._updatePowerBtn();
            this._send({
                cmd: 'static',
                r: Math.round(c.red * 255),
                g: Math.round(c.green * 255),
                b: Math.round(c.blue * 255),
            });
        });
        this._staticBox.append(colorBtn);
        subCard.append(this._staticBox);

        // 3b. Music Sync sub-modes + source
        this._musicBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            visible: false,
        });
        this._themeBtns = {};
        for (const t of MUSIC_THEMES) {
            const btn = new Gtk.Button({
                label: t.label,
                css_classes: ['isle-output-chip', t.id === this._musicTheme ? 'active' : 'idle'],
            });
            btn.connect('clicked', () => {
                this._musicTheme = t.id;
                for (const [id, b] of Object.entries(this._themeBtns)) {
                    b.set_css_classes(['isle-output-chip', id === t.id ? 'active' : 'idle']);
                }
                this._send({ cmd: 'music', theme: this._musicTheme, source: this._musicSource });
            });
            this._themeBtns[t.id] = btn;
            this._musicBox.append(btn);
        }
        this._musicBox.append(new Gtk.Box({ hexpand: true }));
        this._sourceBtn = new Gtk.Button({
            label: 'System',
            css_classes: ['isle-output-chip', 'active'],
            tooltip_text: 'Toggle System Audio / Mic',
        });
        this._sourceBtn.connect('clicked', () => {
            this._musicSource = this._musicSource === 'system' ? 'mic' : 'system';
            this._sourceBtn.set_label(this._musicSource === 'system' ? 'System' : 'Mic');
            this._send({ cmd: 'music', theme: this._musicTheme, source: this._musicSource });
        });
        this._musicBox.append(this._sourceBtn);
        subCard.append(this._musicBox);

        // 3c. Screen Shading sub-regions
        this._screenBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            visible: false,
        });
        this._regionBtns = {};
        for (const r of SCREEN_REGIONS) {
            const btn = new Gtk.Button({
                label: r.label,
                hexpand: true,
                css_classes: ['isle-output-chip', r.id === this._screenRegion ? 'active' : 'idle'],
            });
            btn.connect('clicked', () => {
                this._screenRegion = r.id;
                for (const [id, b] of Object.entries(this._regionBtns)) {
                    b.set_css_classes(['isle-output-chip', id === r.id ? 'active' : 'idle']);
                }
                this._send({ cmd: 'screen', region: this._screenRegion });
            });
            this._regionBtns[r.id] = btn;
            this._screenBox.append(btn);
        }
        subCard.append(this._screenBox);

        root.append(subCard);

        // 4. Persistent sliders card (always visible over any mode)
        const slidersCard = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-device-card'],
        });

        // Brightness slider (10-100%)
        this._lastBrightSentMs = 0;
        this._lastFpsSentMs = 0;
        const brightRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10, hexpand: true, valign: Gtk.Align.CENTER });
        const brightLbl = label('Brightness', 'isle-lights-label', { halign: Gtk.Align.START });
        brightLbl.set_xalign(0);
        brightRow.append(brightLbl);
        this._brightSlider = new Slider({ scrollStep: 0.05 });
        this._brightSlider.set_size_request(180, 16);
        this._brightSlider.value = (this._brightness - 10) / 90;
        this._brightSlider.connect('value-changed', (_s, val) => {
            if (this._syncingUi) return;
            this._brightness = Math.round(10 + val * 90);
            this._brightVal.set_text(`${this._brightness}%`);
            const nowMs = GLib.get_monotonic_time() / 1000;
            if (nowMs - this._lastBrightSentMs >= 60) {
                this._lastBrightSentMs = nowMs;
                this._send({ cmd: 'brightness', value: this._brightness });
            }
        });
        this._brightSlider.connect('released', (_s, val) => {
            if (this._syncingUi) return;
            this._brightness = Math.round(10 + val * 90);
            this._brightVal.set_text(`${this._brightness}%`);
            this._send({ cmd: 'brightness', value: this._brightness });
        });
        brightRow.append(this._brightSlider);
        this._brightVal = label(`${this._brightness}%`, 'isle-lights-value', { halign: Gtk.Align.END });
        this._brightVal.set_xalign(1);
        brightRow.append(this._brightVal);
        slidersCard.append(brightRow);

        // Persistent FPS / Latency slider (5-60 FPS)
        this._fpsRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10, hexpand: true, valign: Gtk.Align.CENTER });
        const fpsLbl = label('Sync Speed', 'isle-lights-label', { halign: Gtk.Align.START });
        fpsLbl.set_xalign(0);
        this._fpsRow.append(fpsLbl);
        this._fpsSlider = new Slider({ scrollStep: 0.05 });
        this._fpsSlider.set_size_request(180, 16);
        this._fpsSlider.value = (this._fps - 5) / 55;
        this._fpsSlider.connect('value-changed', (_s, val) => {
            if (this._syncingUi) return;
            this._fps = Math.round(5 + val * 55);
            this._fpsVal.set_text(`${this._fps} FPS · ${Math.round(1000 / this._fps)}ms`);
            const nowMs = GLib.get_monotonic_time() / 1000;
            if (nowMs - this._lastFpsSentMs >= 60) {
                this._lastFpsSentMs = nowMs;
                this._send({ cmd: 'fps', value: this._fps });
            }
        });
        this._fpsSlider.connect('released', (_s, val) => {
            if (this._syncingUi) return;
            this._fps = Math.round(5 + val * 55);
            this._fpsVal.set_text(`${this._fps} FPS · ${Math.round(1000 / this._fps)}ms`);
            this._send({ cmd: 'fps', value: this._fps });
        });
        this._fpsRow.append(this._fpsSlider);
        this._fpsVal = label(`${this._fps} FPS · ${Math.round(1000 / this._fps)}ms`, 'isle-lights-value', { halign: Gtk.Align.END });
        this._fpsVal.set_xalign(1);
        this._fpsRow.append(this._fpsVal);
        this._fpsRow.set_opacity(this._mode === 'static' ? 0.45 : 1.0);
        slidersCard.append(this._fpsRow);

        root.append(slidersCard);
        this.append(root);
    }

    _setMode(mode) {
        this._mode = mode;
        this._powerOn = true;
        this._updatePowerBtn();

        for (const [id, b] of Object.entries(this._modeBtns)) {
            b.set_css_classes(['isle-output-chip', id === mode ? 'active' : 'idle']);
        }
        this._staticBox.set_visible(mode === 'static');
        this._musicBox.set_visible(mode === 'music');
        this._screenBox.set_visible(mode === 'screen');
        this._fpsRow.set_opacity(mode === 'static' ? 0.45 : 1.0);

        if (mode === 'static') {
            this._send({ cmd: 'static', temp: 3500 });
        } else if (mode === 'music') {
            this._send({ cmd: 'music', theme: this._musicTheme, source: this._musicSource });
        } else if (mode === 'screen') {
            this._send({ cmd: 'screen', region: this._screenRegion });
        }
    }
});
