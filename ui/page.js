// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Base Page container for Isle XFCE expanded view.
//! Faithful port of upstream gnome-extension/src/pages/page.js.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { icon, label } from './widgets.js';

export const Page = GObject.registerClass({
    GTypeName: 'IsleGtkPage',
    Signals: {
        'request-keyboard': { param_types: [GObject.TYPE_BOOLEAN] },
        'width-changed': {},
        'height-changed': {},
        'tint-changed': {},
        'tint-motion': { param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
        'request-close': {},
        'news-changed': {},
        'availability-changed': {},
        'cold': {},
    },
}, class Page extends Gtk.Box {
    _init(daemon, { name = '', height = 150, available = true, emptyInfo = null, ...params } = {}) {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['isle-page', `isle-${name}`],
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            halign: Gtk.Align.FILL,
            ...params,
        });
        this.name = name;
        this.daemon = daemon;
        this._pageHeight = height;
        this._available = available;
        this._hasNews = false;
        this._active = false;
        this.cold = true;
        this._timeouts = new Map();
        this._kept = new Set();
        this._daemonHandlers = [];

        // Build authentic upstream isle-empty view if provided
        if (emptyInfo) {
            this._empty = this._buildEmpty(emptyInfo);
            this.append(this._empty);
        }
    }

    _buildEmpty({ iconName, iconSize = 24, title, hint }) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-empty'],
        });

        const img = new Gtk.Image({
            gicon: icon(iconName),
            pixel_size: iconSize,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-empty-icon'],
        });
        box.append(img);

        const titleLbl = label(title, 'isle-empty-title', {
            halign: Gtk.Align.CENTER,
        });
        box.append(titleLbl);

        if (hint) {
            const hintLbl = label(hint, 'isle-empty-hint', {
                halign: Gtk.Align.CENTER,
            });
            box.append(hintLbl);
        }

        return box;
    }

    get pageHeight() { return this._pageHeight; }
    set pageHeight(h) {
        if (h === this._pageHeight) return;
        this._pageHeight = h;
        this.onPageHeight(h);
    }

    onPageHeight(h) {}

    setActive(active) {
        if (active === this._active) return;
        this._active = active;
        if (active) {
            this.onActivate();
        } else {
            this.onDeactivate();
            for (const name of [...this._timeouts.keys()]) {
                if (!this._kept.has(name)) this.cancel(name);
            }
        }
    }

    get active() { return this._active; }
    get available() { return Boolean(this._available); }
    set available(v) {
        if (Boolean(this._available) === Boolean(v)) return;
        this._available = Boolean(v);
        this.emit('availability-changed');
    }

    get hasNews() { return Boolean(this._hasNews); }
    set hasNews(v) {
        if (Boolean(this._hasNews) === Boolean(v)) return;
        this._hasNews = Boolean(v);
        this.emit('news-changed');
    }

    get preferredWidth() { return null; }
    get tint() { return null; }
    get tintStyle() { return 'wash'; }

    uncover(past) {}
    onActivate() {}
    onDeactivate() {}
    warmUp() {}
    coolDown() {}
    get warmsOpen() { return false; }

    markCold({ force = false } = {}) {
        if (this.cold || (this.get_mapped() && !force)) return;
        this.cold = true;
        if (this.available) this.emit('cold');
    }

    watch(keys, callback) {
        if (!this.daemon) return;
        this._daemonHandlers.push(this.daemon.connect('changed', (_daemon, key) => {
            if (keys.includes(key)) {
                callback();
                this.markCold();
            }
        }));
    }

    later(name, ms, callback, { keep = false } = {}) {
        this.cancel(name);
        if (keep) this._kept.add(name);
        else this._kept.delete(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
            this._timeouts.delete(name);
            this._kept.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(name, id);
    }

    cancel(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
        this._kept.delete(name);
    }

    cancelAll() {
        for (const name of [...this._timeouts.keys()]) this.cancel(name);
    }
});

