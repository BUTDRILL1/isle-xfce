// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! GTK4-adapted design system widgets for Isle XFCE.
//! Preserves original upstream Cairo drawings, proportions, and stylesheet classes.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { Bot } from 'file:///home/butarch/Desktop/isle-upstream/gnome-extension/src/bot.js';
import * as Theme from 'file:///home/butarch/Desktop/isle-upstream/gnome-extension/src/theme.js';

const ICONS_DIR = '/home/butarch/Desktop/isle-upstream/gnome-extension/icons';

// ── Icons ─────────────────────────────────────────────────────────────

/** GNOME's icons that Isle draws itself (icons/), in one rounded, even-weight style. */
const OWN_ICONS = {
    'audio-volume-muted': 'isle-speaker-off-symbolic',
    'audio-volume-low': 'isle-speaker-1-symbolic',
    'audio-volume-medium': 'isle-speaker-2-symbolic',
    'audio-volume-high': 'isle-speaker-3-symbolic',
    'audio-volume-overamplified': 'isle-speaker-3-symbolic',
    'audio-speakers': 'isle-speaker-device-symbolic',
    'audio-card': 'isle-speaker-2-symbolic',
    'audio-headphones': 'isle-headphones-symbolic',
    'audio-headset': 'isle-headphones-symbolic',
    'display-brightness': 'isle-sun-symbolic',
    'keyboard-brightness': 'isle-sun-min-symbolic',
    'microphone-sensitivity-muted': 'isle-mic-off-symbolic',
    'microphone-disabled': 'isle-mic-off-symbolic',
    'microphone-hardware-disabled': 'isle-mic-off-symbolic',
    'microphone-sensitivity': 'isle-mic-symbolic',
    'audio-input-microphone': 'isle-mic-symbolic',
    'touchpad-disabled': 'isle-touchpad-off-symbolic',
    'input-touchpad': 'isle-touchpad-symbolic',
    'airplane-mode': 'isle-airplane-symbolic',
    'camera-disabled': 'isle-video-off-symbolic',
    'camera-hardware-disabled': 'isle-video-off-symbolic',
    'camera': 'isle-video-symbolic',
    'bluetooth-disabled': 'isle-bluetooth-off-symbolic',
    'bluetooth-hardware-disabled': 'isle-bluetooth-off-symbolic',
    'bluetooth': 'isle-bluetooth-symbolic',
    'network-wireless-disabled': 'isle-wifi-off-symbolic',
    'network-wireless-offline': 'isle-wifi-off-symbolic',
    'network-wireless-hardware-disabled': 'isle-wifi-off-symbolic',
    'network-wireless': 'isle-wifi-symbolic',
    'video-display': 'isle-display-symbolic',
    'input-mouse': 'isle-mouse-symbolic',
    'input-keyboard': 'isle-keyboard-symbolic',
    'phone': 'isle-phone-symbolic',
    'input-gaming': 'isle-gamepad-symbolic',
    'input-tablet': 'isle-tablet-symbolic',
    'computer': 'isle-laptop-symbolic',
    'dialog-warning': 'isle-warning-symbolic',
    'dialog-information': 'isle-info-symbolic',
    'software-update-available': 'isle-update-symbolic',
    'media-record': 'isle-record-symbolic',
};
const OWN_KEYS = Object.keys(OWN_ICONS).sort((a, b) => b.length - a.length);
const OTHER_STATE = /(^|-)(disabled|muted|off|offline|disconnected|none|no-route|acquiring|error|blocked)(-|$)/;

export function ownName(name) {
    if (!name) return null;
    const base = name.replace(/-symbolic$/, '');
    const key = OWN_KEYS.find(k => base === k ||
        (base.startsWith(`${k}-`) && !OTHER_STATE.test(base.slice(k.length + 1))));
    return key ? OWN_ICONS[key] : null;
}

export function hasOwnIcon(name) {
    const filename = name.endsWith('.svg') ? name : `${name}.svg`;
    return GLib.file_test(`${ICONS_DIR}/${filename}`, GLib.FileTest.EXISTS);
}

