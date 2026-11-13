// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Notification center and FreeDesktop Notifications DBus service for Isle XFCE.
//! Claims org.freedesktop.Notifications on the session bus so apps (WhatsApp, browsers,
//! messengers, notify-send, etc.) deliver desktop notifications to Isle.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { EventEmitter } from './daemon.js';

const IFACE_XML = `
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities">
      <arg type="as" name="capabilities" direction="out"/>
    </method>
    <method name="Notify">
      <arg type="s" name="app_name" direction="in"/>
      <arg type="u" name="replaces_id" direction="in"/>
      <arg type="s" name="app_icon" direction="in"/>
      <arg type="s" name="summary" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="as" name="actions" direction="in"/>
      <arg type="a{sv}" name="hints" direction="in"/>
      <arg type="i" name="expire_timeout" direction="in"/>
      <arg type="u" name="id" direction="out"/>
    </method>
    <method name="CloseNotification">
      <arg type="u" name="id" direction="in"/>
    </method>
    <method name="GetServerInformation">
      <arg type="s" name="name" direction="out"/>
      <arg type="s" name="vendor" direction="out"/>
      <arg type="s" name="version" direction="out"/>
      <arg type="s" name="spec_version" direction="out"/>
    </method>
    <signal name="NotificationClosed">
      <arg type="u" name="id"/>
      <arg type="u" name="reason"/>
    </signal>
    <signal name="ActionInvoked">
      <arg type="u" name="id"/>
      <arg type="s" name="action_key"/>
    </signal>
  </interface>
</node>`;

/** Plain text of a notification body that may contain markup. */
export function plainBody(text) {
    if (!text) return '';
    let s = String(text);
    // Replace line break tags with newlines
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/p>/gi, '\n');
    // Extract link text from anchor tags, discarding empty anchors
    s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_match, inner) => inner ? inner.trim() : '');
    // Remove all remaining tags (e.g. <img>, <span>, <div>, <b>, <i>, <u>, etc.)
    s = s.replace(/<[^>]+>/g, '');
    // Decode HTML / XML entities
    s = s
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => {
            try { return String.fromCodePoint(parseInt(code, 10)); } catch (_) { return ''; }
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
            try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return ''; }
        })
        .replace(/&amp;/g, '&');
    return s.trim();
}

export class NotificationCenter extends EventEmitter {
    constructor() {
        super();
        this._notifications = new Map();
        this._nextId = 1;
        this._dnd = false;
        this._connection = null;
        this._regId = 0;
        this._ownerId = 0;

        this._initDBus();
    }

