// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Notifications page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/notifications.js.
//! Displays incoming desktop notifications, DND controls, action triggers, and dismissal.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as Format from '../format.js';
import { icon, iconButton, label, pillButton, setButtonIcon } from '../widgets.js';
import { Page } from '../page.js';

const MAX_ACTIONS = 3;

/** Small app icon or symbolic glyph for notification */
function notificationBadge(notification) {
    const box = new Gtk.Box({
        valign: Gtk.Align.START,
        halign: Gtk.Align.CENTER,
        css_classes: ['isle-notification-glyph'],
    });
    box.set_size_request(24, 24);

    let image = null;
    const iconNameOrPath = notification.appIcon ||
        (notification.hints && notification.hints['desktop-entry'] ? notification.hints['desktop-entry'].deep_unpack() : '') ||
        '';

    if (iconNameOrPath && iconNameOrPath.startsWith('/') && GLib.file_test(iconNameOrPath, GLib.FileTest.EXISTS)) {
        image = Gtk.Image.new_from_file(iconNameOrPath);
        image.set_pixel_size(20);
    } else if (iconNameOrPath) {
        const gic = icon(iconNameOrPath);
        image = new Gtk.Image({ gicon: gic, pixel_size: 20 });
    }

    if (!image) {
        image = new Gtk.Image({ gicon: icon('isle-bell'), pixel_size: 16 });
    }

    image.set_valign(Gtk.Align.CENTER);
    image.set_halign(Gtk.Align.CENTER);
    box.append(image);
    return box;
}