export function deviceIcon(name) {
    return hasOwnIcon(name) ? name : 'isle-bluetooth-symbolic';
}

export const LOW_BATTERY = 20;

export function ownIcon(gicon) {
    const names = gicon instanceof Gio.ThemedIcon ? gicon.get_names() : [];
    const own = names.map(ownName).find(Boolean);
    return own ? icon(own) : gicon;
}

const iconCache = new Map();

/** Creates a GIcon for a bundled Isle SVG icon or system icon. */
export function icon(name) {
    const resolved = ownName(name) ?? name;
    if (iconCache.has(resolved)) {
        return iconCache.get(resolved);
    }
    const filename = resolved.endsWith('.svg') ? resolved : `${resolved}.svg`;
    const path = `${ICONS_DIR}/${filename}`;
    let gicon;
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(path) });
    } else {
        gicon = new Gio.ThemedIcon({ name: resolved });
    }
    iconCache.set(resolved, gicon);
    return gicon;
}

export function isSymbolic(gicon) {
    if (gicon instanceof Gio.ThemedIcon) {
        const [name] = gicon.get_names();
        return Boolean(name && name.endsWith('-symbolic'));
    }
    if (gicon instanceof Gio.FileIcon) {
        return Boolean(gicon.get_file().get_basename()?.includes('-symbolic'));
    }
    return false;
}

// ── Typography and Labels ─────────────────────────────────────────────

/** Creates a styled GTK4 Label. */
export function label(text, styleClass = '', props = {}) {
    const classes = styleClass ? styleClass.split(' ').filter(Boolean) : [];
    return new Gtk.Label({
        label: text,
        css_classes: classes,
        valign: Gtk.Align.CENTER,
        ...props,
    });
}

/** Wraps a label over lines with WORD_CHAR and no hyphens. */
export function wrapLines(lbl, ellipsize = Pango.EllipsizeMode.NONE) {
    lbl.set_wrap(true);
    lbl.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    lbl.set_ellipsize(ellipsize);
    const attrList = new Pango.AttrList();
    attrList.insert(Pango.attr_insert_hyphens_new(false));
    lbl.set_attributes(attrList);
}

/** Static version for unchanging text. */
export function wrapFixedLines(lbl, ellipsize = Pango.EllipsizeMode.NONE) {
    lbl.set_wrap(true);
    lbl.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    lbl.set_ellipsize(ellipsize);
    lbl.set_markup(`<span insert_hyphens="false">${GLib.markup_escape_text(lbl.get_text() || '', -1)}</span>`);
}

/** Its wrapping, ellipsizing label bin no taller than `lines` lines. */
export const Lines = GObject.registerClass({
    GTypeName: 'IsleGtkLines',
}, class Lines extends Gtk.Box {
    _init(child, lines = 2, props = {}) {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            ...props,
        });
        this._lines = lines;
        this._child = child;
        if (child) {
            if (child instanceof Gtk.Label) {
                child.set_wrap(true);
                child.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
                child.set_lines(lines);
                child.set_ellipsize(Pango.EllipsizeMode.END);
            }
            this.append(child);
        }
    }

    get child() { return this._child; }
    get lines() { return this._lines; }
    set lines(v) {
        this._lines = v;
        if (this._child instanceof Gtk.Label) {
            this._child.set_lines(v);
        }
    }
});

// ── Buttons and Controls ──────────────────────────────────────────────

/** A pill-shaped text button. */
export function pillButton(text, styleClass = '', onClick = null) {
    const classes = ['isle-pill', ...styleClass.split(' ').filter(Boolean)];
    const button = new Gtk.Button({
        label: text,
        css_classes: classes,
        valign: Gtk.Align.CENTER,
        can_focus: true,
    });
    if (onClick) {
        button.connect('clicked', () => onClick());
    }
    return button;
}

