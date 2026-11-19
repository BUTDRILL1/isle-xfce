// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Usage & System telemetry page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/usage.js with system telemetry support.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { icon, iconButton, label, pillButton } from '../widgets.js';
import { Page } from '../page.js';
import {
    getTelemetryMonitor,
    getBatteryTelemetry,
    sampleNetworkThroughput,
    sampleCpuUsage,
    getMemoryUsage,
    getCpuTemp,
    getDiskUsage,
    getPowerProfile,
    setPowerProfile,
} from '../telemetry.js';

const ACCENTS = {
    claude: '#d97857',
    codex: '#0fa47f',
    grok: '#eeeeee',
};
const FALLBACK_ACCENT = '#3b82f6';

export const UsagePage = GObject.registerClass({
    GTypeName: 'IsleGtkUsagePage',
}, class UsagePage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'usage',
            height,
        });

        this._card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            hexpand: true,
            vexpand: false,
            valign: Gtk.Align.START,
            css_classes: ['isle-usage-content'],
        });
        this.append(this._card);

        this.watch(['usage', 'system'], () => this._update());
        this._update();

        this._monitor = getTelemetryMonitor();
        this._monitorHandler = this._monitor.connect('updated', () => this._updateLiveTelemetry());
        this._powerHandler = this._monitor.connect('power-changed', () => {
            this._powerProfile = getPowerProfile();
            this._applyPowerStyle(this._powerProfile);
        });
        this.connect('map', () => this._updateLiveTelemetry());
    }

    getDesiredHeight() {
        return 245;
    }

    _providers() {
        return this.daemon?.state?.usage?.providers ?? [];
    }

    _system() {
        return this.daemon?.state?.system ?? {};
    }

    _update() {
        // Clear card children
        let child = this._card.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._card.remove(child);
            child = next;
        }

        const providers = this._providers();
        const system = this._system();

        if (providers.length > 0) {
            // Render first provider's card (e.g. Claude / Codex)
            this._renderProvider(providers[0]);
        } else {
            // Render System Telemetry & Diagnostic state (Wi-Fi, Battery, isled status)
            this._renderSystemTelemetry(system);
        }
    }

    _renderProvider(provider) {
        const accent = ACCENTS[provider.id] || FALLBACK_ACCENT;

        // Head
        const head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-usage-head'],
        });

        const mark = new Gtk.Box({
            css_classes: ['isle-usage-mark'],
            valign: Gtk.Align.CENTER,
        });
        head.append(mark);

        const nameLbl = label(provider.name, 'isle-usage-name');
        head.append(nameLbl);

        if (provider.plan) {
            const planLbl = label(provider.plan, 'isle-usage-plan');
            head.append(planLbl);
        }

        const stampLbl = label('Active', 'isle-usage-stamp', {
            hexpand: true,
            halign: Gtk.Align.END,
        });
        head.append(stampLbl);
        this._card.append(head);

        // Limits
        const limits = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            css_classes: ['isle-usage-limits'],
        });

        const windows = provider.windows || [];
        for (const w of windows.slice(0, 3)) {
            limits.append(this._buildLimitRow(w, accent));
        }

        if (windows.length === 0) {
            const emptyLbl = label(provider.empty || 'No limits reported yet', 'isle-usage-empty');
            limits.append(emptyLbl);
        }

        this._card.append(limits);
    }

    _buildLimitRow({ label: name, percent, resets_at_ms }, accent) {
        const used = Math.max(0, Math.min(100, percent || 0));
        const limitBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            css_classes: ['isle-usage-limit'],
        });

        const line = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['isle-usage-line'],
        });

        const titleLbl = label(name || 'Limit', 'isle-usage-window', { hexpand: true });
        titleLbl.set_ellipsize(Pango.EllipsizeMode.END);
        titleLbl.set_halign(Gtk.Align.START);
        line.append(titleLbl);

        const pctLbl = label(`${Math.round(used)}%`, 'isle-usage-percent', { halign: Gtk.Align.END });
        line.append(pctLbl);
        limitBox.append(line);

        // Progress Bar track
        const track = new Gtk.ProgressBar({
            fraction: used / 100,
            hexpand: true,
            css_classes: ['isle-usage-track'],
        });
        limitBox.append(track);

        return limitBox;
    }

    _renderSystemTelemetry(system) {
        // Head
        const head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-usage-head'],
        });

        const mark = new Gtk.Box({
            css_classes: ['isle-usage-mark', 'isle-usage-mark-live'],
            valign: Gtk.Align.CENTER,
        });
        head.append(mark);

        const nameLbl = label('System Telemetry', 'isle-usage-name');
        head.append(nameLbl);

        const netName = system.network?.connected
            ? (system.network?.name || system.network?.connection || 'Connected')
            : 'Offline';
        this._netStampLbl = label(netName, 'isle-usage-stamp', {
            hexpand: true,
            halign: Gtk.Align.END,
        });
        head.append(this._netStampLbl);
        this._card.append(head);

        // 2-Column Telemetry Grid
        const grid = new Gtk.Grid({
            column_homogeneous: true,
            column_spacing: 14,
            row_spacing: 10,
            hexpand: true,
            css_classes: ['isle-usage-grid'],
        });

        // 1. CPU Usage
        const cpuPct = sampleCpuUsage();
        const cpuItem = this._buildTelemetryRow('CPU', `${Math.round(cpuPct)}%`, cpuPct / 100);
        this._cpuDescLbl = cpuItem.descLbl;
        this._cpuTrack = cpuItem.track;
        this._applyLoadClass(this._cpuTrack, cpuPct);
        grid.attach(cpuItem.row, 0, 0, 1, 1);

        // 2. Memory Usage
        const mem = getMemoryUsage();
        const memDesc = mem ? `${mem.usedGb.toFixed(1)} / ${mem.totalGb.toFixed(1)} GiB` : 'N/A';
        const memPct = mem ? mem.pct : 0;
        const memItem = this._buildTelemetryRow('Memory', memDesc, memPct / 100);
        this._memDescLbl = memItem.descLbl;
        this._memTrack = memItem.track;
        this._applyLoadClass(this._memTrack, memPct);
        grid.attach(memItem.row, 1, 0, 1, 1);

        // 3. CPU Thermal
        const tempC = getCpuTemp();
        const tempDesc = tempC !== null ? `${tempC}°C` : 'N/A';
        const tempPct = tempC !== null ? Math.min(100, Math.max(0, tempC)) : 0;
        const tempItem = this._buildTelemetryRow('Thermal', tempDesc, tempPct / 100);
        this._tempDescLbl = tempItem.descLbl;
        this._tempTrack = tempItem.track;
        this._applyLoadClass(this._tempTrack, tempPct, 68, 84);
        grid.attach(tempItem.row, 0, 1, 1, 1);

        // 4. Root Disk
        const disk = getDiskUsage();
        const diskDesc = disk ? `${disk.freeGb.toFixed(1)} GiB free` : 'N/A';
        const diskPct = disk ? disk.pct : 0;
        const diskItem = this._buildTelemetryRow('Disk /', diskDesc, diskPct / 100);
        this._diskDescLbl = diskItem.descLbl;
        this._diskTrack = diskItem.track;
        this._applyLoadClass(this._diskTrack, diskPct, 75, 90);
        grid.attach(diskItem.row, 1, 1, 1, 1);

        // 5. Battery
        const batInfo = getBatteryTelemetry(system.battery);
        if (batInfo) {
            const batItem = this._buildTelemetryRow('Battery', batInfo.fullText, batInfo.percent / 100);
            this._batteryDescLbl = batItem.descLbl;
            this._batteryTrack = batItem.track;
            this._applyBatteryClass(this._batteryTrack, batInfo.percent);
            grid.attach(batItem.row, 0, 2, 1, 1);
        } else {
            const acItem = this._buildTelemetryRow('Power', 'AC Connected', 1.0);
            this._batteryDescLbl = acItem.descLbl;
            this._batteryTrack = acItem.track;
            this._applyBatteryClass(this._batteryTrack, 100);
            grid.attach(acItem.row, 0, 2, 1, 1);
        }

        // 6. Network Activity
        const net = system.network;
        const netSpeed = sampleNetworkThroughput();
        const netDesc = net?.connected ? `↓ ${netSpeed.downSpeedStr} · ↑ ${netSpeed.upSpeedStr}` : 'Disconnected';
        const totalBps = (netSpeed.rxBytesSec || 0) + (netSpeed.txBytesSec || 0);
        // Scale log-like up to ~10 MB/s for visual activity bar
        const netFrac = net?.connected ? Math.min(1, Math.max(0.06, Math.log10(1 + totalBps / 1024) / 4)) : 0;
        const netItem = this._buildTelemetryRow('Network', netDesc, netFrac);
        this._netDescLbl = netItem.descLbl;
        this._netTrack = netItem.track;
        grid.attach(netItem.row, 1, 2, 1, 1);

        this._card.append(grid);

        // Power Profile Segmented Selector Row
        this._powerProfile = getPowerProfile();
        const powerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-power-row'],
        });
        const powerTitle = label('Power Profile', 'isle-usage-window', { hexpand: true, halign: Gtk.Align.START });
        powerRow.append(powerTitle);

        const segBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-power-seg'],
        });
        this._powerPills = {};
        const profiles = [
            { id: 'power-saver', iconName: 'isle-power-saver-symbolic', tip: 'Power Saver (Boost Off, GPU Low)', cls: 'isle-power-saver' },
            { id: 'balanced', iconName: 'isle-power-balanced-symbolic', tip: 'Balanced', cls: 'isle-power-balanced' },
            { id: 'performance', iconName: 'isle-power-perf-symbolic', tip: 'Performance', cls: 'isle-power-perf' },
            { id: 'lightning', iconName: 'isle-power-lightning-symbolic', tip: 'Lightning (Max CPU/GPU)', cls: 'isle-power-lightning' },
        ];
        for (const p of profiles) {
            const btn = iconButton(p.iconName, `isle-power-icon-btn ${p.cls}`, () => {
                this._selectPowerProfile(p.id);
            }, { size: 15, accessibleName: p.tip });
            btn.set_tooltip_text(p.tip);
            this._powerPills[p.id] = btn;
            segBox.append(btn);
        }
        powerRow.append(segBox);
        this._card.append(powerRow);
        this._applyPowerStyle(this._powerProfile);
    }

    _applyPowerStyle(profile) {
        if (!this._powerPills) return;
        for (const [id, btn] of Object.entries(this._powerPills)) {
            if (id === profile) {
                btn.add_css_class('active');
            } else {
                btn.remove_css_class('active');
            }
        }
    }

    _selectPowerProfile(next) {
        this._powerProfile = next;
        this._applyPowerStyle(next);
        globalThis.islePowerProfile = next;
        if (globalThis.isleSaveSettings) globalThis.isleSaveSettings();
        setPowerProfile(next, actual => {
            this._powerProfile = actual;
            this._applyPowerStyle(actual);
            if (actual && actual !== globalThis.islePowerProfile) {
                globalThis.islePowerProfile = actual;
                if (globalThis.isleSaveSettings) globalThis.isleSaveSettings();
            }
        });
    }

    _applyLoadClass(track, pct, warn = 70, crit = 88) {
        if (!track) return;
        track.remove_css_class('ok');
        track.remove_css_class('warn');
        track.remove_css_class('crit');
        if (pct >= crit) track.add_css_class('crit');
        else if (pct >= warn) track.add_css_class('warn');
        else track.add_css_class('ok');
    }

    _applyBatteryClass(track, pct) {
        if (!track) return;
        track.remove_css_class('ok');
        track.remove_css_class('warn');
        track.remove_css_class('crit');
        if (pct <= 15) track.add_css_class('crit');
        else if (pct <= 30) track.add_css_class('warn');
        else track.add_css_class('ok');
    }

    _updateLiveTelemetry() {
        if (!this.get_mapped()) return;
        const system = this._system();
        if (this._cpuDescLbl) {
            const cpuPct = sampleCpuUsage();
            this._cpuDescLbl.set_text(`${Math.round(cpuPct)}%`);
            this._cpuTrack?.set_fraction(cpuPct / 100);
            this._applyLoadClass(this._cpuTrack, cpuPct);
        }
        if (this._memDescLbl) {
            const mem = getMemoryUsage();
            if (mem) {
                this._memDescLbl.set_text(`${mem.usedGb.toFixed(1)} / ${mem.totalGb.toFixed(1)} GiB`);
                this._memTrack?.set_fraction(mem.pct / 100);
                this._applyLoadClass(this._memTrack, mem.pct);
            }
        }
        if (this._tempDescLbl) {
            const tempC = getCpuTemp();
            if (tempC !== null) {
                this._tempDescLbl.set_text(`${tempC}°C`);
                this._tempTrack?.set_fraction(Math.min(1, Math.max(0, tempC / 100)));
                this._applyLoadClass(this._tempTrack, tempC, 68, 84);
            }
        }
        if (this._diskDescLbl) {
            const disk = getDiskUsage();
            if (disk) {
                this._diskDescLbl.set_text(`${disk.freeGb.toFixed(1)} GiB free`);
                this._diskTrack?.set_fraction(disk.pct / 100);
                this._applyLoadClass(this._diskTrack, disk.pct, 75, 90);
            }
        }
        if (this._batteryDescLbl) {
            const batInfo = getBatteryTelemetry(system.battery);
            if (batInfo) {
                this._batteryDescLbl.set_text(batInfo.fullText);
                this._batteryTrack?.set_fraction(batInfo.percent / 100);
                this._applyBatteryClass(this._batteryTrack, batInfo.percent);
            }
        }
        if (this._netDescLbl) {
            const net = system.network;
            const netSpeed = sampleNetworkThroughput();
            const netDesc = net?.connected ? `↓ ${netSpeed.downSpeedStr} · ↑ ${netSpeed.upSpeedStr}` : 'Disconnected';
            const totalBps = (netSpeed.rxBytesSec || 0) + (netSpeed.txBytesSec || 0);
            const netFrac = net?.connected ? Math.min(1, Math.max(0.06, Math.log10(1 + totalBps / 1024) / 4)) : 0;
            this._netDescLbl.set_text(netDesc);
            this._netTrack?.set_fraction(netFrac);
        }
    }

    _buildTelemetryRow(name, desc, fraction) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            css_classes: ['isle-usage-limit'],
        });

        const line = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['isle-usage-line'],
        });

        const titleLbl = label(name, 'isle-usage-window', { hexpand: true });
        titleLbl.set_halign(Gtk.Align.START);
        line.append(titleLbl);

        const descLbl = label(desc, 'isle-usage-percent', { halign: Gtk.Align.END });
        line.append(descLbl);
        row.append(line);

        const track = new Gtk.ProgressBar({
            fraction: Math.max(0, Math.min(1, fraction)),
            hexpand: true,
            css_classes: ['isle-usage-track'],
        });
        row.append(track);

        return { row, descLbl, track };
    }
});

