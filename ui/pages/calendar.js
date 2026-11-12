// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Calendar & Schedule page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/calendar.js.
//! Manages event listings, quick event creation, and meeting joins.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { icon, iconButton, label, pillButton } from '../widgets.js';
import { Page } from '../page.js';

const MEETING_URL_RE = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)\/[^\s"'>]+/i;
const GENERAL_URL_RE = /https?:\/\/[^\s"'>\\]+/i;

/**
 * Extracts meeting URL or general link from an event or ICS fields.
 */
function extractEventLink(unfolded = '', summary = '', description = '', location = '') {
    // 1. Google conference property has highest priority
    const confMatch = unfolded.match(/X-GOOGLE-CONFERENCE:(https?:\/\/[^\s\r\n]+)/i)?.[1]?.trim();
    if (confMatch) return { url: confMatch, isMeeting: true };

    // 2. Meeting URLs (Google Meet, Zoom, Teams, Webex)
    const allText = `${summary || ''} ${location || ''} ${description || ''} ${unfolded}`;
    const meetMatch = allText.match(MEETING_URL_RE)?.[0];
    if (meetMatch) return { url: meetMatch, isMeeting: true };

    // 3. Location or explicit URL field if it's a URL
    if (location && /^https?:\/\//i.test(location.trim())) return { url: location.trim(), isMeeting: false };
    const urlProp = unfolded.match(/^URL.*?:(.*)$/m)?.[1]?.trim();
    if (urlProp && /^https?:\/\//i.test(urlProp)) return { url: urlProp, isMeeting: false };

    // 4. Any general link in description or summary (excluding standard footer links)
    const genMatch = (description || '').match(GENERAL_URL_RE)?.[0];
    if (genMatch && !genMatch.includes('support.google.com') && !genMatch.includes('tel.meet')) {
        return { url: genMatch, isMeeting: false };
    }
    return { url: null, isMeeting: false };
}

/**
 * Parses color formats (RGB array, hex string, or fallback) into [r, g, b] in range 0.0 .. 1.0.
 */
function parseColorRgb(color) {
    if (Array.isArray(color) && color.length >= 3) {
        return [
            color[0] / (color[0] > 1 ? 255 : 1),
            color[1] / (color[1] > 1 ? 255 : 1),
            color[2] / (color[2] > 1 ? 255 : 1),
        ];
    }
    if (typeof color === 'string' && color.startsWith('#')) {
        const hex = color.replace('#', '');
        if (hex.length === 6) {
            return [
                parseInt(hex.slice(0, 2), 16) / 255,
                parseInt(hex.slice(2, 4), 16) / 255,
                parseInt(hex.slice(4, 6), 16) / 255,
            ];
        }
    }
    // Default Isle signature orange (#ff9f0a)
    return [1.0, 0.62, 0.04];
}

/**
 * Creates a circular colored dot for event calendar indicator using Cairo.
 */
function createColorDot(color = null) {
    const [r, g, b] = parseColorRgb(color);
    const area = new Gtk.DrawingArea({
        content_width: 8,
        content_height: 8,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
        css_classes: ['isle-cal-event-dot'],
    });
    area.set_draw_func((_area, cr, w, h) => {
        cr.arc(w / 2, h / 2, 3.5, 0, 2 * Math.PI);
        cr.setSourceRGB(r, g, b);
        cr.fill();
    });
    return area;
}

export const CalendarPage = GObject.registerClass({
    GTypeName: 'IsleGtkCalendarPage',
}, class CalendarPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'calendar',
            height,
            available: true,
        });

        this._edsEvents = [];
        this._buildUi();

        this.watch(['calendar', 'events'], () => this._update());
        this._update();
        this._refreshEds();

        this._edsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._refreshEds();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get available() {
        return true;
    }

    set available(_v) {
        super.available = true;
    }

    _buildUi() {
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-cal-agenda', 'isle-calendar-container'],
        });

        // 1. Header row: Today's date + Today jump button
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-cal-day-header'],
        });

        this._dayTitle = label('', 'isle-cal-day-name', {
            hexpand: true,
            halign: Gtk.Align.START,
        });
        header.append(this._dayTitle);

        this._todayBtn = pillButton('Today', 'isle-cal-today isle-button-small', () => {
            this._refreshEds();
        });
        header.append(this._todayBtn);

        container.append(header);

        // 2. Quick event entry row
        const inputRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-cal-add-row'],
        });

        this._entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: 'Add event · e.g. Lunch 12:30 or 15:00 Sync',
            css_classes: ['isle-entry', 'isle-cal-add'],
            can_focus: true,
        });
        this._entry.connect('activate', () => this._add());
        inputRow.append(this._entry);

        const addBtn = iconButton('isle-plus-symbolic', 'isle-button-round isle-reminders-add', () => {
            this._add();
        }, { size: 13, accessibleName: 'Add event' });
        inputRow.append(addBtn);

        container.append(inputRow);

        // 3. Scrollable events list
        this._scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-cal-scroll'],
        });

        this._list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-cal-events'],
        });

        this._scroll.set_child(this._list);
        container.append(this._scroll);

        this.append(container);
    }

    async _refreshEds() {
        try {
            print('[Isle Calendar] _refreshEds starting...');
            const edsEvents = await this._loadEdsEvents();
            print(`[Isle Calendar] _refreshEds loaded ${edsEvents?.length ?? 0} events: ${JSON.stringify(edsEvents)}`);
            if (Array.isArray(edsEvents)) {
                this._edsEvents = edsEvents;
                this._update();
            }
        } catch (e) {
            print(`[Isle Calendar] _refreshEds ERROR: ${e.message}`);
        }
    }

    async _loadEdsEvents() {
        const bus = Gio.DBus.session;
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const startIso = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T000000Z`;
        const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
        const endIso = `${tomorrow.getFullYear()}${pad(tomorrow.getMonth() + 1)}${pad(tomorrow.getDate())}T235959Z`;
        const query = `(occur-in-time-range? (make-time "${startIso}") (make-time "${endIso}"))`;

        let calList = [];
        try {
            const raw = await this.daemon?.call('calendar', 'Calendars');
            if (raw) calList = JSON.parse(raw);
        } catch {}

        if (!Array.isArray(calList) || calList.length === 0) {
            calList = [{ uid: '32ea1ec765133f2ab0ee78d427910954e36dfac4', color: '#7bd148' }];
        }

        const events = [];
        const parseTime = str => {
            if (!str) return null;
            const m = str.match(/T(\d{2})(\d{2})/);
            return m ? `${m[1]}:${m[2]}` : null;
        };

        for (const cal of calList) {
            try {
                const openReply = await new Promise((resolve, reject) => {
                    bus.call(
                        'org.gnome.evolution.dataserver.Calendar8',
                        '/org/gnome/evolution/dataserver/CalendarFactory',
                        'org.gnome.evolution.dataserver.CalendarFactory',
                        'OpenCalendar',
                        new GLib.Variant('(s)', [cal.uid]),
                        null,
                        Gio.DBusCallFlags.NONE,
                        4000,
                        null,
                        (b, res) => {
                            try { resolve(b.call_finish(res)); } catch (e) { reject(e); }
                        }
                    );
                });
                const [calPath, calBusName] = openReply.deep_unpack();

                const listReply = await new Promise((resolve, reject) => {
                    bus.call(
                        calBusName,
                        calPath,
                        'org.gnome.evolution.dataserver.Calendar',
                        'GetObjectList',
                        new GLib.Variant('(s)', [query]),
                        null,
                        Gio.DBusCallFlags.NONE,
                        6000,
                        null,
                        (b, res) => {
                            try { resolve(b.call_finish(res)); } catch (e) { reject(e); }
                        }
                    );
                });
                const [icsList] = listReply.deep_unpack();

                for (const ics of icsList) {
                    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
                    const summary = unfolded.match(/^SUMMARY.*?:(.*)$/m)?.[1]?.trim() || 'Untitled';
                    const dtstart = unfolded.match(/^DTSTART.*?:(.*)$/m)?.[1]?.trim();
                    const dtend = unfolded.match(/^DTEND.*?:(.*)$/m)?.[1]?.trim();
                    const isAllDay = !dtstart || !dtstart.includes('T');
                    const start = parseTime(dtstart);
                    const end = parseTime(dtend);
                    const descMatch = unfolded.match(/^DESCRIPTION.*?:(.*)$/m)?.[1] || '';
                    const locMatch = unfolded.match(/^LOCATION.*?:(.*)$/m)?.[1] || '';
                    const link = extractEventLink(unfolded, summary, descMatch, locMatch);

                    events.push({
                        title: summary,
                        allDay: isAllDay,
                        start,
                        end,
                        color: cal.color || '#0a84ff',
                        url: link.url,
                        isMeeting: link.isMeeting,
                    });
                }
            } catch (err) {
                console.warn(`Isle: could not load EDS events for ${cal.uid}: ${err.message}`);
            }
        }

        return events;
    }

    async _add() {
        const text = this._entry.get_text().trim();
        if (!text) return;
        this._entry.set_text('');

        const now = GLib.DateTime.new_now_local();
        const todayIso = now.format('%Y-%m-%d');

        try {
            // First attempt with 3-arg signature (calendar, date, text)
            const res = await this.daemon.call('calendar', 'Add', '', todayIso, text);
            if (res === null || res === undefined) {
                // Fallback to 2-arg signature (date, text)
                await this.daemon.call('calendar', 'Add', todayIso, text).catch(() => {});
            }
        } catch {
            try {
                await this.daemon.call('calendar', 'Add', todayIso, text);
            } catch (e) {
                console.warn(`Isle: could not add calendar event: ${e.message}`);
            }
        }
        await this._refreshEds();
    }

    _events() {
        const raw = this.daemon?.state?.calendar ?? this.daemon?.state?.events;
        let list = [];
        if (Array.isArray(raw)) list = [...raw];
        else if (Array.isArray(raw?.events)) list = [...raw.events];
        else if (Array.isArray(raw?.days)) {
            list = raw.days.flatMap(d => d.events || []);
        }

        const combined = [...(this._edsEvents || []), ...list];
        combined.sort((a, b) => {
            if (a.allDay && !b.allDay) return -1;
            if (!a.allDay && b.allDay) return 1;
            return (a.start || '').localeCompare(b.start || '');
        });
        return combined;
    }

    _update() {
        // 1. Update date header
        const now = GLib.DateTime.new_now_local();
        const dateStr = now.format('%A, %-d %B') || now.format('%A, %B %d') || 'Today';
        this._dayTitle.set_text(dateStr);

        // 2. Clear list children
        let child = this._list.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._list.remove(child);
            child = next;
        }

        const events = this._events();

        if (events.length === 0) {
            const emptyLbl = label('No events today', 'isle-cal-empty', {
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
                hexpand: true,
                vexpand: true,
            });
            this._list.append(emptyLbl);
            return;
        }

        // Render events
        for (const event of events) {
            this._list.append(this._buildEventRow(event));
        }
    }

    _buildEventRow(event) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-cal-event'],
        });

        // Calendar color dot
        const dot = createColorDot(event.color);
        row.append(dot);

        // Title
        const titleLbl = label(event.title || 'Untitled', 'isle-cal-event-title', {
            hexpand: true,
            halign: Gtk.Align.START,
        });
        titleLbl.set_ellipsize(Pango.EllipsizeMode.END);
        row.append(titleLbl);

        // Time label
        let timeText = 'All day';
        if (!event.allDay && event.start) {
            timeText = event.end ? `${event.start} – ${event.end}` : event.start;
        }
        const timeLbl = label(timeText, 'isle-cal-event-time', {
            valign: Gtk.Align.CENTER,
        });
        row.append(timeLbl);

        // Link Actions: Join/Open button + Copy link button
        const linkInfo = event.url
            ? { url: event.url, isMeeting: event.isMeeting }
            : extractEventLink('', event.title, event.description, event.location);

        if (linkInfo && linkInfo.url) {
            const actionsBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            });

            // 1. Join / Open button
            const btnText = linkInfo.isMeeting ? 'Join' : 'Open';
            const btnClass = linkInfo.isMeeting
                ? 'isle-pill-accent isle-meeting-join isle-pill-small'
                : 'isle-pill-small';

            const actionBtn = pillButton(btnText, btnClass, () => {
                try {
                    Gio.AppInfo.launch_default_for_uri_async(linkInfo.url, null, null, null);
                } catch (e) {
                    console.warn(`Isle: could not open URL: ${e.message}`);
                }
            });
            actionsBox.append(actionBtn);

            // 2. Copy Link button
            const copyImg = new Gtk.Image({
                icon_name: 'edit-copy-symbolic',
                pixel_size: 11,
            });
            const copyBtn = new Gtk.Button({
                child: copyImg,
                css_classes: ['isle-button', 'isle-button-round', 'isle-button-small'],
                tooltip_text: 'Copy link',
                valign: Gtk.Align.CENTER,
            });
            copyBtn.connect('clicked', () => {
                try {
                    const display = Gdk.Display.get_default();
                    if (display) display.get_clipboard().set(linkInfo.url);
                } catch (_) {}
                try {
                    GLib.spawn_command_line_async(`bash -c 'printf %s "${linkInfo.url}" | xclip -selection clipboard'`);
                } catch (_) {}

                copyImg.set_from_icon_name('object-select-symbolic');
                copyBtn.set_tooltip_text('Copied!');
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    copyImg.set_from_icon_name('edit-copy-symbolic');
                    copyBtn.set_tooltip_text('Copy link');
                    return GLib.SOURCE_REMOVE;
                });
            });
            actionsBox.append(copyBtn);

            row.append(actionsBox);
        }

        // Remove button (if Isle event with id)
        if (event.id !== undefined && event.id !== null) {
            const removeBtn = iconButton('isle-close-symbolic', 'isle-button-flat isle-reminder-remove', () => {
                this.daemon.call('calendar', 'Remove', event.id);
            }, { size: 10, accessibleName: 'Remove event' });
            row.append(removeBtn);
        }

        return row;
    }
});
