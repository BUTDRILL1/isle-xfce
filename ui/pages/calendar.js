// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Calendar & Schedule page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/calendar.js.
//! Manages event listings, quick event creation, and meeting joins.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { icon, iconButton, label, pillButton } from '../widgets.js';
import { Page } from '../page.js';

const MEETING_URL_RE = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)\/[^\s"'>]+/i;

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

/**
 * Extracts a meeting link (Google Meet, Zoom, Teams, Webex) from an event.
 */
function extractMeetingUrl(event) {
    if (!event) return null;
    if (event.meeting_url) return event.meeting_url;
    if (event.meetingLink) return event.meetingLink;
    if (event.url && MEETING_URL_RE.test(event.url)) return event.url;
    if (event.link && MEETING_URL_RE.test(event.link)) return event.link;
    const match = MEETING_URL_RE.exec(event.title || '') || MEETING_URL_RE.exec(event.description || '');
    if (match) return match[0];
    return null;
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
                    const summary = ics.match(/^SUMMARY.*?:(.*)$/m)?.[1]?.trim() || 'Untitled';
                    const dtstart = ics.match(/^DTSTART.*?:(.*)$/m)?.[1]?.trim();
                    const dtend = ics.match(/^DTEND.*?:(.*)$/m)?.[1]?.trim();
                    const isAllDay = !dtstart || !dtstart.includes('T');
                    const start = parseTime(dtstart);
                    const end = parseTime(dtend);
                    const descMatch = ics.match(/^DESCRIPTION.*?:(.*)$/m)?.[1] || '';
                    const locMatch = ics.match(/^LOCATION.*?:(.*)$/m)?.[1] || '';
                    const urlMatch = ics.match(/^URL.*?:(.*)$/m)?.[1] || '';
                    const meetingUrl = descMatch.match(MEETING_URL_RE)?.[0]
                        || locMatch.match(MEETING_URL_RE)?.[0]
                        || urlMatch.match(MEETING_URL_RE)?.[0]
                        || null;

                    events.push({
                        title: summary,
                        allDay: isAllDay,
                        start,
                        end,
                        color: cal.color || '#0a84ff',
                        url: meetingUrl,
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

        // Join button (if meeting URL detected)
        const meetingUrl = extractMeetingUrl(event);
        if (meetingUrl) {
            const joinBtn = pillButton('Join', 'isle-button-round isle-button-small isle-meeting-join', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri_async(meetingUrl, null, null, null);
                } catch (e) {
                    console.warn(`Isle: could not open meeting URL: ${e.message}`);
                }
            });
            row.append(joinBtn);
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
