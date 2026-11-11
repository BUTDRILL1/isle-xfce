// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! GTK4-adapted Chat and Command Approval Card for Isle XFCE.
//! Faithful port of upstream chat.js with authentic styling, shell syntax highlighting,
//! markdown rendering, and interactive command approval workflow.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { BotIcon } from './botIcon.js';
import * as Format from './format.js';
import { icon, iconButton } from './widgets.js';

/** The little face beside its answers, in CSS pixels. */
const FACE_SIZE = 18;
/** Messages this far apart (ms) get the time between them. */
const TIME_GAP_MS = 5 * 60000;
/** A bubble of yours is at most this wide; longer ones wrap. */
const BUBBLE_MAX = 420;

/** What a risk badge says, and its icon (see `risksOf` in isled). */
export const RISKS = {
    removes: ['isle-trash', 'Removes files or apps'],
    internet: ['isle-link', 'Runs a script from the web'],
    root: ['isle-lock-symbolic', 'Needs your password'],
};

export const STATUS = {
    done: ['isle-check-symbolic', 'Done', 'isle-card-done'],
    failed: ['isle-close-symbolic', 'Failed', 'isle-card-failed'],
    denied: ['isle-close-symbolic', 'Denied', 'isle-card-denied'],
    stopped: ['isle-stop-symbolic', 'Stopped', 'isle-card-denied'],
};

// Helper: standard Isle label
export const label = (text, styleClass, params = {}) => {
    const l = new Gtk.Label({
        label: text,
        css_classes: styleClass ? styleClass.split(' ') : [],
        ...params,
    });
    return l;
};

