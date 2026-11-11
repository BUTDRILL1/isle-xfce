// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Tasks and Reminders page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/tasks.js.
//! Manages to-do lists (todo interface) and timed alarms (reminders interface).

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as Format from '../format.js';
import { icon, iconButton, label, pillButton } from '../widgets.js';
import { Page } from '../page.js';

/**
 * Parses user input for timed reminders (e.g., "in 10m call Bob", "call Bob in 1h").
 * Returns { delayMs, text } or null if normal task.
 */
function parseReminderInput(raw) {
    const str = raw.trim();
    if (!str) return null;

    // Pattern 1: (remind me )?in <num><unit> (to )?<text>
    const prefixMatch = /^(?:remind\s+me\s+)?in\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|s|sec|secs|seconds)\s+(?:to\s+)?(.+)$/i.exec(str);
    if (prefixMatch) {
        const val = parseInt(prefixMatch[1], 10);
        const unit = prefixMatch[2].toLowerCase();
        const text = prefixMatch[3].trim();
        let mult = 60000;
        if (unit.startsWith('s')) mult = 1000;
        else if (unit.startsWith('h')) mult = 3600000;
        return { delayMs: val * mult, text };
    }

    // Pattern 2: <text> in <num><unit>
    const suffixMatch = /^(.+?)\s+in\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|s|sec|secs|seconds)$/i.exec(str);
    if (suffixMatch) {
        const text = suffixMatch[1].trim();
        const val = parseInt(suffixMatch[2], 10);
        const unit = suffixMatch[3].toLowerCase();
        let mult = 60000;
        if (unit.startsWith('s')) mult = 1000;
        else if (unit.startsWith('h')) mult = 3600000;
        return { delayMs: val * mult, text };
    }

    return null;
}

