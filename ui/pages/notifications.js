// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Notifications page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/notifications.js with:
//! - iOS-style notification stacking for multiple messages from the same sender
//! - Inline Quick Reply for WhatsApp and messaging apps with desktop integration
//! - Interactive actions, timestamps, and Do Not Disturb controls.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
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
        this._expandedStacks = new Set();

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
        print(`[Isle NotificationsPage _update] notifications count: ${notifications.length}`);
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

        // Group notifications iOS style by sender (${appName}::${title})
        const groups = new Map();
        for (const n of notifications) {
            const key = `${n.appName}::${n.title}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(n);
        }

        for (const [key, groupItems] of groups.entries()) {
            if (groupItems.length === 1) {
                // Standalone notification
                this._list.append(this._buildRow(groupItems[0]));
            } else {
                // Multiple notifications from same sender: iOS-style stack
                const isStackExpanded = this._expandedStacks.has(key);
                if (!isStackExpanded) {
                    // Collapsed Stack: Top card + stacked card layers underneath
                    const stackBox = new Gtk.Box({
                        orientation: Gtk.Orientation.VERTICAL,
                        spacing: 0,
                        css_classes: ['isle-notification-stack'],
                    });

                    const topRow = this._buildRow(groupItems[0], {
                        badgeCount: groupItems.length,
                        onStackClick: () => {
                            this._expandedStacks.add(key);
                            this._update();
                        },
                    });
                    stackBox.append(topRow);

                    const layer1 = new Gtk.Box({ css_classes: ['isle-notification-stack-layer-1'] });
                    const layer2 = new Gtk.Box({ css_classes: ['isle-notification-stack-layer-2'] });
                    stackBox.append(layer1);
                    stackBox.append(layer2);

                    this._list.append(stackBox);
                } else {
                    // Expanded Stack: Header with collapse button + all message rows
                    const header = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 8,
                        css_classes: ['isle-notification-group-header'],
                    });

                    const groupTitle = label(`${groupItems[0].title || groupItems[0].appName} (${groupItems.length} messages)`,
                        'isle-notification-group-title', { hexpand: true, valign: Gtk.Align.CENTER });
                    header.append(groupTitle);

                    const collapseBtn = pillButton('Collapse stack', 'isle-notification-group-collapse', () => {
                        this._expandedStacks.delete(key);
                        this._update();
                    });
                    collapseBtn.set_valign(Gtk.Align.CENTER);
                    header.append(collapseBtn);
                    this._list.append(header);

                    for (const n of groupItems) {
                        this._list.append(this._buildRow(n));
                    }
                }
            }
        }

        this._stack.set_visible_child_name('list');
    }

    _buildRow(notification, { badgeCount = 0, onStackClick = null } = {}) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['isle-notification-row'],
            hexpand: true,
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

        // Texts: Title + Stack Badge + Body + Actions + Inline Reply
        const texts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-notification-texts'],
        });

        const titleRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        const titleText = (notification.title || notification.appName || '').replace(/\s+/g, ' ').trim();
        const titleLabel = label(titleText, 'isle-notification-title', {
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        titleLabel.set_ellipsize(Pango.EllipsizeMode.END);
        titleRow.append(titleLabel);

        // If stacked, display "+X more" pill
        if (badgeCount > 1) {
            const stackBadge = label(`+${badgeCount - 1} more`, 'isle-notification-stack-badge', {
                valign: Gtk.Align.CENTER,
            });
            titleRow.append(stackBadge);
        }
        texts.append(titleRow);

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

        // Inline Reply revealer & entry
        const isMessaging = notification.appName.toLowerCase().includes('whatsapp') ||
            notification.title.toLowerCase().includes('whatsapp') ||
            notification.rawBody.toLowerCase().includes('whatsapp');

        const replyRevealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            transition_duration: 180,
            reveal_child: false,
        });

        const replyBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            css_classes: ['isle-notification-inline-reply'],
        });

        const replyEntry = new Gtk.Entry({
            placeholder_text: `Reply to ${notification.title || 'chat'}...`,
            hexpand: true,
            css_classes: ['isle-notification-reply-entry'],
        });

        let sendBtn = null;
        const sendReply = () => {
            const text = replyEntry.get_text().trim();
            if (text) {
                this._sendReply(notification, text, sendBtn, replyEntry);
            }
        };

        replyEntry.connect('activate', sendReply);

        sendBtn = pillButton('Send', 'isle-notification-reply-send', sendReply);
        replyBox.append(replyEntry);
        replyBox.append(sendBtn);
        replyRevealer.set_child(replyBox);

        // Action buttons
        const actionsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            css_classes: ['isle-notification-actions'],
        });

        // Add Quick "Reply" action for WhatsApp or messaging apps
        if (isMessaging) {
            const replyActionBtn = pillButton('Reply', 'isle-pill-small isle-notification-action', () => {
                const nowOpen = !replyRevealer.get_reveal_child();
                replyRevealer.set_reveal_child(nowOpen);
                if (nowOpen) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        replyEntry.grab_focus();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
            actionsBox.append(replyActionBtn);
        }

        const actions = (notification.actions || []).filter(a => a.id !== 'default' && a.id !== 'settings').slice(0, MAX_ACTIONS);
        for (const action of actions) {
            const btn = pillButton(action.label, 'isle-pill-small isle-notification-action', () => {
                action.activate();
                this.emit('request-close');
            });
            actionsBox.append(btn);
        }

        if (isMessaging || actions.length > 0) {
            texts.append(actionsBox);
        }
        texts.append(replyRevealer);

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
        row.append(content);

        // Only clicking stack card header expands stack
        if (onStackClick) {
            const stackClick = new Gtk.GestureClick();
            stackClick.connect('released', () => {
                if (!replyRevealer.get_reveal_child()) {
                    onStackClick();
                }
            });
            titleRow.add_controller(stackClick);
        }

        return row;
    }

    _sendReply(notification, text, sendBtn, replyEntry) {
        try {
            if (sendBtn) sendBtn.set_label('✓ Sent');
            if (replyEntry) replyEntry.set_sensitive(false);

            // Execute background dispatch restoring active window focus instantly
            const escapedText = text.replace(/'/g, "'\\''");
            const script = `
                ORIG_WIN=$(xdotool getactivewindow 2>/dev/null)
                WA_WIN=$(xdotool search --name "WhatsApp" 2>/dev/null | head -n 1)
                if [ -n "$WA_WIN" ]; then
                    echo -n '${escapedText}' | xclip -selection clipboard
                    xdotool windowactivate --sync "$WA_WIN"
                    sleep 0.04
                    xdotool key --clearmodifiers ctrl+v
                    sleep 0.04
                    xdotool key Return
                    sleep 0.04
                    if [ -n "$ORIG_WIN" ]; then
                        xdotool windowactivate "$ORIG_WIN"
                    fi
                fi
            `;
            GLib.spawn_command_line_async(`bash -c "${script.replace(/\n/g, ' ')}"`);

            // Dismiss notification card cleanly after confirmation
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                notification.destroy();
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            logError(e, '[Isle Notifications] Error sending quick reply');
        }
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