/** How long (ms) "Copied" shows in place of the conversation's title. */
const COPIED_MS = 1200;
/** Run and Deny take no press this soon after the card shows. */
const ARMED_AFTER_MS = 500;
// Package manager stop confirmation window
const STOP_ARMED_MS = 4000;
const INSTALLER = /(^|[\s;&|(])(apt|apt-get|aptitude|dpkg|dnf|yum|rpm|pacman|zypper|flatpak|snap)\s/;

/** Puts text on clipboard. */
function copy(text) {
    try {
        const display = Gdk.Display.get_default();
        if (display) {
            display.get_clipboard().set(text);
        }
    } catch (_) {}
}

// A command copy button
function copyButton(child, command, copied) {
    const button = new Gtk.Button({
        child,
        css_classes: ['isle-copy-button', 'isle-button-flat'],
        hexpand: true,
    });
    button.connect('clicked', () => {
        copy(command());
        if (copied) copied();
    });
    return button;
}

/** m:ss for an elapsed time in seconds. */
export const elapsed = seconds =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// Animated Sweep line for active running commands
export const Sweep = GObject.registerClass({
    GTypeName: 'IsleGtkSweep',
}, class Sweep extends Gtk.DrawingArea {
    _init() {
        super._init({
            hexpand: true,
            css_classes: ['isle-card-sweep'],
        });
        this.set_content_height(3);
        this._time = 0;
        this.set_draw_func((area, cr, width, height) => this._paint(cr, width, height));
    }

    tick(time) {
        this._time = time;
        this.queue_draw();
    }

    _paint(cr, width, height) {
        const r = height / 2;
        cr.newSubPath();
        cr.arc(r, r, r, Math.PI / 2, 1.5 * Math.PI);
        cr.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
        cr.closePath();
        cr.setSourceRGBA(1, 1, 1, 0.1);
        cr.fillPreserve();

        const at = (this._time * 0.55) % 1.4 - 0.2;
        const light = new Cairo.LinearGradient(0, 0, width, 0);
        for (const [offset, alpha] of [[at - 0.22, 0], [at, 0.85], [at + 0.22, 0]]) {
            light.addColorStopRGBA(Math.max(0, Math.min(1, offset)), 1, 1, 1, alpha);
        }
        cr.setSource(light);
        cr.fill();
    }
});

/** An answer's light Markdown as Pango markup. */
export function answerMarkup(text) {
    if (!text) return '';
    return text.replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\s]+\)/g, '$1').split('\n').map(line => {
        const bullet = /^\s*[-*•]\s+/;
        const listed = bullet.test(line);
        const body = (listed ? line.replace(bullet, '') : line).split(/(`[^`]+`)/).map((part, i) => i % 2
            ? `<span font_family="monospace" background="#ffffff" bgalpha="12%">${GLib.markup_escape_text(part.slice(1, -1), -1)}</span>`
            : GLib.markup_escape_text(part, -1).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')).join('');
        return listed ? `  •  ${body}` : body;
    }).join('\n');
}

/** Shell syntax highlighting colors matching upstream. */
const SHELL = {
    prompt: ['#ffffff', 45],
    root: ['#ffb340', 100],
    program: ['#ffffff', 100],
    flag: ['#ffffff', 52],
    quoted: ['#64d2ff', 100],
    joiner: ['#ff6482', 100],
    word: ['#ffffff', 86],
};

const span = ([color, alpha], text, bold = false) =>
    `<span foreground="${color}" fgalpha="${alpha}%"${bold ? ' weight="bold"' : ''}>${text}</span>`;
const JOINERS = new Set(['|', '||', '&&', ';', '>', '>>', '<', '2>&1']);

/** Shell command syntax highlighter. */
export function shellMarkup(command) {
    if (!command) return '';
    let first = true;
    const words = command.split(/(\s+)/).map(word => {
        if (/^\s+$/.test(word) || !word)
            return word;
        const text = GLib.markup_escape_text(word, -1);
        let color = SHELL.word;
        if (JOINERS.has(word)) {
            color = SHELL.joiner;
            first = true;
        } else if (word === 'sudo' || word === 'pkexec') {
            color = SHELL.root;
        } else if (first) {
            color = SHELL.program;
            first = false;
        } else if (word.startsWith('-')) {
            color = SHELL.flag;
        } else if (/^["']|:\/\//.test(word)) {
            color = SHELL.quoted;
        }
        return span(color, text, color === SHELL.program);
    });
    return `${span(SHELL.prompt, '$')} ${words.join('')}`;
}

/** Risk row with badge icon and description. */
function riskRow(risk, iconName, text) {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        css_classes: ['isle-card-risk', `isle-card-risk-${risk}`],
    });
    const img = new Gtk.Image({ gicon: icon(iconName), pixel_size: 12, valign: Gtk.Align.CENTER });
    row.append(img);
    const l = label(text, 'isle-card-risk-text');
    l.set_valign(Gtk.Align.CENTER);
    row.append(l);
    return row;
}

/** Action button with optional keyboard badge (e.g. Run ⏎, Deny esc). */
function keyButton(text, key, styleClass, onClick) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 4,
        css_classes: ['isle-card-button-box'],
    });
    const name = label(text, 'isle-card-button-label');
    name.set_valign(Gtk.Align.CENTER);
    box.append(name);

    if (key) {
        const cap = label(key, 'isle-card-key');
        cap.set_valign(Gtk.Align.CENTER);
        box.append(cap);
    }

    const button = new Gtk.Button({
        child: box,
        css_classes: ['isle-pill', 'isle-pill-small', 'isle-card-button', ...styleClass.split(' ')],
        valign: Gtk.Align.CENTER,
    });
    button.connect('clicked', () => onClick());
    button._nameLabel = name;
    return button;
}

// ── Command Approval Card ─────────────────────────────────────────────

export const CommandCard = GObject.registerClass({
    GTypeName: 'IsleGtkCommandCard',
    Signals: {
        'decided': { param_types: [GObject.TYPE_BOOLEAN] },
        'stop': {},
    },
}, class CommandCard extends Gtk.Box {
    _init() {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['isle-card'],
            hexpand: true,
        });

        // 1. Head: why & details
        this._head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['isle-card-head'],
        });
        const titles = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this._title = label('', 'isle-card-title');
        this._title.set_ellipsize(Pango.EllipsizeMode.END);
        this._title.set_halign(Gtk.Align.START);
        this._subtitle = label('', 'isle-card-subtitle');
        this._subtitle.set_ellipsize(Pango.EllipsizeMode.END);
        this._subtitle.set_halign(Gtk.Align.START);
        titles.append(this._title);
        titles.append(this._subtitle);
        this._head.append(titles);
        this.append(this._head);

        // 2. Terminal: command, status, output, sweep
        this._terminal = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            css_classes: ['isle-card-terminal'],
        });
        const line = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['isle-card-line'],
        });
        this._command = label('', 'isle-card-command');
        this._command.set_use_markup(true);
        this._command.set_wrap(true);
        this._command.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._command.set_halign(Gtk.Align.START);
        line.append(copyButton(this._command, () => this._commandText, () => this._flashCopied()));

        this._status = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            css_classes: ['isle-card-status'],
            valign: Gtk.Align.CENTER,
        });
        this._statusIcon = new Gtk.Image({ pixel_size: 11 });
        this._statusText = label('', 'isle-card-status-text');
        this._status.append(this._statusIcon);
        this._status.append(this._statusText);
        line.append(this._status);
        this._terminal.append(line);

        this._output = label('', 'isle-card-output');
        this._output.set_ellipsize(Pango.EllipsizeMode.END);
        this._output.set_halign(Gtk.Align.START);
        this._terminal.append(this._output);

        this._sweep = new Sweep();
        this._terminal.append(this._sweep);
        this.append(this._terminal);

        // 3. Foot: risks on left, Deny and Run on right
        this._foot = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            css_classes: ['isle-card-foot'],
            valign: Gtk.Align.CENTER,
        });
        this._risks = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        this._foot.append(this._risks);

        this._stopButton = keyButton('Stop', null, 'isle-card-ghost', () => this._stop());
        this._deny = keyButton('Deny', 'esc', 'isle-card-ghost', () => this.decide(false));
        this._run = keyButton('Run', '↩', 'isle-card-run', () => this.decide(true));

        this._foot.append(this._stopButton);
        this._foot.append(this._deny);
        this._foot.append(this._run);
        this.append(this._foot);

        this._state = null;
        this._id = null;
        this._waitingSince = 0;
        this._stopArmed = 0;
        this._copiedTimer = 0;
    }

    setCard(card) {
        if (!card) {
            this.set_visible(false);
            return;
        }
        this.set_visible(true);

        const previous = card.id === this._id ? this._state : null;
        this._id = card.id;
        this._state = card.status;
        if (card.status === 'waiting' && previous !== 'waiting')
            this._waitingSince = GLib.get_monotonic_time();

        const waiting = card.status === 'waiting';
        const running = card.status === 'running';
        const ended = !waiting && !running;

        this._title.set_label(card.why || 'Approval required');
        this._subtitle.set_label(waiting ? (card.detail || '') : running ? `Running · ${elapsed(card.seconds || 0)}` : '');
        this._subtitle.set_visible(Boolean(this._subtitle.get_label()));

        this._command.set_markup(shellMarkup(card.command || ''));
        this._commandText = card.command || '';

        // Clear and rebuild risks
        while (this._risks.get_first_child()) {
            this._risks.remove(this._risks.get_first_child());
        }

        if (!running) this._disarmStop();

        if (running && this._stopArmed) {
            this._risks.append(riskRow('removes', 'isle-warning-symbolic', 'May leave it half installed'));
        } else if (waiting) {
            const risk = Object.keys(RISKS).find(k => card.risks?.includes(k));
            if (risk) {
                this._risks.append(riskRow(risk, ...RISKS[risk]));
            }
        }

        const lines = (card.output || '').split('\n').map(l => l.trimEnd()).filter(Boolean);
        this._output.set_label(running ? lines.slice(-2).join('\n') : card.status === 'failed' ? (lines.at(-1) || '') : '');
        this._output.set_visible(Boolean(this._output.get_label()));

        this._sweep.set_visible(running);
        this._head.set_visible(!ended);

        const [iconName, text, styleClass] = STATUS[card.status] || [null, '', ''];
        this._status.set_visible(ended);
        if (ended) {
            if (iconName) this._statusIcon.set_from_gicon(icon(iconName));
            const done = card.status === 'done' && (card.seconds || 0) >= 1 ? elapsed(card.seconds) : null;
            this._statusText.set_label(done || text);
        }

        this._foot.set_visible(waiting || running);
        this._deny.set_visible(waiting);
        this._run.set_visible(waiting);
        this._stopButton.set_visible(running);

        if (ended) {
            this.add_css_class('isle-card-ended');
            this.set_opacity(card.status === 'denied' || card.status === 'stopped' ? 0.65 : 1.0);
        } else {
            this.remove_css_class('isle-card-ended');
            this.set_opacity(1.0);
        }
    }

    get status() {
        return this._state;
    }

    _stop() {
        if (this._stopArmed || !INSTALLER.test(` ${this._commandText || ''}`)) {
            this._disarmStop();
            this.emit('stop');
            return;
        }
        this._stopArmed = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STOP_ARMED_MS, () => {
            this._stopArmed = 0;
            this._showStop(false);
            return GLib.SOURCE_REMOVE;
        });
        this._showStop(true);
    }

    _disarmStop() {
        if (this._stopArmed) {
            GLib.source_remove(this._stopArmed);
            this._stopArmed = 0;
        }
        this._showStop(false);
    }

    _showStop(armed) {
        if (this._stopButton._nameLabel)
            this._stopButton._nameLabel.set_label(armed ? 'Stop anyway' : 'Stop');
        while (this._risks.get_first_child()) {
            this._risks.remove(this._risks.get_first_child());
        }
        if (armed)
            this._risks.append(riskRow('removes', 'isle-warning-symbolic', 'May leave it half installed'));
    }

    _flashCopied() {
        const target = this._head.get_visible() ? this._subtitle : this._statusText;
        const shown = target.get_label();
        target.set_label('Copied');
        target.add_css_class('isle-card-copied');
        if (this._copiedTimer) GLib.source_remove(this._copiedTimer);
        this._copiedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED_MS, () => {
            this._copiedTimer = 0;
            target.set_label(shown);
            target.remove_css_class('isle-card-copied');
            return GLib.SOURCE_REMOVE;
        });
    }

    tick(time) {
        if (this._sweep.get_visible())
            this._sweep.tick(time);
    }

    decide(run) {
        if (this._state !== 'waiting' || GLib.get_monotonic_time() - this._waitingSince < ARMED_AFTER_MS * 1000)
            return;
        this.emit('decided', run);
    }
});

// ── Conversation History View ─────────────────────────────────────────

export const ChatView = GObject.registerClass({
    GTypeName: 'IsleGtkChatView',
    Signals: {
        'new-chat': {},
        'close': {},
        'settled': {},
        'copied': {},
    },
}, class ChatView extends Gtk.Box {
    _init() {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            css_classes: ['isle-chat'],
            hexpand: true,
            vexpand: true,
        });

        // Scrollable message list
        this._list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            css_classes: ['isle-chat-list'],
            hexpand: true,
            valign: Gtk.Align.FILL,
        });

        this._scroll = new Gtk.ScrolledWindow({
            css_classes: ['isle-chat-scroll'],
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            child: this._list,
        });
        this.append(this._scroll);

        // Keep scrolled to bottom whenever contents change or layout reflows
        const vadj = this._scroll.get_vadjustment();
        if (vadj) {
            vadj.connect('notify::upper', () => {
                this._scrollToBottom();
            });
        }

        this._items = [];
        this._look = { shape: 'circle' };
    }

    _scrollToBottom() {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const adj = this._scroll?.get_vadjustment();
            if (adj) {
                const target = Math.max(0, adj.get_upper() - adj.get_page_size());
                adj.set_value(target);
            }
            return GLib.SOURCE_REMOVE;
        });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const adj = this._scroll?.get_vadjustment();
            if (adj) {
                const target = Math.max(0, adj.get_upper() - adj.get_page_size());
                adj.set_value(target);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    set look(look) {
        this._look = look;
        this.setItems(this._items);
    }

    setItems(items) {
        this._items = items || [];
        while (this._list.get_first_child()) {
            this._list.remove(this._list.get_first_child());
        }

        let last = null;
        this._items.forEach(item => {
            if (item.at && (!last?.at || item.at - last.at > TIME_GAP_MS)) {
                const dt = GLib.DateTime.new_from_unix_local(Math.floor(item.at / 1000));
                const timeLabel = label(Format.timeOfDay(dt), 'isle-chat-time');
                timeLabel.set_halign(Gtk.Align.CENTER);
                this._list.append(timeLabel);
            }
            const row = this._row(item, last?.role !== 'assistant');
            this._list.append(row);
            last = item;
        });

        this._scrollToBottom();
    }

    get count() {
        return this._items.length;
    }

    _row(item, withFace) {
        if (item.role === 'user') {
            const bubble = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                css_classes: ['isle-chat-user'],
                halign: Gtk.Align.END,
                valign: Gtk.Align.START,
            });
            const text = label(item.text || '', 'isle-chat-user-text');
            text.set_wrap(true);
            text.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
            text.set_width_chars(1);
            text.set_max_width_chars(48);
            text.set_xalign(0.0);
            text.set_selectable(true);
            bubble.append(text);
            return bubble;
        }

        if (item.role === 'command') {
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                css_classes: ['isle-chat-command'],
                hexpand: true,
                halign: Gtk.Align.FILL,
            });
            const spacer = new Gtk.Box({ width_request: FACE_SIZE });
            row.append(spacer);

            const command = label('', 'isle-chat-command-text');
            command.set_markup(shellMarkup(item.command || ''));
            command.set_ellipsize(Pango.EllipsizeMode.END);
            command.set_hexpand(true);
            command.set_halign(Gtk.Align.START);
            row.append(copyButton(command, () => item.command || '', () => this._copied()));

            const [iconName, text, styleClass] = STATUS[item.status] || ['isle-terminal-symbolic', '', ''];
            if (text) {
                const status = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 4,
                    css_classes: ['isle-card-status', 'isle-chat-command-status', ...styleClass.split(' ')],
                    valign: Gtk.Align.CENTER,
                });
                const img = new Gtk.Image({ gicon: icon(iconName), pixel_size: 10, valign: Gtk.Align.CENTER });
                status.append(img);
                const l = label(text, 'isle-card-status-text');
                l.set_valign(Gtk.Align.CENTER);
                status.append(l);
                row.append(status);
            }
            return row;
        }

        // Assistant reply row: multiline message rendering with automatic text wrapping
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            css_classes: ['isle-chat-reply-row'],
            hexpand: true,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.START,
        });

        if (withFace && this._look) {
            const face = new BotIcon(FACE_SIZE, this._look);
            face.set_valign(Gtk.Align.START);
            row.append(face);
        } else {
            const spacer = new Gtk.Box({ width_request: FACE_SIZE });
            row.append(spacer);
        }

        const text = label('', 'isle-chat-reply');
        text.set_use_markup(true);
        text.set_wrap(true);
        text.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
        text.set_width_chars(1);
        text.set_max_width_chars(64);
        try {
            text.set_markup(answerMarkup(item.text || ''));
        } catch (_) {
            text.set_text(item.text || '');
        }
        text.set_hexpand(true);
        text.set_halign(Gtk.Align.FILL);
        text.set_xalign(0.0);
        text.set_yalign(0.0);
        text.set_selectable(true);
        row.append(text);

        return row;
    }

    _copied() {
        this.emit('copied');
    }
});
