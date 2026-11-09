// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Expanded island view with tab bar, page container, and navigation for Isle XFCE.
//! Faithful port of upstream gnome-extension/src/expanded.js.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import * as Format from 'file:///home/butarch/Desktop/isle-upstream/gnome-extension/src/format.js';
import {
    Bars,
    PrivacyDots,
    RecordingDot,
    Ring,
    icon,
    iconButton,
    label,
} from './widgets.js';

export const EXPANDED_WIDTH = 600;
export const PAGE_HEIGHT = 150;
export const LARGE_WIDTH = 720;
export const LARGE_PAGE_HEIGHT = 210;
export const BOTTOM_PADDING = 20;
const HEADER_GAP = 16;
const SLIDE_DURATION = 260;

/** Each page's tab: its icon and display label. */
export const TABS = {
    call: { icon: 'isle-phone', label: 'Call' },
    music: { icon: 'isle-music', label: 'Music' },
    notifications: { icon: 'isle-bell', label: 'Notifications' },
    focus: { icon: 'isle-timer', label: 'Timer' },
    reminders: { icon: 'isle-tasks', label: 'Reminders' },
    shelf: { icon: 'isle-shelf', label: 'Shelf' },
    calendar: { icon: 'isle-calendar', label: 'Calendar' },
    apps: { icon: 'isle-apps', label: 'Apps' },
    devices: { icon: 'isle-headphones', label: 'Devices' },
    usage: { icon: 'isle-gauge', label: 'Usage' },
};

const TAB_OPACITY = { open: 1.0, hover: 0.78, idle: 0.55 };
const SETTINGS_OPACITY = 0.6;
const PAUSED_BARS_OPACITY = 0.43;