/** A round icon button. */
export function iconButton(iconName, styleClass = '', onClick = null, { size = 16, accessibleName = '' } = {}) {
    const classes = ['isle-button', ...styleClass.split(' ').filter(Boolean)];
    const img = new Gtk.Image({
        gicon: icon(iconName),
        pixel_size: size,
    });
    const button = new Gtk.Button({
        child: img,
        css_classes: classes,
        valign: Gtk.Align.CENTER,
        can_focus: true,
    });
    if (accessibleName) {
        button.set_tooltip_text(accessibleName);
    }
    if (onClick) {
        button.connect('clicked', () => onClick());
    }
    button._img = img;
    return button;
}

/** A small × over the top-left corner of an alert icon. */
export function cornerClose(onClick, { out = 8 } = {}) {
    const button = iconButton('isle-close-symbolic', 'isle-corner-close', onClick, { size: 8, accessibleName: 'Close' });
    button.set_valign(Gtk.Align.START);
    button.set_halign(Gtk.Align.START);
    button.set_opacity(0.0);
    button.set_sensitive(false);
    button.set_can_focus(false);
    button.set_margin_start(-out);
    button.set_margin_top(-out);
    return button;
}

/** Fades a `cornerClose` × in or out. */
export function revealClose(button, shown) {
    if (shown === Boolean(button._shown)) return;
    button._shown = shown;
    button.set_sensitive(shown);
    button.set_can_focus(shown);
    if (shown) {
        button.add_css_class('shown');
        button.set_opacity(1.0);
    } else {
        button.remove_css_class('shown');
        button.set_opacity(0.0);
    }
}

/** Enables or disables a button; disabled ones stay in place, dimmed. */
export function setEnabled(button, enabled) {
    button._isleDisabled = !enabled;
    button.set_sensitive(enabled);
    button.set_can_focus(enabled);
    button.set_opacity(enabled ? 1.0 : 0.38);
}

export function restsAt(actor, property, value) {
    return actor[property] === value;
}

export function setButtonIcon(button, iconName) {
    if (button._img) {
        button._img.set_from_gicon(icon(iconName));
    } else if (button.get_child() instanceof Gtk.Image) {
        button.get_child().set_from_gicon(icon(iconName));
    }
}

export function fence(box) {
    const start = new Gtk.Box();
    const end = new Gtk.Box();
    box.prepend(start);
    box.append(end);
    return end;
}

export function scrollSideways(scroll, event) {
    // Handled natively in GTK4 ScrolledWindow
    return false;
}

// ── Cairo Progress Ring ───────────────────────────────────────────────

