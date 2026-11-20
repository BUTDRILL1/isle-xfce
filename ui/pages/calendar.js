// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Calendar page for Isle XFCE GTK4 runtime.
//! Provides a clean Monthly and Weekly calendar view, while keeping EDS desktop events synced for Reminders.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { label, pillButton } from '../widgets.js';
import { Page } from '../page.js';
import { getSettingsStore } from '../settingsStore.js';

const MEETING_URL_RE = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)\/[^\s"'>]+/i;
const GENERAL_URL_RE = /https?:\/\/[^\s"'>\\]+/i;
const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function toIsoDate(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, days) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

function startOfWeekMonday(d) {
    const dow = (d.getDay() + 6) % 7;
    return addDays(d, -dow);
}

function extractEventLink(unfolded = '', summary = '', description = '', location = '') {
    const confMatch = unfolded.match(/X-GOOGLE-CONFERENCE:(https?:\/\/[^\s\r\n]+)/i)?.[1]?.trim();
    if (confMatch) return { url: confMatch, isMeeting: true };

    const allText = `${summary || ''} ${location || ''} ${description || ''} ${unfolded}`;
    const meetMatch = allText.match(MEETING_URL_RE)?.[0];
    if (meetMatch) return { url: meetMatch, isMeeting: true };

    if (location && /^https?:\/\//i.test(location.trim())) return { url: location.trim(), isMeeting: false };
    const urlProp = unfolded.match(/^URL.*?:(.*)$/m)?.[1]?.trim();
    if (urlProp && /^https?:\/\//i.test(urlProp)) return { url: urlProp, isMeeting: false };

    const genMatch = (description || '').match(GENERAL_URL_RE)?.[0];
    if (genMatch && !genMatch.includes('support.google.com') && !genMatch.includes('tel.meet')) {
        return { url: genMatch, isMeeting: false };
    }
    return { url: null, isMeeting: false };
}

export const CalendarPage = GObject.registerClass({
    GTypeName: 'IsleGtkCalendarPage',
}, class CalendarPage extends Page {
    _init(daemon, { height = 275 } = {}) {
        super._init(daemon, {
            name: 'calendar',
            height,
            available: true,
        });

        const now = new Date();
        this._viewMode = globalThis.isleCalendarViewMode === 'week' ? 'week' : 'month'; // 'month' | 'week'
        this._selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        this._cursorDate = new Date(now.getFullYear(), now.getMonth(), 1);
        this._edsEvents = [];

        this._buildUi();

        globalThis.isleCalendar = this;

        this._update();
        this._refreshEds();

        this._settingsStore = getSettingsStore();
        this._edsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._refreshEds();
            return GLib.SOURCE_CONTINUE;
        });
        this._calSettingsUnsub = this._settingsStore.subscribe('calendar', (state) => {
            const targetMode = state.calendarViewMode === 'week' ? 'week' : 'month';
            if (targetMode !== this._viewMode) {
                this._setViewMode(targetMode, { save: false });
            }
        });
        this.connect('destroy', () => {
            if (this._calSettingsUnsub) {
                this._calSettingsUnsub();
                this._calSettingsUnsub = null;
            }
        });
    }

    get available() {
        return true;
    }

    set available(_v) {
        super.available = true;
    }

    getDesiredHeight() {
        return this._viewMode === 'week' ? 165 : 295;
    }

    _buildUi() {
        this._root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-calendar-container'],
        });

        // Top controls bar
        const topBar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-cal-month-header'],
        });

        const prevBtn = new Gtk.Button({
            label: '‹',
            css_classes: ['isle-cal-arrow'],
            tooltip_text: 'Previous',
        });
        prevBtn.connect('clicked', () => this._navigate(-1));
        topBar.append(prevBtn);

        this._monthNameLbl = label('', 'isle-cal-month-name');
        this._yearLbl = label('', 'isle-cal-year');
        const titleBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-cal-month-title-box'],
        });
        titleBox.append(this._monthNameLbl);
        titleBox.append(this._yearLbl);
        topBar.append(titleBox);

        const nextBtn = new Gtk.Button({
            label: '›',
            css_classes: ['isle-cal-arrow'],
            tooltip_text: 'Next',
        });
        nextBtn.connect('clicked', () => this._navigate(1));
        topBar.append(nextBtn);

        topBar.append(new Gtk.Box({ hexpand: true }));

        this._todayBtn = pillButton('Today', 'isle-cal-today isle-button-small', () => {
            const now = new Date();
            this._selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            this._cursorDate = new Date(now.getFullYear(), now.getMonth(), 1);
            this._update();
        });
        topBar.append(this._todayBtn);

        const modeGroup = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-cal-mode-group'],
        });
        this._monthModeBtn = new Gtk.Button({
            label: 'Month',
            css_classes: ['isle-cal-mode-btn', ...(this._viewMode === 'month' ? ['active'] : [])],
        });
        this._weekModeBtn = new Gtk.Button({
            label: 'Week',
            css_classes: ['isle-cal-mode-btn', ...(this._viewMode === 'week' ? ['active'] : [])],
        });
        this._monthModeBtn.connect('clicked', () => this._setViewMode('month'));
        this._weekModeBtn.connect('clicked', () => this._setViewMode('week'));
        modeGroup.append(this._monthModeBtn);
        modeGroup.append(this._weekModeBtn);
        topBar.append(modeGroup);

        this._root.append(topBar);

        this._gridContainer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.START,
            css_classes: ['isle-cal-month'],
        });
        this._root.append(this._gridContainer);

        this.append(this._root);
    }

    _setViewMode(mode, { save = true } = {}) {
        if (this._viewMode === mode) return;
        this._viewMode = mode;
        this._monthModeBtn.set_css_classes(['isle-cal-mode-btn', ...(mode === 'month' ? ['active'] : [])]);
        this._weekModeBtn.set_css_classes(['isle-cal-mode-btn', ...(mode === 'week' ? ['active'] : [])]);
        if (save) {
            this._settingsStore.update(s => {
                s.calendarViewMode = mode;
            }, 'calendar');
        }
        this._update();
    }

    _navigate(delta) {
        if (this._viewMode === 'month') {
            this._cursorDate = new Date(this._cursorDate.getFullYear(), this._cursorDate.getMonth() + delta, 1);
        } else {
            this._selectedDate = addDays(this._selectedDate, delta * 7);
            this._cursorDate = new Date(this._selectedDate.getFullYear(), this._selectedDate.getMonth(), 1);
        }
        this._update();
    }

    _selectDate(d) {
        this._selectedDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        this._cursorDate = new Date(d.getFullYear(), d.getMonth(), 1);
        this._update();
    }

    async _refreshEds() {
        try {
            const edsEvents = await this._loadEdsEvents();
            if (Array.isArray(edsEvents)) {
                this._edsEvents = edsEvents;
                globalThis.isleTasks?._update();

                try {
                    const daemonEvents = edsEvents.map(ev => ({
                        id: ev.id || `eds-${Math.random().toString(36).slice(2)}`,
                        title: ev.title || 'Untitled',
                        date: ev.date || toIsoDate(new Date()),
                        start: ev.start || null,
                        end: ev.end || null,
                    }));
                    await this.daemon?.call('calendar', 'SetDesktopEvents', JSON.stringify(daemonEvents));
                } catch (err) {
                    console.warn(`Isle: could not push desktop events to daemon: ${err.message}`);
                }
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
        const tomorrow = addDays(now, 1);
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
                    const uid = unfolded.match(/^UID.*?:(.*)$/m)?.[1]?.trim() || `eds-${Math.random().toString(36).slice(2)}`;
                    const summary = unfolded.match(/^SUMMARY.*?:(.*)$/m)?.[1]?.trim() || 'Untitled';
                    const dtstart = unfolded.match(/^DTSTART.*?:(.*)$/m)?.[1]?.trim();
                    const dtend = unfolded.match(/^DTEND.*?:(.*)$/m)?.[1]?.trim();
                    const isAllDay = !dtstart || !dtstart.includes('T');
                    const start = parseTime(dtstart);
                    const end = parseTime(dtend);
                    const todayIso = toIsoDate(now);
                    let eventDate = todayIso;
                    const dateMatch = dtstart?.match(/^(\d{4})(\d{2})(\d{2})/);
                    if (dateMatch) {
                        const parsed = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
                        if (parsed >= todayIso) eventDate = parsed;
                    }
                    const descMatch = unfolded.match(/^DESCRIPTION.*?:(.*)$/m)?.[1] || '';
                    const locMatch = unfolded.match(/^LOCATION.*?:(.*)$/m)?.[1] || '';
                    const link = extractEventLink(unfolded, summary, descMatch, locMatch);

                    events.push({
                        id: uid,
                        title: summary,
                        date: eventDate,
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

    _clearBox(box) {
        let child = box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            box.remove(child);
            child = next;
        }
    }

    _update() {
        const todayIso = toIsoDate(new Date());
        const selectedIso = toIsoDate(this._selectedDate);

        if (this._viewMode === 'month') {
            this._monthNameLbl.set_text(MONTH_NAMES[this._cursorDate.getMonth()]);
            this._yearLbl.set_text(String(this._cursorDate.getFullYear()));
        } else {
            const weekStart = startOfWeekMonday(this._selectedDate);
            const weekEnd = addDays(weekStart, 6);
            const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
            const rangeText = sameMonth
                ? `${weekStart.getDate()}–${weekEnd.getDate()} ${MONTH_NAMES[weekStart.getMonth()]}`
                : `${weekStart.getDate()} ${MONTH_NAMES[weekStart.getMonth()].slice(0, 3)} – ${weekEnd.getDate()} ${MONTH_NAMES[weekEnd.getMonth()].slice(0, 3)}`;
            this._monthNameLbl.set_text(rangeText);
            this._yearLbl.set_text(String(weekEnd.getFullYear()));
        }

        this._clearBox(this._gridContainer);
        if (this._viewMode === 'month') {
            this._renderMonthGrid(todayIso, selectedIso);
        } else {
            this._renderWeekStrip(todayIso, selectedIso);
        }
    }

    _renderMonthGrid(todayIso, selectedIso) {
        const wdRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            hexpand: true,
            css_classes: ['isle-cal-weekdays'],
        });
        for (let i = 0; i < 7; i++) {
            const wd = label(WEEKDAY_SHORT[i], 'isle-cal-weekday', {
                halign: Gtk.Align.CENTER,
            });
            if (i >= 5) wd.add_css_class('weekend');
            wdRow.append(wd);
        }
        this._gridContainer.append(wdRow);

        const year = this._cursorDate.getFullYear();
        const month = this._cursorDate.getMonth();
        const firstDay = new Date(year, month, 1);
        const startOffset = (firstDay.getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const weeks = Math.ceil((startOffset + daysInMonth) / 7);
        const gridStart = addDays(firstDay, -startOffset);

        for (let w = 0; w < weeks; w++) {
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                homogeneous: true,
                hexpand: true,
            });
            for (let d = 0; d < 7; d++) {
                const cellDate = addDays(gridStart, w * 7 + d);
                const iso = toIsoDate(cellDate);
                const isOutside = cellDate.getMonth() !== month;
                const isToday = iso === todayIso;
                const isSelected = iso === selectedIso;
                const isWeekend = d >= 5;

                const classes = ['isle-cal-day'];
                if (isOutside) classes.push('outside');
                else if (isWeekend) classes.push('weekend');
                if (isSelected && !isToday) classes.push('selected');
                if (isToday) classes.push('today');

                const btn = new Gtk.Button({
                    label: String(cellDate.getDate()),
                    css_classes: classes,
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                });
                btn.connect('clicked', () => this._selectDate(cellDate));
                row.append(btn);
            }
            this._gridContainer.append(row);
        }
    }

    _renderWeekStrip(todayIso, selectedIso) {
        const weekStart = startOfWeekMonday(this._selectedDate);
        const strip = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            homogeneous: true,
            hexpand: true,
        });

        for (let i = 0; i < 7; i++) {
            const cellDate = addDays(weekStart, i);
            const iso = toIsoDate(cellDate);
            const isToday = iso === todayIso;
            const isSelected = iso === selectedIso;

            const colContent = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            colContent.append(label(WEEKDAY_SHORT[i], 'isle-cal-week-dow', { halign: Gtk.Align.CENTER }));
            colContent.append(label(String(cellDate.getDate()), 'isle-cal-week-num', { halign: Gtk.Align.CENTER }));

            const classes = ['isle-cal-week-col'];
            if (isSelected) classes.push('selected');
            if (isToday) classes.push('today');

            const colBtn = new Gtk.Button({
                child: colContent,
                css_classes: classes,
                hexpand: true,
            });
            colBtn.connect('clicked', () => this._selectDate(cellDate));
            strip.append(colBtn);
        }

        this._gridContainer.append(strip);
    }
});