export const TasksPage = GObject.registerClass({
    GTypeName: 'IsleGtkTasksPage',
}, class TasksPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'reminders',
            height,
            available: true,
        });

        this._buildUi();

        this.watch(['tasks', 'reminders'], () => this._update());
        this._update();
    }

    get available() {
        return true;
    }

    set available(_v) {
        super.available = true;
    }

    _buildUi() {
        // Main container
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-tasks-container'],
        });

        // 1. Header row
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-reminders-header'],
        });

        const titleLbl = label('Reminders', 'isle-reminders-title');
        header.append(titleLbl);

        this._countLbl = label('0', 'isle-reminders-count');
        header.append(this._countLbl);

        // Flexible spacer
        const spacer = new Gtk.Box({ hexpand: true });
        header.append(spacer);

        // Clear done pill button
        this._clearBtn = pillButton('Clear done', 'isle-button-flat isle-button-small', () => {
            this.daemon.call('todo', 'ClearDone');
        });
        this._clearBtn.set_visible(false);
        header.append(this._clearBtn);

        container.append(header);

        // 2. Input row (Entry + Add iconButton)
        const inputRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-reminder-new'],
        });

        this._entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: 'New task or reminder (e.g. in 15m Call Alice)…',
            css_classes: ['isle-entry', 'isle-reminder-field'],
            can_focus: true,
        });
        this._entry.connect('activate', () => this._add());
        inputRow.append(this._entry);

        const addBtn = iconButton('isle-plus-symbolic', 'isle-button-round isle-reminders-add', () => {
            this._add();
        }, { size: 13, accessibleName: 'Add task or reminder' });
        inputRow.append(addBtn);

        container.append(inputRow);

        // 3. Scrollable List Area
        this._scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-reminder-scroll'],
        });

        this._list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-reminder-list'],
        });

        this._scroll.set_child(this._list);
        container.append(this._scroll);

        this.append(container);
    }

    async _add() {
        const text = this._entry.get_text().trim();
        if (!text) return;
        this._entry.set_text('');

        const reminder = parseReminderInput(text);
        if (reminder) {
            await this.daemon.call('reminders', 'Add', reminder.delayMs, reminder.text);
        } else {
            await this.daemon.call('todo', 'Add', text);
        }
    }

    _tasks() {
        return this.daemon?.state?.tasks ?? [];
    }

    _reminders() {
        return this.daemon?.state?.reminders ?? [];
    }

    _update() {
        // Clear list contents
        let child = this._list.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._list.remove(child);
            child = next;
        }

        const tasks = this._tasks();
        const reminders = this._reminders();

        const openTasks = tasks.filter(t => !t.done);
        const openCount = openTasks.length + reminders.length;
        this._countLbl.set_text(String(openCount));

        const hasDone = tasks.some(t => t.done);
        this._clearBtn.set_visible(hasDone);

        // Empty state check
        if (tasks.length === 0 && reminders.length === 0) {
            const emptyLbl = label('No reminders', 'isle-reminders-empty', {
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
                hexpand: true,
                vexpand: true,
            });
            this._list.append(emptyLbl);
            return;
        }

        // 1. Render active reminders section
        if (reminders.length > 0) {
            const remSec = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
                css_classes: ['isle-reminders-section'],
            });

            for (const rem of reminders) {
                remSec.append(this._buildReminderRow(rem));
            }
            this._list.append(remSec);
        }

        // 2. Render to-do tasks
        if (tasks.length > 0) {
            const taskSec = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
                css_classes: ['isle-tasks-section'],
            });

            for (const task of tasks) {
                taskSec.append(this._buildTaskRow(task));
            }
            this._list.append(taskSec);
        } else if (reminders.length === 0 && tasks.length > 0 && tasks.every(t => t.done)) {
            const allDoneLbl = label('All done', 'isle-reminders-empty', {
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            this._list.append(allDoneLbl);
        }
    }

    _buildReminderRow(rem) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-reminder', 'isle-timed-reminder'],
        });

        // Alarm icon
        const bellImg = new Gtk.Image({
            gicon: icon('isle-bell'),
            pixel_size: 14,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-reminder-alarm-icon'],
        });
        row.append(bellImg);

        // Reminder text
        const textLbl = label(rem.text, 'isle-reminder-title', {
            hexpand: true,
            halign: Gtk.Align.START,
        });
        textLbl.set_ellipsize(Pango.EllipsizeMode.END);
        row.append(textLbl);

        // Due time countdown badge
        const remainingMs = Math.max(0, (rem.due_ms || 0) - Format.nowMs());
        const dueText = remainingMs > 0 ? `in ${Format.hoursMinutes(remainingMs)}` : 'Due now';
        const dueLbl = label(dueText, 'isle-reminder-due', {
            valign: Gtk.Align.CENTER,
        });
        row.append(dueLbl);

        // Dismiss button
        const dismissBtn = iconButton('isle-close-symbolic', 'isle-button-flat isle-reminder-remove', () => {
            this.daemon.call('reminders', 'Dismiss', rem.id);
        }, { size: 10, accessibleName: 'Dismiss reminder' });
        row.append(dismissBtn);

        return row;
    }

    _buildTaskRow(task) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-reminder'],
        });

        // Checkbox button
        const checkBtn = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-reminder-check', ...(task.done ? ['checked'] : ['faint'])],
            can_focus: true,
        });

        if (task.done) {
            const checkImg = new Gtk.Image({
                gicon: icon('isle-check-symbolic'),
                pixel_size: 10,
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.CENTER,
            });
            checkBtn.set_child(checkImg);
        } else {
            const emptyDot = new Gtk.Box({
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.CENTER,
            });
            emptyDot.set_size_request(8, 8);
            checkBtn.set_child(emptyDot);
        }

        checkBtn.connect('clicked', () => {
            this.daemon.call('todo', 'SetDone', task.id, !task.done);
        });
        row.append(checkBtn);

        // Title container
        const titleLbl = label('', 'isle-reminder-title', {
            hexpand: true,
            halign: Gtk.Align.START,
        });
        titleLbl.set_ellipsize(Pango.EllipsizeMode.END);

        if (task.done) {
            titleLbl.add_css_class('done');
            titleLbl.set_markup(`<span strikethrough="true">${GLib.markup_escape_text(task.title || '', -1)}</span>`);
        } else {
            titleLbl.set_text(task.title || '');
        }
        row.append(titleLbl);

        // Delete button
        const removeBtn = iconButton('isle-close-symbolic', 'isle-button-flat isle-reminder-remove', () => {
            this.daemon.call('todo', 'Remove', task.id);
        }, { size: 10, accessibleName: 'Delete task' });
        row.append(removeBtn);

        return row;
    }
});