export const Ring = GObject.registerClass({
    GTypeName: 'IsleGtkRing',
    Properties: {
        'progress': GObject.ParamSpec.double('progress', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class Ring extends Gtk.Overlay {
    _init({ size = 20, lineWidth = 2.5, color = [1, 1, 1], trackOpacity = 0.18, progress = 0, child = null } = {}) {
        super._init({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });
        this._size = size;
        this._lineWidth = lineWidth;
        this._color = color;
        this._trackOpacity = trackOpacity;
        this._progress = progress;
        this._animTimer = 0;

        this._area = new Gtk.DrawingArea({
            content_width: size,
            content_height: size,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });

        this._area.set_draw_func((area, cr, width, height) => {
            const radius = Math.min(width, height) / 2 - this._lineWidth / 2;
            const [r, g, b] = this._color;
            cr.setLineWidth(this._lineWidth);
            cr.setLineCap(1); // round

            // Faint track
            cr.setSourceRGBA(r, g, b, this._trackOpacity * 1.5);
            cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
            cr.stroke();

            // Progress arc from 12 o'clock
            if (this._progress > 0) {
                const start = -Math.PI / 2;
                cr.setSourceRGBA(r, g, b, 1.0);
                cr.arc(width / 2, height / 2, radius, start, start + this._progress * 2 * Math.PI);
                cr.stroke();
            }
        });

        this.set_child(this._area);

        if (child) {
            child.set_halign(Gtk.Align.CENTER);
            child.set_valign(Gtk.Align.CENTER);
            this.add_overlay(child);
            this._child = child;
        }
    }

    get progress() { return this._progress; }
    set progress(v) {
        const clamped = Math.min(1, Math.max(0, v));
        if (Math.abs(clamped - this._progress) < 0.001) return;
        this._progress = clamped;
        this._area.queue_draw();
        this.notify('progress');
    }

    resize(size) {
        this._size = size;
        this._area.set_content_width(size);
        this._area.set_content_height(size);
        this._area.queue_draw();
    }

    jumpTo(p) {
        if (this._animTimer) {
            GLib.source_remove(this._animTimer);
            this._animTimer = 0;
        }
        this.progress = p;
    }

    fillTo(target, { delay = 0, duration = 600 } = {}) {
        if (this._animTimer) {
            GLib.source_remove(this._animTimer);
            this._animTimer = 0;
        }
        const startVal = this._progress;
        const diff = target - startVal;
        const startTime = GLib.get_monotonic_time();

        const step = () => {
            const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000 - delay;
            if (elapsedMs < 0) return GLib.SOURCE_CONTINUE;

            const t = Math.min(1.0, elapsedMs / duration);
            // Ease out cubic
            const eased = 1.0 - Math.pow(1.0 - t, 3);
            this.progress = startVal + diff * eased;

            if (t >= 1.0) {
                this._animTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };

        this._animTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, step);
    }
});

// ── Cairo Equalizer Bars ──────────────────────────────────────────────

export const Bars = GObject.registerClass({
    GTypeName: 'IsleGtkBars',
}, class Bars extends Gtk.DrawingArea {
    _init({ height = 16, count = 4, color = [1, 1, 1] } = {}) {
        const barW = 2.5;
        const gap = 2.0;
        const totalW = count * barW + (count - 1) * gap;
        super._init({
            content_width: Math.ceil(totalW),
            content_height: height,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-bars'],
        });
        this._height = height;
        this._count = count;
        this._color = color;
        this._playing = false;
        this._timer = 0;
        this._silhouettes = [0.45, 1.0, 0.7, 0.35, 0.8];
        this._current = [0.45, 1.0, 0.7, 0.35, 0.8].slice(0, count);

        this.set_draw_func((area, cr, w, h) => {
            const [r, g, b] = this._color;
            cr.setSourceRGBA(r, g, b, 0.9);
            for (let i = 0; i < this._count; i++) {
                const scale = this._current[i] ?? 0.5;
                const bh = Math.max(2.0, h * scale);
                const bx = i * (barW + gap);
                const by = (h - bh) / 2;
                cr.rectangle(bx, by, barW, bh);
                cr.fill();
            }
        });
    }

    get playing() { return this._playing; }
    set playing(v) {
        if (this._playing === Boolean(v)) return;
        this._playing = Boolean(v);
        if (this._playing) {
            this._startAnimation();
        } else {
            this._stopAnimation();
        }
    }

    _startAnimation() {
        if (this._timer) return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._playing) {
                this._timer = 0;
                return GLib.SOURCE_REMOVE;
            }
            for (let i = 0; i < this._count; i++) {
                this._current[i] = 0.25 + Math.random() * 0.75;
            }
            this.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAnimation() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        for (let i = 0; i < this._count; i++) {
            this._current[i] = this._silhouettes[i % this._silhouettes.length];
        }
        this.queue_draw();
    }
});

// ── Assistant Bot Avatar ──────────────────────────────────────────────

export const BotIcon = GObject.registerClass({
    GTypeName: 'IsleGtkBotIcon',
}, class BotIcon extends Gtk.DrawingArea {
    _init(size = 20, look = { shape: 'cloud', color: 'cloud', glow: 'match' }) {
        super._init({
            content_width: size,
            content_height: size,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });
        this._size = size;
        this._bot = new Bot(look);
        this._bot.holdEyes();

        this.set_draw_func((area, cr, width, height) => {
            this._bot.paint(cr, Math.min(width, height));
        });
    }

    get bot() { return this._bot; }
});

// ── Privacy and Status Indicators ─────────────────────────────────────

export const PrivacyDots = GObject.registerClass({
    GTypeName: 'IsleGtkPrivacyDots',
}, class PrivacyDots extends Gtk.Box {
    _init() {
        super._init({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-privacy-dots'],
            visible: false,
        });
        this._dots = {};
        for (const kind of ['camera', 'microphone', 'screenShare', 'phone']) {
            const dot = new Gtk.Box({
                css_classes: ['isle-privacy-dot', kind],
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.CENTER,
                visible: false,
            });
            dot.set_size_request(7, 7);
            this._dots[kind] = dot;
            this.append(dot);
        }
    }

    update(privacy) {
        if (!privacy) return;
        for (const [kind, dot] of Object.entries(this._dots)) {
            const on = Boolean(privacy[kind]);
            dot.set_visible(on);
        }
        this.set_visible(Object.values(this._dots).some(dot => dot.get_visible()));
    }
});

export const RecordingDot = GObject.registerClass({
    GTypeName: 'IsleGtkRecordingDot',
}, class RecordingDot extends Gtk.Box {
    _init() {
        super._init({
            css_classes: ['isle-recording-dot'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        this._timer = 0;
        this.set_size_request(8, 8);
        this.connect('notify::mapped', () => this._breathe());
    }

    _breathe() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        this.set_opacity(1.0);
        if (!this.get_mapped()) return;

        const DOT_STEP_MS = 1000 / 30;
        const DOT_LOW = 110 / 255;
        const DOT_FADE_MS = 900;
        const start = GLib.get_monotonic_time();

        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(DOT_STEP_MS), () => {
            if (!this.get_mapped()) {
                this._timer = 0;
                return GLib.SOURCE_REMOVE;
            }
            const phase = ((GLib.get_monotonic_time() - start) / 1000 / DOT_FADE_MS) % 2;
            const t = (1 - Math.cos(Math.PI * phase)) / 2;
            this.set_opacity(1.0 - (1.0 - DOT_LOW) * t);
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }
});

// ── VolumeGlyph ───────────────────────────────────────────────────────

export const VolumeGlyph = GObject.registerClass({
    GTypeName: 'IsleGtkVolumeGlyph',
}, class VolumeGlyph extends Gtk.Overlay {
    _init({ size = 16 } = {}) {
        super._init({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-volume-glyph'],
        });
        this._size = size;
        this._body = new Gtk.Image({ gicon: icon('isle-speaker-0-symbolic'), pixel_size: size });
        this.set_child(this._body);

        this._off = new Gtk.Image({ gicon: icon('isle-speaker-off-symbolic'), pixel_size: size, opacity: 0 });
        this.add_overlay(this._off);

        this._waves = [1, 2, 3].map(n => {
            const wave = new Gtk.Image({
                gicon: icon(`isle-speaker-wave-${n}-symbolic`),
                pixel_size: size,
                opacity: 0,
            });
            this.add_overlay(wave);
            return wave;
        });

        this._count = 0;
        this._muted = false;
    }

    setLevel(level, muted, { fresh = false } = {}) {
        this._count = Math.ceil(Math.min(1, Math.max(0, level)) * 3);
        this._muted = Boolean(muted);
        this._sync(fresh);
    }

    _sync(stagger = false) {
        const shown = this._muted ? 0 : this._count;
        this._waves.forEach((wave, i) => {
            const on = i < shown;
            if (stagger && on) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 70, () => {
                    wave.set_opacity(1.0);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                wave.set_opacity(on ? 1.0 : 0.0);
            }
        });
        this._body.set_opacity(this._muted ? 0.0 : 1.0);
        this._off.set_opacity(this._muted ? 1.0 : 0.0);
    }
});

// ── LevelBar ──────────────────────────────────────────────────────────

export const LevelBar = GObject.registerClass({
    GTypeName: 'IsleGtkLevelBar',
    Properties: {
        'level': GObject.ParamSpec.double('level', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class LevelBar extends Gtk.Box {
    _init({ width = 100, styleClass = '' } = {}) {
        super._init({
            css_classes: ['isle-level', ...styleClass.split(' ').filter(Boolean)],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.START,
        });
        this._width = width;
        this._level = 0;
        this._animTimer = 0;
        this.set_size_request(width, 5);

        this._fill = new Gtk.Box({
            css_classes: ['isle-level-fill'],
            halign: Gtk.Align.START,
            valign: Gtk.Align.FILL,
        });
        this._fill.set_size_request(0, 5);
        this.append(this._fill);
    }

    get level() { return this._level; }
    set level(v) {
        this._level = Math.min(1, Math.max(0, v || 0));
        const fillW = Math.round(this._width * this._level);
        this._fill.set_size_request(fillW, 5);
        this.notify('level');
    }

    growTo(target, { delay = 0, duration = 500 } = {}) {
        if (this._animTimer) {
            GLib.source_remove(this._animTimer);
            this._animTimer = 0;
        }
        this._fill.set_size_request(0, 5);
        this._level = 0;
        const startTime = GLib.get_monotonic_time();

        this._animTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000 - delay;
            if (elapsedMs < 0) return GLib.SOURCE_CONTINUE;

            const t = Math.min(1.0, elapsedMs / duration);
            const eased = 1.0 - Math.pow(1.0 - t, 3);
            this.level = target * eased;

            if (t >= 1.0) {
                this._animTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    set fillColor(color) {
        // Can be customized via CSS or inline style
    }
});

// ── Slider ────────────────────────────────────────────────────────────

export const Slider = GObject.registerClass({
    GTypeName: 'IsleGtkSlider',
    Signals: {
        'value-changed': { param_types: [GObject.TYPE_DOUBLE] },
        'released': { param_types: [GObject.TYPE_DOUBLE] },
    },
}, class Slider extends Gtk.Overlay {
    _init({ scrollStep = 0.05 } = {}) {
        super._init({
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-slider'],
        });
        this._value = 0;
        this._scrollStep = scrollStep;
        this._dragging = false;
        this._hover = false;
        this._width = 0;

        this._track = new Gtk.Box({
            css_classes: ['isle-slider-track'],
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this.set_child(this._track);

        this._fill = new Gtk.Box({
            css_classes: ['isle-slider-fill'],
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        this.add_overlay(this._fill);

        this._knob = new Gtk.Box({
            css_classes: ['isle-slider-knob'],
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            opacity: 0,
        });
        this.add_overlay(this._knob);

        // Click gesture
        const click = new Gtk.GestureClick();
        click.connect('pressed', (g, n, x, y) => this._moveTo(x));
        click.connect('released', (g, n, x, y) => {
            this._moveTo(x);
            this.emit('released', this._value);
        });
        this.add_controller(click);

        // Drag gesture
        const drag = new Gtk.GestureDrag();
        let startX = 0;
        drag.connect('drag-begin', (g, x, y) => {
            startX = x;
            this._dragging = true;
            this._syncKnob();
            this._moveTo(x);
        });
        drag.connect('drag-update', (g, ox, oy) => {
            this._moveTo(startX + ox);
        });
        drag.connect('drag-end', (g, ox, oy) => {
            this._dragging = false;
            this._moveTo(startX + ox);
            this._syncKnob();
            this.emit('released', this._value);
        });
        this.add_controller(drag);

        // Motion hover
        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', () => {
            this._hover = true;
            this._syncKnob();
        });
        motion.connect('leave', () => {
            this._hover = false;
            this._syncKnob();
        });
        this.add_controller(motion);

        // Scroll
        const scroll = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
        });
        scroll.connect('scroll', (controller, dx, dy) => {
            if (!this._scrollStep) return false;
            const delta = -dy * this._scrollStep + dx * this._scrollStep;
            if (delta !== 0) {
                this.value = Math.min(1, Math.max(0, this._value + delta));
                this.emit('value-changed', this._value);
                this.emit('released', this._value);
                return true;
            }
            return false;
        });
        this.add_controller(scroll);

        // Layout update when allocated
        this.connect('notify::allocated', () => this._syncLayout());
    }

    get value() { return this._value; }
    set value(v) {
        if (this._dragging) return;
        this._value = Math.min(1, Math.max(0, v || 0));
        this._syncLayout();
    }

    _syncKnob() {
        const show = this._hover || this._dragging;
        this._knob.set_opacity(show ? 1.0 : 0.0);
    }

    _syncLayout() {
        const w = this.get_width();
        if (w > 0) {
            this._width = w;
            const filled = Math.round(w * this._value);
            this._fill.set_size_request(filled, 4);
            const knobW = 12;
            const margin = Math.round(Math.max(0, Math.min(w - knobW, filled - knobW / 2)));
            this._knob.set_margin_start(margin);
        }
    }

    _moveTo(x) {
        const w = this.get_width() || this._width;
        if (w > 0) {
            this._value = Math.min(1, Math.max(0, x / w));
            this._syncLayout();
            this.emit('value-changed', this._value);
        }
    }
});

// ── Cover Art ─────────────────────────────────────────────────────────

export const Art = GObject.registerClass({
    GTypeName: 'IsleGtkArt',
    Signals: {
        'shown': {},
    },
}, class Art extends Gtk.DrawingArea {
    _init({ size = 40, radius = 8 } = {}) {
        super._init({
            content_width: size,
            content_height: size,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-art'],
        });
        this._size = size;
        this._radius = radius;
        this._path = null;
        this._pixbuf = null;
        this._placeholderPixbuf = null;
        this._showsIcon = false;

        // Load placeholder isle-music icon
        const iconPath = `${ICONS_DIR}/isle-music.svg`;
        const iconSize = Math.round(size * 0.42);
        try {
            this._placeholderPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(iconPath, iconSize, iconSize, true);
        } catch (e) {
            // Placeholder fallback
        }

        this.set_draw_func((area, cr, w, h) => {
            const r = this._radius;
            // Rounded rect clipping path
            cr.newSubPath();
            cr.arc(w - r, r, r, -Math.PI / 2, 0);
            cr.arc(w - r, h - r, r, 0, Math.PI / 2);
            cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
            cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2);
            cr.closePath();
            cr.clip();

            if (this._pixbuf) {
                const pw = this._pixbuf.get_width();
                const ph = this._pixbuf.get_height();
                const px = (w - pw) / 2;
                const py = (h - ph) / 2;
                Gdk.cairo_set_source_pixbuf(cr, this._pixbuf, px, py);
                cr.paint();
            } else {
                // Background #2c2c2e
                cr.setSourceRGB(0x2c / 255, 0x2c / 255, 0x2e / 255);
                cr.paint();

                // Centered placeholder icon with opacity 0.4
                if (this._placeholderPixbuf) {
                    const pw = this._placeholderPixbuf.get_width();
                    const ph = this._placeholderPixbuf.get_height();
                    const px = (w - pw) / 2;
                    const py = (h - ph) / 2;
                    Gdk.cairo_set_source_pixbuf(cr, this._placeholderPixbuf, px, py);
                    cr.paintWithAlpha(0.4);
                }
            }
        });
    }

    get showsIcon() { return this._showsIcon; }

    resize(size, radius) {
        this._size = size;
        this._radius = radius;
        this.set_content_width(size);
        this.set_content_height(size);
        const iconSize = Math.round(size * 0.42);
        try {
            this._placeholderPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(`${ICONS_DIR}/isle-music.svg`, iconSize, iconSize, true);
        } catch (e) {}
        this.queue_draw();
    }

    setPath(path) {
        this._path = path;
        if (!path) {
            this._pixbuf = null;
            this._showsIcon = false;
            this.queue_draw();
            this.emit('shown');
            return;
        }

        try {
            this._pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, this._size, this._size, true);
            this._showsIcon = false;
        } catch (e) {
            this._pixbuf = null;
        }
        this.queue_draw();
        this.emit('shown');
    }
});

// ── Wrap Layout Helper ────────────────────────────────────────────────

export function createWrapBox(spacing = 6) {
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        row_spacing: spacing,
        column_spacing: spacing,
        max_children_per_line: 100,
        min_children_per_line: 1,
        valign: Gtk.Align.START,
        halign: Gtk.Align.START,
    });
    return flow;
}