    _initDBus() {
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(IFACE_XML);
        const ifaceInfo = nodeInfo.interfaces[0];

        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.freedesktop.Notifications',
            Gio.BusNameOwnerFlags.REPLACE,
            (conn, _name) => {
                this._connection = conn;
                try {
                    this._regId = conn.register_object(
                        '/org/freedesktop/Notifications',
                        ifaceInfo,
                        this._handleMethodCall.bind(this),
                        null,
                        null
                    );
                    log('[Isle] Registered org.freedesktop.Notifications on D-Bus');
                } catch (e) {
                    logError(e, '[Isle] Failed to register notification object');
                }
            },
            (_conn, name) => {
                log(`[Isle] Acquired bus name: ${name}`);
            },
            (_conn, name) => {
                log(`[Isle] Lost bus name: ${name}`);
            }
        );
    }

    _handleMethodCall(_conn, _sender, _path, _iface, methodName, parameters, invocation) {
        try {
            if (methodName === 'GetServerInformation') {
                invocation.return_value(new GLib.Variant('(ssss)', ['Isle', 'Isle Team', '1.0', '1.2']));
            } else if (methodName === 'GetCapabilities') {
                invocation.return_value(new GLib.Variant('(as)', [[
                    'actions',
                    'action-icons',
                    'body',
                    'body-hyperlinks',
                    'body-markup',
                    'icon-static',
                    'persistence',
                ]]));
            } else if (methodName === 'Notify') {
                const [appName, replacesId, appIcon, summary, body, actions, hints, expireTimeout] = parameters.deep_unpack();
                print(`[Isle DBus Notify] app=${appName} replacesId=${replacesId} summary="${summary}" body="${body}"`);
                const id = this._onNotify(appName, replacesId, appIcon, summary, body, actions, hints, expireTimeout);
                invocation.return_value(new GLib.Variant('(u)', [id]));
            } else if (methodName === 'CloseNotification') {
                const [id] = parameters.deep_unpack();
                this._closeNotification(id, 3);
                invocation.return_value(null);
            }
        } catch (err) {
            logError(err, `[Isle] Error handling method ${methodName}`);
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', err.message);
        }
    }

    _onNotify(appName, replacesId, appIcon, summary, body, rawActions, hints, expireTimeout) {
        const id = (replacesId && replacesId > 0 && this._notifications.has(replacesId))
            ? replacesId
            : this._nextId++;

        // Clean web.whatsapp.com domain clutter and detect WhatsApp
        let cleanBody = body || '';
        let cleanAppName = appName || 'Notification';
        let cleanAppIcon = appIcon || '';

        if (cleanBody.includes('web.whatsapp.com') || cleanAppName.toLowerCase().includes('whatsapp')) {
            cleanAppName = 'WhatsApp';
            if (!cleanAppIcon || cleanAppIcon === 'dialog-information-symbolic') {
                cleanAppIcon = 'whatsapp';
            }
            cleanBody = cleanBody.replace(/^web\.whatsapp\.com\s*/i, '').replace(/\bweb\.whatsapp\.com\b\s*/gi, '').trim();
        }

        // Parse action pairs: [id1, label1, id2, label2, ...]
        const parsedActions = [];
        if (Array.isArray(rawActions)) {
            for (let i = 0; i < rawActions.length; i += 2) {
                const actionId = rawActions[i];
                const actionLabel = rawActions[i + 1] || actionId;
                if (actionId) {
                    parsedActions.push({
                        id: actionId,
                        label: actionLabel,
                        activate: () => this.activate(id, actionId),
                    });
                }
            }
        }

        const isUpdate = this._notifications.has(id);
        const notification = {
            id,
            appName: cleanAppName,
            title: plainBody(summary) || cleanAppName || '',
            body: plainBody(cleanBody),
            rawBody: body || '',
            appIcon: cleanAppIcon,
            hints: hints || {},
            actions: parsedActions,
            datetime: GLib.DateTime.new_now_local(),
            acknowledged: false,
            urgency: (hints && hints.urgency) ? hints.urgency.deep_unpack() : 1,
            destroy: (reason = 2) => this._closeNotification(id, reason),
            activate: () => {
                const defAction = parsedActions.find(a => a.id === 'default');
                if (defAction) {
                    defAction.activate();
                } else {
                    this.activate(id, 'default');
                }
            },
        };

        this._notifications.set(id, notification);
        print(`[Isle NotificationCenter] Added notification id=${id}, total count=${this._notifications.size}`);

        if (isUpdate) {
            this.emit('updated', notification);
        } else {
            this.emit('changed');
            if (!this._dnd) {
                this.emit('banner', notification);
            }
        }
        this.emit('seen-changed');

        return id;
    }

    _closeNotification(id, reason = 2) {
        if (!this._notifications.has(id))
            return;

        this._notifications.delete(id);
        this.emit('changed');
        this.emit('seen-changed');

        if (this._connection) {
            try {
                this._connection.emit_signal(
                    null,
                    '/org/freedesktop/Notifications',
                    'org.freedesktop.Notifications',
                    'NotificationClosed',
                    new GLib.Variant('(uu)', [id, reason])
                );
            } catch (err) {
                logError(err, '[Isle] Error emitting NotificationClosed');
            }
        }
    }

    activate(id, actionKey = 'default') {
        if (this._connection) {
            try {
                this._connection.emit_signal(
                    null,
                    '/org/freedesktop/Notifications',
                    'org.freedesktop.Notifications',
                    'ActionInvoked',
                    new GLib.Variant('(us)', [id, actionKey])
                );
            } catch (err) {
                logError(err, '[Isle] Error emitting ActionInvoked');
            }
        }
    }

    get notifications() {
        const all = [...this._notifications.values()];
        return all.sort((a, b) => b.datetime.compare(a.datetime));
    }

    get unseenCount() {
        let count = 0;
        for (const n of this._notifications.values()) {
            if (!n.acknowledged) count++;
        }
        return count;
    }

    get hasUnseen() {
        return this.unseenCount > 0;
    }

    get dnd() {
        return this._dnd;
    }

    set dnd(on) {
        if (this._dnd === Boolean(on))
            return;
        this._dnd = Boolean(on);
        this.emit('dnd-changed');
    }

    acknowledgeAll() {
        let anyChanged = false;
        for (const n of this._notifications.values()) {
            if (!n.acknowledged) {
                n.acknowledged = true;
                anyChanged = true;
            }
        }
        if (anyChanged) {
            this.emit('seen-changed');
        }
    }

    clearAll() {
        const ids = [...this._notifications.keys()];
        for (const id of ids) {
            this._closeNotification(id, 2);
        }
    }

    destroy() {
        if (this._regId && this._connection) {
            this._connection.unregister_object(this._regId);
            this._regId = 0;
        }
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._connection = null;
        this._notifications.clear();
        this.disconnectAll();
    }
}