export const NotificationsPage = GObject.registerClass({
    GTypeName: 'IsleGtkNotificationsPage',
}, class NotificationsPage extends Page {
    _init(daemon, center, { height = 240 } = {}) {
        super._init(daemon, {
            name: 'notifications',
            height,
            available: true,
        });

        this._center = center;
        this._times = [];

        this._buildUi();

        this._centerHandlers = [
            center.connect('changed', () => this._update()),
            center.connect('updated', () => this._update()),
            center.connect('seen-changed', () => this.emit('news-changed')),
            center.connect('dnd-changed', () => this._updateDnd()),
        ];

        this._updateDnd();
        this._update();
    }

    get relevant() {
        return this._center ? this._center.hasUnseen : false;
    }

    get hasNews() {
        return this._center ? this._center.hasUnseen : false;
    }

    _buildUi() {
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-notifications-container'],
        });

        // Top Bar: Heading + DND toggle + Clear button
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            css_classes: ['isle-notifications-bar'],
        });

        const heading = label('Notifications', 'isle-notifications-heading', {
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        bar.append(heading);

        this._dndButton = iconButton('isle-bell', 'isle-button-round isle-button-small isle-dnd-toggle', () => {
            this._center.dnd = !this._center.dnd;
        }, { size: 13, accessibleName: 'Do Not Disturb' });
        this._dndButton.set_valign(Gtk.Align.CENTER);
        bar.append(this._dndButton);

        this._clearButton = pillButton('Clear', 'isle-pill-small isle-notifications-clear', () => {
            this._center.clearAll();
        });
        this._clearButton.set_valign(Gtk.Align.CENTER);
        bar.append(this._clearButton);

        container.append(bar);

        // DND Note
        this._dndNote = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            css_classes: ['isle-notifications-dnd-note'],
            visible: false,
        });
        const moonIcon = new Gtk.Image({
            gicon: icon('isle-moon'),
            pixel_size: 11,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-dnd-moon'],
        });
        moonIcon.set_opacity(0.65);
        this._dndNote.append(moonIcon);

        const dndText = label('Do Not Disturb: new ones wait here; urgent ones still show', 'isle-notifications-dnd-text', {
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        dndText.set_ellipsize(Pango.EllipsizeMode.END);
        this._dndNote.append(dndText);
        container.append(this._dndNote);

        // Content Area: Empty State vs Scrolled Card List
        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 150,
            hexpand: true,
            vexpand: true,
        });

        // Empty State
        const emptyBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 6,
            css_classes: ['isle-empty'],
        });
        const emptyIcon = new Gtk.Image({
            gicon: icon('isle-bell'),
            pixel_size: 24,
            css_classes: ['isle-empty-icon'],
            halign: Gtk.Align.CENTER,
        });
        emptyBox.append(emptyIcon);
        emptyBox.append(label('No notifications', 'isle-empty-title', { halign: Gtk.Align.CENTER }));
        emptyBox.append(label('You’re all caught up', 'isle-empty-hint', { halign: Gtk.Align.CENTER }));
        this._stack.add_named(emptyBox, 'empty');

        // Scrolled List
        this._list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            css_classes: ['isle-notification-list'],
        });

        this._scroll = new Gtk.ScrolledWindow({
            css_classes: ['isle-task-scroll'],
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });
        this._scroll.set_child(this._list);
        this._stack.add_named(this._scroll, 'list');

        container.append(this._stack);
        this.append(container);
    }

    _updateDnd() {
        const on = this._center.dnd;
        if (on) {
            this._dndButton.add_css_class('checked');
        } else {
            this._dndButton.remove_css_class('checked');
        }
        setButtonIcon(this._dndButton, on ? 'isle-moon' : 'isle-bell');
        this._dndNote.set_visible(on);
    }

    _update() {
        this._times = [];
        const notifications = this._center.notifications;
        this._clearButton.set_visible(notifications.length > 0);

        // Remove old rows
        let child = this._list.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._list.remove(child);
            child = next;
        }

        if (notifications.length === 0) {
            this._stack.set_visible_child_name('empty');
            return;
        }

        for (const n of notifications) {
            this._list.append(this._buildRow(n));
        }
        this._stack.set_visible_child_name('list');
    }

    _buildRow(notification) {
        const row = new Gtk.Button({
            css_classes: ['isle-notification-row'],
            hexpand: true,
            can_focus: true,
        });

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            hexpand: true,
            css_classes: ['isle-notification'],
        });

        // App badge
        const badge = notificationBadge(notification);
        content.append(badge);

        // Texts: Title + Body + Actions
        const texts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-notification-texts'],
        });

        const titleText = (notification.title || notification.appName || '').replace(/\s+/g, ' ').trim();
        const titleLabel = label(titleText, 'isle-notification-title', {
            halign: Gtk.Align.START,
        });
        titleLabel.set_ellipsize(Pango.EllipsizeMode.END);
        texts.append(titleLabel);

        const bodyText = (notification.body || '').replace(/\s+/g, ' ').trim();
        if (bodyText) {
            const bodyLabel = label(bodyText, 'isle-notification-body', {
                halign: Gtk.Align.START,
            });
            bodyLabel.set_wrap(true);
            bodyLabel.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
            bodyLabel.set_lines(3);
            bodyLabel.set_ellipsize(Pango.EllipsizeMode.END);
            texts.append(bodyLabel);
        }

        // Action buttons
        const actions = (notification.actions || []).filter(a => a.id !== 'default').slice(0, MAX_ACTIONS);
        if (actions.length > 0) {
            const actionsBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                css_classes: ['isle-notification-actions'],
            });
            for (const action of actions) {
                const btn = pillButton(action.label, 'isle-pill-small isle-notification-action', () => {
                    action.activate();
                    this.emit('request-close');
                });
                actionsBox.append(btn);
            }
            texts.append(actionsBox);
        }

        content.append(texts);

        // Corner: Time and dismiss button
        const corner = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.START,
            halign: Gtk.Align.END,
            css_classes: ['isle-notification-tools'],
        });

        const timeLabel = label(Format.ago(notification.datetime), 'isle-notification-time', {
            valign: Gtk.Align.CENTER,
        });
        this._times.push([timeLabel, notification.datetime]);
        corner.append(timeLabel);

        const dismissBtn = iconButton('isle-close-symbolic', 'isle-button-flat isle-notification-dismiss', () => {
            notification.destroy();
        }, { size: 10, accessibleName: 'Dismiss' });
        dismissBtn.set_valign(Gtk.Align.CENTER);
        dismissBtn.set_opacity(0.8);
        corner.append(dismissBtn);

        content.append(corner);
        row.set_child(content);

        // Clicking card activates notification
        row.connect('clicked', () => {
            notification.activate();
            this.emit('request-close');
        });

        return row;
    }

    onActivate() {
        if (this._center) {
            this._center.acknowledgeAll();
            for (const [timeLabel, dt] of this._times) {
                timeLabel.set_text(Format.ago(dt));
            }
        }
    }
});