export const ExpandedView = GObject.registerClass({
    GTypeName: 'IsleGtkExpandedView',
    Signals: {
        'page-changed': {},
        'page-settled': {},
        'width-changed': {},
        'height-changed': {},
        'tint-changed': {},
        'tint-motion': { param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
        'voice-requested': {},
        'settings-requested': {},
    },
}, class ExpandedView extends Gtk.Box {
    _init(daemon, privacy, call, settings, pages) {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ['isle-expanded'],
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            halign: Gtk.Align.FILL,
        });
        this.set_size_request(EXPANDED_WIDTH, -1);

        this._daemon = daemon || { state: {} };
        this._privacy = privacy || {};
        this._call = call || { active: false };
        this._settings = settings || {};
        this._pages = pages || [];

        // Select the first available page (default: music)
        this._index = Math.max(0, this._pages.findIndex(p => p.available));
        this._active = false;
        this._width = EXPANDED_WIDTH;
        this._lastFlip = 0;
        this._clockTimer = 0;
        this._recordingTimeout = 0;

        // 1. Build Header Row (Tabs on left, Status and Clock on right)
        this._header = this._buildHeader();
        this.append(this._header);

        // 2. Build Pager (GtkStack sliding page container)
        this._pagerArea = this._buildPager();
        this.append(this._pagerArea);

        // 3. Bottom padding widget (20px)
        const bottom = new Gtk.Box({
            valign: Gtk.Align.END,
            css_classes: ['isle-expanded-bottom'],
        });
        bottom.set_size_request(-1, BOTTOM_PADDING);
        this.append(bottom);

        // Connect page signals
        for (const page of this._pages) {
            page.connect('width-changed', () => {
                if (page === this.page) this._syncWidth();
            });
            page.connect('tint-changed', () => {
                if (page === this.page) this.emit('tint-changed');
            });
            page.connect('news-changed', () => this._syncTabs());
            page.connect('availability-changed', () => this._onAvailabilityChanged(page));
        }

        // Initialize state
        this._syncTabs();
        this._tickClock();
        this._updateHeader();
    }

    _buildHeader() {
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            css_classes: ['isle-header'],
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        // Left: Tabs Bar
        this._tabsBox = this._buildTabs();
        header.append(this._tabsBox);

        // Flexible spacer between tabs and status
        const spacer = new Gtk.Box({ hexpand: true });
        header.append(spacer);

        // Right: Status Bar
        const status = this._status = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-header-status'],
        });

        // Screen recording pill
        const recordingBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-recording-pill-box'],
        });
        recordingBox.append(new RecordingDot());
        this._recordingTime = label('', 'isle-recording-time');
        recordingBox.append(this._recordingTime);

        this._recordingButton = new Gtk.Button({
            child: recordingBox,
            css_classes: ['isle-recording-pill'],
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        status.append(this._recordingButton);

        // Privacy indicator dots
        this._privacyDots = new PrivacyDots();
        status.append(this._privacyDots);

        // Audio equalizer bars
        this._headerBars = new Bars({ height: 14 });
        this._headerBars.set_valign(Gtk.Align.CENTER);
        status.append(this._headerBars);

        // Assistant sparkle button
        this._micButton = iconButton('isle-sparkle-symbolic', 'isle-button-flat isle-header-mic', () => {
            this.emit('voice-requested');
        }, { size: 15, accessibleName: 'AI assistant' });
        status.append(this._micButton);

        // Header Clock Box: Ring + Date + Time
        const clock = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-header-clock'],
        });

        this._headerRing = new Ring({ size: 15, lineWidth: 2.5 });
        this._headerRing.set_visible(false);
        clock.append(this._headerRing);

        this._date = label('', 'isle-header-date', { valign: Gtk.Align.BASELINE });
        clock.append(this._date);

        const timeBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 3,
            valign: Gtk.Align.BASELINE,
            css_classes: ['isle-header-time-box'],
        });
        this._time = label('', 'isle-header-time', { valign: Gtk.Align.BASELINE });
        this._meridiem = label('', 'isle-header-meridiem', { valign: Gtk.Align.BASELINE, visible: false });
        timeBox.append(this._time);
        timeBox.append(this._meridiem);
        clock.append(timeBox);
        status.append(clock);

        // Settings button
        const settings = iconButton('isle-settings', 'isle-button-flat isle-header-settings', () => {
            this.emit('settings-requested');
        }, { size: 15, accessibleName: 'Settings' });
        settings.set_opacity(SETTINGS_OPACITY);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', () => settings.set_opacity(1.0));
        motion.connect('leave', () => settings.set_opacity(SETTINGS_OPACITY));
        settings.add_controller(motion);
        status.append(settings);

        header.append(status);

        // Scroll gesture over header flips pages
        const scroll = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
        });
        scroll.connect('scroll', (controller, dx, dy) => {
            const step = Math.abs(dy) > Math.abs(dx) ? Math.sign(dy) : Math.sign(dx);
            if (step !== 0) {
                const now = GLib.get_monotonic_time() / 1000;
                if (now - this._lastFlip > 180) {
                    this._lastFlip = now;
                    this.stepPage(step);
                    return true;
                }
            }
            return false;
        });
        header.add_controller(scroll);

        return header;
    }

    _buildTabs() {
        const tabsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-tabs'],
        });

        this._tabs = this._pages.map((page, index) => {
            const tabInfo = TABS[page.name] || { icon: 'isle-apps', label: page.name };
            const { icon: iconName, label: text } = tabInfo;

            // Glyph Overlay (Icon + Badge)
            const glyph = new Gtk.Overlay({
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.CENTER,
            });

            const tabIcon = new Gtk.Image({
                gicon: icon(iconName),
                pixel_size: 16,
            });
            tabIcon.set_opacity(TAB_OPACITY.idle);
            glyph.set_child(tabIcon);

            const badge = new Gtk.Box({
                css_classes: ['isle-tab-badge'],
                halign: Gtk.Align.END,
                valign: Gtk.Align.START,
                visible: false,
            });
            badge.set_size_request(6, 6);
            glyph.add_overlay(badge);

            // Sliding Name Revealer
            const nameLabel = label(text, 'isle-tab-label', {
                valign: Gtk.Align.CENTER,
            });
            const nameClip = new Gtk.Revealer({
                transition_type: Gtk.RevealerTransitionType.SLIDE_RIGHT,
                transition_duration: SLIDE_DURATION,
                valign: Gtk.Align.CENTER,
            });
            nameClip.set_child(nameLabel);
            nameClip.set_reveal_child(false);

            // Tab Box inside Button
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 0,
                valign: Gtk.Align.CENTER,
                css_classes: ['isle-tab-box'],
            });
            box.append(glyph);
            box.append(nameClip);

            const tab = new Gtk.Button({
                css_classes: ['isle-tab', `isle-tab-${page.name}`],
                child: box,
                valign: Gtk.Align.CENTER,
                can_focus: true,
            });

            tab.connect('clicked', () => this.showPage(index));

            const motion = new Gtk.EventControllerMotion();
            motion.connect('enter', () => {
                if (index !== this._index) tabIcon.set_opacity(TAB_OPACITY.hover);
            });
            motion.connect('leave', () => {
                if (index !== this._index) tabIcon.set_opacity(TAB_OPACITY.idle);
            });
            tab.add_controller(motion);

            tabsBox.append(tab);

            return {
                tab,
                icon: tabIcon,
                name: nameLabel,
                nameClip,
                badge,
                iconName,
                page,
            };
        });

        return tabsBox;
    }

    _buildPager() {
        const area = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-pager-area'],
        });
        area.set_size_request(-1, PAGE_HEIGHT);

        this._pager = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
            transition_duration: SLIDE_DURATION,
            hexpand: true,
            vexpand: true,
            interpolate_size: true,
            css_classes: ['isle-pager'],
        });

        for (const page of this._pages) {
            this._pager.add_named(page, page.name);
        }

        if (this._pages[this._index]) {
            this._pager.set_visible_child(this._pages[this._index]);
        }

        area.append(this._pager);
        return area;
    }

    get page() {
        return this._pages[this._index];
    }

    get pageHeight() {
        return this.page?.pageHeight ?? PAGE_HEIGHT;
    }

    get preferredWidth() {
        return EXPANDED_WIDTH;
    }

    showPage(target, { animate = true } = {}) {
        const index = typeof target === 'string'
            ? this._pages.findIndex(p => p.name === target)
            : target;

        if (index < 0 || index >= this._pages.length || index === this._index || !this._pages[index]?.available) {
            return;
        }

        const previous = this.page;
        const fromIndex = this._index;
        this._index = index;
        const next = this.page;

        if (previous) previous.setActive(false);

        // Directional stack transition
        const direction = index > fromIndex ? 1 : -1;
        this._pager.set_transition_type(
            animate
                ? (direction > 0 ? Gtk.StackTransitionType.SLIDE_LEFT : Gtk.StackTransitionType.SLIDE_RIGHT)
                : Gtk.StackTransitionType.NONE
        );

        this._pager.set_visible_child(next);
        if (next) next.setActive(this._active);

        print(`[Isle Expanded] Switched to page ${next?.name} (index ${index}), visible_child=${this._pager.get_visible_child()?.name}`);

        this._syncTabs();
        this._updateHeader();
        this.emit('tint-changed');
        this.emit('page-changed');

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDE_DURATION, () => {
            this.emit('page-settled');
            return GLib.SOURCE_REMOVE;
        });
    }

    stepPage(direction) {
        const nextIndex = this._nearestAvailable(this._index, direction) ??
            this._nearestAvailable(direction > 0 ? -1 : this._pages.length, direction);
        if (nextIndex !== null) {
            this.showPage(nextIndex);
        }
    }

    showTab(n) {
        const available = this._pages
            .map((page, i) => page.available ? i : -1)
            .filter(i => i >= 0);
        const index = available[n - 1];
        if (index !== undefined) {
            this.showPage(index);
        }
    }

    _nearestAvailable(index, direction) {
        for (let i = index + direction; i >= 0 && i < this._pages.length; i += direction) {
            if (this._pages[i]?.available) return i;
        }
        return null;
    }

    _syncTabs() {
        this._tabs.forEach((entry, index) => {
            const { tab, icon: tabIcon, nameClip, badge, iconName, page } = entry;
            const open = index === this._index;
            const available = page.available;

            tab.set_visible(available);
            badge.set_visible(!open && Boolean(page.hasNews));

            if (open) {
                tab.add_css_class('checked');
                tabIcon.set_from_gicon(icon(`${iconName}-fill`));
                tabIcon.set_opacity(TAB_OPACITY.open);
                nameClip.set_reveal_child(true);
            } else {
                tab.remove_css_class('checked');
                tabIcon.set_from_gicon(icon(iconName));
                tabIcon.set_opacity(TAB_OPACITY.idle);
                nameClip.set_reveal_child(false);
            }
        });
    }

    _onAvailabilityChanged(page) {
        this._syncTabs();
        this._updateHeader();
        if (page !== this.page || page.available) return;
        const index = this._nearestAvailable(this._index, 1) ?? this._nearestAvailable(this._index, -1);
        if (index !== null) {
            this.showPage(index);
        }
    }

    setActive(active) {
        if (active === this._active) return;
        this._active = active;
        if (this.page) this.page.setActive(active);

        if (active) {
            this._updateHeader();
            this._tickClock();
            this._startClockTick();
        } else {
            this._stopClockTick();
            this._headerBars.playing = false;
        }
    }

    _updateHeader() {
        // Equalizer Bars: show if music is playing
        this._headerBars.set_visible(true);
        this._headerBars.playing = this._active;

        // Privacy indicator dots
        this._privacyDots.update(this._privacy);

        // Screen recording state
        if (this._privacy.recording) {
            this._recordingButton.set_visible(true);
            const elapsed = Math.max(0, Math.round((GLib.get_monotonic_time() - (this._privacy.recordingSince || 0)) / 1000000));
            this._recordingTime.set_text(Format.duration ? Format.duration(elapsed * 1000) : `${elapsed}s`);
        } else {
            this._recordingButton.set_visible(false);
        }
    }

    _tickClock() {
        const now = GLib.DateTime.new_now_local();
        this._date.set_text(Format.longDate(now));
        const { time, meridiem } = Format.clockParts(now);
        this._time.set_text(time);
        if (meridiem) {
            this._meridiem.set_text(meridiem);
            this._meridiem.set_visible(true);
        } else {
            this._meridiem.set_visible(false);
        }
    }

    _startClockTick() {
        if (this._clockTimer) return;
        this._clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._active) {
                this._clockTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._tickClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopClockTick() {
        if (this._clockTimer) {
            GLib.source_remove(this._clockTimer);
            this._clockTimer = 0;
        }
    }

    _syncWidth() {
        this.emit('width-changed');
    }
});

