// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Usage & System telemetry page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/usage.js with system telemetry support.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { icon, label } from '../widgets.js';
import { Page } from '../page.js';
import { getTelemetryMonitor, getBatteryTelemetry, sampleNetworkThroughput } from '../telemetry.js';

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
            spacing: 8,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-usage-content'],
        });
        this.append(this._card);

        this.watch(['usage', 'system'], () => this._update());
        this._update();

        this._monitor = getTelemetryMonitor();
        this._monitorHandler = this._monitor.connect('updated', () => this._updateLiveTelemetry());
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
            css_classes: ['isle-usage-mark'],
            valign: Gtk.Align.CENTER,
        });
        head.append(mark);

        const nameLbl = label('System Telemetry', 'isle-usage-name');
        head.append(nameLbl);

        const daemonBadge = label('isled connected', 'isle-usage-plan');
        head.append(daemonBadge);

        const netName = system.network?.connected
            ? (system.network?.name || system.network?.connection || 'Connected')
            : 'Offline';
        const stampLbl = label(`Network: ${netName}`, 'isle-usage-stamp', {
            hexpand: true,
            halign: Gtk.Align.END,
        });
        head.append(stampLbl);
        this._card.append(head);

        // Metric Rows
        const limits = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            css_classes: ['isle-usage-limits'],
        });

        // 1. Battery Telemetry (from System1 + UPower)
        const battery = system.battery;
        const batInfo = getBatteryTelemetry(battery);
        if (batInfo) {
            const { row, descLbl, track } = this._buildTelemetryRow('Battery', batInfo.fullText, batInfo.percent / 100);
            this._batteryDescLbl = descLbl;
            this._batteryTrack = track;
            limits.append(row);
        } else {
            this._batteryDescLbl = null;
            this._batteryTrack = null;
        }

        // 2. Network Activity (from System1 + /proc/net/dev)
        const net = system.network;
        const netPct = net?.connected ? 1.0 : 0.0;
        const netSpeed = sampleNetworkThroughput();
        const netDesc = net?.connected ? netSpeed.formatted : 'Disconnected';
        const { row, descLbl, track } = this._buildTelemetryRow('Network Status', netDesc, netPct);
        this._netDescLbl = descLbl;
        this._netTrack = track;
        limits.append(row);

        // 3. Continuous CPU / RAM API note
        const noteRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['isle-usage-line'],
        });
        const noteLbl = label(
            'Daemon API: Usage1 monitors AI plan quotas; continuous CPU/RAM requires daemon extension',
            'isle-usage-empty',
            { hexpand: true }
        );
        noteLbl.set_halign(Gtk.Align.START);
        noteRow.append(noteLbl);
        limits.append(noteRow);

        this._card.append(limits);
    }

    _updateLiveTelemetry() {
        const system = this._system();
        if (this._batteryDescLbl) {
            const batInfo = getBatteryTelemetry(system.battery);
            if (batInfo) {
                this._batteryDescLbl.set_text(batInfo.fullText);
                if (this._batteryTrack) {
                    this._batteryTrack.set_fraction(batInfo.percent / 100);
                }
            }
        }
        if (this._netDescLbl) {
            const net = system.network;
            const netSpeed = sampleNetworkThroughput();
            const netDesc = net?.connected ? netSpeed.formatted : 'Disconnected';
            this._netDescLbl.set_text(netDesc);
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

