// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! GTK4-adapted BotIcon widget for Isle XFCE.
//! Faithful port of upstream botIcon.js using authentic Cairo character rendering and badges.

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { Bot } from './bot.js';

/** How long (ms) a gesture plays; the icon is still again after it. */
const GESTURE_MS = 750;
/** It settles into its pose over this much (s) of its own time, drawn once. */
const SETTLE_S = 0.7;
/** While at work it blinks and glances this often (ms): alive, at a few frames every few seconds. */
const ALIVE_MS = 2600;

/** The bot drawn small, with an optional status badge. */
export const BotIcon = GObject.registerClass({
    GTypeName: 'IsleGtkBotIcon',
}, class BotIcon extends Gtk.DrawingArea {
    /** `size` in CSS pixels; with `body` (CSS pixels) its body is that big, against the box's end. */
    _init(size = 24, look = {}, { body = 0 } = {}) {
        super._init({
            hexpand: false,
            vexpand: false,
            css_classes: ['isle-bot-icon'],
        });
        this._size = size;
        this._body = body;
        this.set_content_width(size);
        this.set_content_height(size);

        this._bot = new Bot(look);
        this._bot.holdEyes();
        this._badge = null;
        this._settle();
        this._aliveTimer = 0;
        this._animTimer = 0;
        this._glance = { x: 0.12, y: 0.06 };

        this.set_draw_func((area, cr, width, height) => this._paint(cr, width, height));
    }

    /** {shape, palette} from Settings (see bot.js). */
    set look({ shape, palette }) {
        this._bot.palette = palette;
        this._bot.setShape(shape);
        this._settle();
        this.queue_draw();
    }

    /** attentive by default; also success, error, asking… (see Bot.setForm). */
    set form(form) {
        this._bot.setForm(form);
        this._settle();
        this.queue_draw();
    }

    /** The corner badge: {color: [r, g, b], glyph: '!' | 'check' | 'cross'}, or null. */
    set badge(badge) {
        this._badge = badge;
        this.queue_draw();
    }

    /** While true, it blinks and looks about every few seconds, holding still in between. */
    set alive(alive) {
        if (Boolean(this._aliveTimer) === alive)
            return;
        if (this._aliveTimer) {
            GLib.source_remove(this._aliveTimer);
            this._aliveTimer = 0;
        }
        if (alive) {
            this._aliveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ALIVE_MS, () => {
                this._glance = { x: Math.random() * 1.2 - 0.6, y: Math.random() * 0.6 - 0.2 };
                this.play(null, 420);
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    /** Plays a hop, nod or shake once (or just a blink and a glance), then holds still again. */
    play(gesture, duration = GESTURE_MS) {
        if (this._animTimer) {
            GLib.source_remove(this._animTimer);
            this._animTimer = 0;
        }
        const from = this._bot.time;
        if (gesture)
            this._bot.gesture(gesture);
        else
            this._bot.blink();

        const start = GLib.get_monotonic_time();
        const durationUs = duration * 1000;

        this._animTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const elapsedUs = GLib.get_monotonic_time() - start;
            const progress = Math.min(1.0, elapsedUs / durationUs);
            this._bot.step(from + (progress * duration) / 1000, this._look());
            this.queue_draw();
            if (progress >= 1.0) {
                this._animTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Where its eyes turn: a random glance, picked while it is alive. */
    _look() {
        return this._glance;
    }

    // Runs its own clock on, without drawing, until the new shape and expression have taken over.
    _settle() {
        const from = this._bot.time;
        for (let t = 1 / 30; t <= SETTLE_S; t += 1 / 30)
            this._bot.step(from + t, this._look());
    }

    /** Another size (and body size), in CSS pixels. */
    resize(size, body = this._body) {
        this._size = size;
        this._body = body;
        this.set_content_width(size);
        this.set_content_height(size);
        this.queue_draw();
    }

    /** Draws the bot, then the badge on top. */
    _paint(cr, width, height) {
        const size = Math.min(width, height);
        if (this._body) {
            const bounds = this._bot.bounds(size);
            const scale = this._body / Math.max(bounds.width, bounds.height);
            cr.translate(size - bounds.width * scale, Math.round((size - bounds.height * scale) / 2));
            cr.scale(scale, scale);
            cr.translate(-bounds.x, -bounds.y);
        }
        this._bot.paint(cr, size);
        if (this._badge)
            this._paintBadge(cr, 1);
    }

    // A small disc on the top left corner in the badge's colour, ringed so it stands off the body.
    _paintBadge(cr, scale) {
        const r = Math.max(4, this._size * 0.17) * scale;
        const x = r + 0.5 * scale, y = r + 0.5 * scale;
        cr.arc(x, y, r + 1.5 * scale, 0, 2 * Math.PI);
        cr.setSourceRGBA(0x1c / 255, 0x1c / 255, 0x1e / 255, 1);
        cr.fill();
        cr.arc(x, y, r, 0, 2 * Math.PI);
        cr.setSourceRGBA(...this._badge.color, 1);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(Math.max(1.4 * scale, r * 0.32));
        cr.setLineCap(Cairo.LineCap.ROUND);
        const s = r * 0.42;
        switch (this._badge.glyph) {
        case '!':
            cr.moveTo(x, y - s * 1.1);
            cr.lineTo(x, y + s * 0.25);
            cr.stroke();
            cr.arc(x, y + s * 1.05, cr.getLineWidth() * 0.55, 0, 2 * Math.PI);
            cr.fill();
            break;
        case 'check':
            cr.moveTo(x - s, y + s * 0.05);
            cr.lineTo(x - s * 0.25, y + s * 0.8);
            cr.lineTo(x + s * 1.05, y - s * 0.7);
            cr.stroke();
            break;
        case 'cross':
            cr.moveTo(x - s * 0.8, y - s * 0.8);
            cr.lineTo(x + s * 0.8, y + s * 0.8);
            cr.moveTo(x + s * 0.8, y - s * 0.8);
            cr.lineTo(x - s * 0.8, y + s * 0.8);
            cr.stroke();
            break;
        }
    }
});

