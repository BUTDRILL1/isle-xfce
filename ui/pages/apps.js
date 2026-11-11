// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! App Usage & Screen Time page for Isle XFCE GTK4 runtime.
//! Displays application screen time with proportion bars, period switching, and fallback to running apps.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as Format from '../format.js';
import { icon, label } from '../widgets.js';
import { Page } from '../page.js';

const PERIODS = [
    { name: 'today', label: 'Today' },
    { name: 'week', label: '7 days' },
    { name: 'month', label: '30 days' },
];

const IGNORE_PROCESSES = new Set([
    'systemd', 'kthreadd', 'Xorg', 'picom', 'wireplumber', 'pipewire',
    'dbus-daemon', 'upowerd', 'polkitd', 'bash', 'ps', 'grep', 'sh',
    'sleep', 'cat', 'awk', 'sed', 'xfwm4', 'isled', 'isle-ui',
]);

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

async function queryRunningApps() {
    const stdout = await runCommandAsync(['ps', '-eo', 'comm,time', '--sort=-time']);
    if (!stdout) return [];

    const appMap = new Map();
    const lines = stdout.split('\n').slice(1);

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const [comm, timeStr] = parts;
        if (comm.startsWith('[') || IGNORE_PROCESSES.has(comm)) continue;

        // Parse [[dd-]hh:]mm:ss
        const m = timeStr.match(/(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)/);
        if (!m) continue;
        const d = parseInt(m[1] || '0', 10);
        const h = parseInt(m[2] || '0', 10);
        const mi = parseInt(m[3] || '0', 10);
        const s = parseInt(m[4] || '0', 10);
        const totalSec = s + mi * 60 + h * 3600 + d * 86400;

        if (totalSec > 0) {
            const ms = totalSec * 1000;
            const current = appMap.get(comm);
            if (current) {
                current.ms += ms;
            } else {
                const displayName = comm.charAt(0).toUpperCase() + comm.slice(1);
                appMap.set(comm, { id: comm, name: displayName, ms });
            }
        }
    }

    return Array.from(appMap.values()).sort((a, b) => b.ms - a.ms).slice(0, 15);
}

export const AppsPage = GObject.registerClass({
    GTypeName: 'IsleGtkAppsPage',
}, class AppsPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'apps',
            height,
            available: true,
        });

        this._period = 'today';
        this._buttons = new Map();
        this._items = [];

        this._buildUi();

        this.watch(['appUsage'], () => this._update());
        this._update();
    }

    get available() {
        return true;
    }

    onActivate() {
        this._update();
    }

    _buildUi() {
        // Header Row
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            hexpand: true,
            css_classes: ['isle-apps-bar'],
        });

        const heading = label('App Usage', 'isle-apps-heading');
        bar.append(heading);

        this._totalLbl = label('', 'isle-apps-total', {
            hexpand: true,
            halign: Gtk.Align.START,
        });
        bar.append(this._totalLbl);

        // Period switcher buttons
        const toggle = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            css_classes: ['isle-segmented', 'isle-apps-toggle'],
        });

        for (const { name, label: text } of PERIODS) {
            const btn = new Gtk.Button({
                label: text,
                css_classes: ['isle-segment'],
                can_focus: true,
            });
            if (name === this._period) {
                btn.add_css_class('is-active');
            }
            btn.connect('clicked', () => this._setPeriod(name));
            this._buttons.set(name, btn);
            toggle.append(btn);
        }
        bar.append(toggle);
        this.append(bar);

        // Scrollable list of apps
        this._scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-apps-scroll'],
        });

        this._list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-apps-list'],
        });

        this._scroll.set_child(this._list);
        this.append(this._scroll);
    }

    _setPeriod(name) {
        if (this._period === name) return;
        this._period = name;

        for (const [pName, btn] of this._buttons.entries()) {
            if (pName === name) {
                btn.add_css_class('is-active');
            } else {
                btn.remove_css_class('is-active');
            }
        }

        this._update();
    }

    async _update() {
        const appUsage = this.daemon?.state?.appUsage;
        let stats = null;

        if (appUsage) {
            if (Array.isArray(appUsage[this._period])) {
                stats = appUsage[this._period];
            } else if (Array.isArray(appUsage)) {
                stats = appUsage;
            }
        }

        if (!stats || stats.length === 0) {
            // Fallback to active desktop running apps
            stats = await queryRunningApps();
        }

        this._items = stats || [];
        this._renderList();
    }

    _renderList() {
        // Clear existing list items
        let child = this._list.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._list.remove(child);
            child = next;
        }

        if (this._items.length === 0) {
            this._totalLbl.set_text('');
            const emptyLbl = label('No app usage recorded yet', 'isle-device-none', {
                halign: Gtk.Align.CENTER,
                margin_top: 24,
            });
            this._list.append(emptyLbl);
            return;
        }

        const totalMs = this._items.reduce((acc, app) => acc + (app.ms || 0), 0);
        this._totalLbl.set_text(`Total ${Format.hoursMinutes(totalMs)}`);

        const maxMs = Math.max(...this._items.map(a => a.ms || 0), 1);

        for (const app of this._items) {
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 10,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                css_classes: ['isle-apps-row'],
            });

            // App Icon
            const iconImg = new Gtk.Image({
                gicon: icon(app.id || 'application-x-executable'),
                pixel_size: 20,
                valign: Gtk.Align.CENTER,
            });
            row.append(iconImg);

            // App Name
            const nameLbl = label(app.name || app.id || 'App', 'isle-apps-name', {
                min_width_chars: 10,
                halign: Gtk.Align.START,
            });
            nameLbl.set_ellipsize(Pango.EllipsizeMode.END);
            row.append(nameLbl);

            // Usage Bar (Track & Fill)
            const track = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                css_classes: ['isle-apps-track'],
            });

            const share = Math.min(1.0, Math.max(0, (app.ms || 0) / maxMs));
            const fillW = Math.max(4, Math.round(140 * share));

            const fill = new Gtk.Box({
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.START,
                css_classes: ['isle-apps-fill'],
            });
            fill.set_size_request(fillW, 4);
            track.append(fill);
            row.append(track);

            // Time label
            const timeLbl = label(Format.hoursMinutes(app.ms || 0), 'isle-apps-time', {
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.END,
            });
            row.append(timeLbl);

            this._list.append(row);
        }
    }
});
