// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Expanded island view with tab bar, page container, and navigation for Isle XFCE.
//! Faithful port of upstream gnome-extension/src/expanded.js.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import * as Format from './format.js';
import * as Playback from './playback.js';
import { AssistantView } from './assistant.js';
import { SettingsPage } from './pages/settings.js';
import {
    Bars,
    PrivacyDots,
    RecordingDot,
    Ring,
    icon,
    iconButton,
    label,
    pillButton,
} from './widgets.js';

export const STANDARD_EXPANDED_WIDTH = 600;
export const STANDARD_EXPANDED_HEIGHT = 300;

export const ASSISTANT_EXPANDED_WIDTH = 640;
export const ASSISTANT_EXPANDED_HEIGHT = 380;

export const EXPANDED_WIDTH = STANDARD_EXPANDED_WIDTH;
export const EXPANDED_HEIGHT = STANDARD_EXPANDED_HEIGHT;
export const PAGE_HEIGHT = 240;
export const LARGE_WIDTH = 720;
export const LARGE_PAGE_HEIGHT = 340;
export const BOTTOM_PADDING = 14;
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
const getHoverDwellMs = () => {
    const val = globalThis.isleTabHoverHoldTime;
    return (typeof val === 'number' && val >= 100) ? val : 500;
};
const isHoverSwitchEnabled = () => globalThis.isleTabSwitchMode !== 'click';
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
        this.set_size_request(-1, -1);

        this._daemon = daemon || { state: {} };
        if (typeof this._daemon.connect === 'function') {
            this._daemon.connect('changed', (_daemon, key) => {
                if (key === 'nowPlaying' && this._active) {
                    this._updateHeader();
                }
            });
        }
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

        // 2. Build Pager (GtkStack sliding page container)
        this._pagerArea = this._buildPager();

        // 3. Bottom padding widget (20px)
        const bottom = new Gtk.Box({
            valign: Gtk.Align.END,
            css_classes: ['isle-expanded-bottom'],
        });
        bottom.set_size_request(-1, BOTTOM_PADDING);

        // 4. Normal view containing header, pager, and bottom padding
        const normalBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });
        normalBox.append(this._header);
        normalBox.append(this._pagerArea);
        normalBox.append(bottom);

        // 5. Stack switching between Normal view and Alarm blanking overlay
        this._overlayStack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 180,
            hexpand: true,
            vexpand: true,
        });

        this._alarmOverlay = this._buildAlarmOverlay();
        this._overlayStack.add_named(normalBox, 'normal');
        this._overlayStack.add_named(this._alarmOverlay, 'alarm');
        this._overlayStack.set_visible_child_name('normal');

        this.append(this._overlayStack);

        // Connect page signals
        for (const page of this._pages) {
            page.connect('width-changed', () => {
                if (page === this.page) this._syncWidth();
            });
            page.connect('height-changed', () => {
                if (page === this.page) this._syncHeight();
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
        this._syncHeight();
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
        let micHoverTimerId = 0;
        this._clearMicHoverTimer = () => {
            if (micHoverTimerId) {
                GLib.source_remove(micHoverTimerId);
                micHoverTimerId = 0;
            }
        };

        this._micButton = iconButton('isle-sparkle-symbolic', 'isle-button-flat isle-header-mic', () => {
            this._clearMicHoverTimer();
            this.emit('voice-requested');
        }, { size: 15, accessibleName: 'AI assistant' });

        const micMotion = new Gtk.EventControllerMotion();
        micMotion.connect('enter', () => {
            this._micButton.set_opacity(1.0);
            if (!this._assistantActive && isHoverSwitchEnabled()) {
                this._clearMicHoverTimer();
                micHoverTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, getHoverDwellMs(), () => {
                    micHoverTimerId = 0;
                    if (!this._assistantActive) {
                        this.emit('voice-requested');
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        micMotion.connect('leave', () => {
            this._clearMicHoverTimer();
            if (!this._assistantActive) {
                this._micButton.set_opacity(0.6);
            }
        });
        this._micButton.add_controller(micMotion);
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
        let settingsHoverTimerId = 0;
        this._clearSettingsHoverTimer = () => {
            if (settingsHoverTimerId) {
                GLib.source_remove(settingsHoverTimerId);
                settingsHoverTimerId = 0;
            }
        };

        const settings = this._settingsBtn = iconButton('isle-settings', 'isle-button-flat isle-header-settings', () => {
            this._clearSettingsHoverTimer();
            this.emit('settings-requested');
        }, { size: 15, accessibleName: 'Settings' });
        settings.set_opacity(SETTINGS_OPACITY);

        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', () => {
            settings.set_opacity(1.0);
            if (!this._settingsActive && isHoverSwitchEnabled()) {
                this._clearSettingsHoverTimer();
                settingsHoverTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, getHoverDwellMs(), () => {
                    settingsHoverTimerId = 0;
                    if (!this._settingsActive) {
                        this.emit('settings-requested');
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        motion.connect('leave', () => {
            this._clearSettingsHoverTimer();
            if (!this._settingsActive) settings.set_opacity(SETTINGS_OPACITY);
        });
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

            let hoverTimerId = 0;
            const clearHoverTimer = () => {
                if (hoverTimerId) {
                    GLib.source_remove(hoverTimerId);
                    hoverTimerId = 0;
                }
            };

            tab.connect('clicked', () => {
                clearHoverTimer();
                this.showPage(index);
            });

            const motion = new Gtk.EventControllerMotion();
            motion.connect('enter', () => {
                if (index !== this._index || this._assistantActive || this._settingsActive) {
                    tabIcon.set_opacity(TAB_OPACITY.hover);
                    if (isHoverSwitchEnabled()) {
                        clearHoverTimer();
                        hoverTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, getHoverDwellMs(), () => {
                            hoverTimerId = 0;
                            this.showPage(index);
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
            });
            motion.connect('leave', () => {
                clearHoverTimer();
                if (index !== this._index || this._assistantActive || this._settingsActive) {
                    tabIcon.set_opacity(TAB_OPACITY.idle);
                }
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
                clearHoverTimer,
            };
        });

        return tabsBox;
    }

    _buildPager() {
        const area = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            css_classes: ['isle-pager-area'],
        });

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

        // Assistant view inside content stack
        this._assistantView = new AssistantView(this._daemon);
        this._assistantView.connect('close-requested', () => {
            this.toggleAssistant(false);
        });

        // Settings view inside content stack
        this._settingsPage = new SettingsPage(this._daemon);
        this._settingsPage.connect('request-close', () => {
            this.toggleSettings(false);
        });

        this._contentStack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 180,
            hexpand: true,
            vexpand: true,
        });

        this._contentStack.add_named(this._pager, 'pager');
        this._contentStack.add_named(this._assistantView, 'assistant');
        this._contentStack.add_named(this._settingsPage, 'settings');
        this._contentStack.set_visible_child_name('pager');

        area.append(this._contentStack);

        this.connect('voice-requested', () => {
            this.toggleAssistant();
        });

        return area;
    }

    _buildAlarmOverlay() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-alarm-overlay'],
        });

        // Icon + Subtitle
        const topRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        this._expandedAlarmIcon = new Gtk.Image({
            gicon: icon('isle-timer'),
            pixel_size: 28,
        });
        topRow.append(this._expandedAlarmIcon);

        this._expandedAlarmHint = label("Time's Up!", 'isle-alarm-overlay-hint');
        topRow.append(this._expandedAlarmHint);
        box.append(topRow);

        // Huge Time Display
        this._expandedAlarmTime = label('00:00', 'isle-alarm-overlay-time', {
            halign: Gtk.Align.CENTER,
        });
        box.append(this._expandedAlarmTime);

        // Action Buttons Row: Dismiss & Snooze
        const btnRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 20,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });

        const dismissBtn = pillButton('Dismiss', 'isle-pill-small isle-alarm-overlay-btn', () => {
            this._endAlarmOverlay();
            if (this._onExpandedAlarmDismiss) this._onExpandedAlarmDismiss();
        });
        dismissBtn.set_size_request(130, 42);
        btnRow.append(dismissBtn);

        const snoozeBtn = pillButton('Snooze (+5m)', 'isle-pill-accent isle-alarm-overlay-btn', () => {
            this._endAlarmOverlay();
            if (this._onExpandedAlarmSnooze) this._onExpandedAlarmSnooze();
        });
        snoozeBtn.set_size_request(140, 42);
        btnRow.append(snoozeBtn);

        box.append(btnRow);
        return box;
    }

    showAlarmOverlay({ type = 'timer', timeStr = '00:00', labelText = "Time's Up!", onDismiss = null, onSnooze = null }) {
        this._onExpandedAlarmDismiss = onDismiss;
        this._onExpandedAlarmSnooze = onSnooze;

        this._expandedAlarmHint.set_text(labelText);
        this._expandedAlarmTime.set_text(timeStr);
        this._expandedAlarmIcon.set_from_gicon(icon(type === 'alarm' ? 'isle-bell' : 'isle-timer'));

        this._overlayStack.set_visible_child_name('alarm');
    }

    _endAlarmOverlay() {
        this._overlayStack.set_visible_child_name('normal');
    }

    _clearAllHoverTimers() {
        this._tabs?.forEach(t => t.clearHoverTimer?.());
        this._clearMicHoverTimer?.();
        this._clearSettingsHoverTimer?.();
    }

    toggleAssistant(open = null) {
        this._clearAllHoverTimers();
        const isAssistant = this._contentStack.get_visible_child_name() === 'assistant';
        const target = open !== null ? open : !isAssistant;
        const win = this.get_root() || Gtk.Application.get_default()?.get_active_window();
        if (target) {
            if (this._settingsActive) {
                this.toggleSettings(false);
            }
            this._contentStack.set_visible_child_name('assistant');
            this._assistantActive = true;
            if (win && win.add_css_class) {
                win.add_css_class('isle-mode-assistant');
            }
            this._syncHeight();
            this.focusAssistantEntry();
        } else {
            this._contentStack.set_visible_child_name('pager');
            this._assistantActive = false;
            if (win && win.remove_css_class) {
                win.remove_css_class('isle-mode-assistant');
            }
            this._syncHeight();
        }
    }

    toggleSettings(open = null) {
        this._clearAllHoverTimers();
        const isSettings = this._contentStack.get_visible_child_name() === 'settings';
        const target = open !== null ? open : !isSettings;
        if (target) {
            if (this._assistantActive) {
                this.toggleAssistant(false);
            }
            this._contentStack.set_visible_child_name('settings');
            this._settingsActive = true;
            this._settingsBtn?.add_css_class('active');
            this._settingsBtn?.set_opacity(1.0);
            this._syncHeight();
        } else {
            this._contentStack.set_visible_child_name('pager');
            this._settingsActive = false;
            this._settingsBtn?.remove_css_class('active');
            this._settingsBtn?.set_opacity(SETTINGS_OPACITY);
            this._syncHeight();
        }
    }

    showSettings() {
        this.toggleSettings(true);
    }

    get isSettingsOpen() {
        return Boolean(this._settingsActive);
    }

    get settingsPage() {
        return this._settingsPage;
    }

    focusAssistantEntry() {
        if (!this._assistantView || !this._assistantView._entry) return;
        this._assistantView._entry.grab_focus();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._assistantActive && this._assistantView?._entry) {
                this._assistantView._entry.grab_focus();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    get assistantView() {
        return this._assistantView;
    }

    get isAssistantOpen() {
        return Boolean(this._assistantActive);
    }

    get page() {
        return this._pages[this._index];
    }

    get pageHeight() {
        return this.page?.pageHeight ?? PAGE_HEIGHT;
    }

    get preferredWidth() {
        return this.isAssistantOpen ? ASSISTANT_EXPANDED_WIDTH : STANDARD_EXPANDED_WIDTH;
    }

    get preferredHeight() {
        return this.isAssistantOpen ? ASSISTANT_EXPANDED_HEIGHT : STANDARD_EXPANDED_HEIGHT;
    }

    showPage(target, { animate = true } = {}) {
        this._clearAllHoverTimers();
        if (target === 'settings') {
            this.toggleSettings(true);
            return;
        }

        if (this._contentStack && this._contentStack.get_visible_child_name() === 'settings') {
            this.toggleSettings(false);
        }

        if (this._contentStack && this._contentStack.get_visible_child_name() === 'assistant') {
            this.toggleAssistant(false);
        }

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
        this._syncHeight();
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
        this._syncHeight();
        if (page !== this.page || page.available) return;
        const index = this._nearestAvailable(this._index, 1) ?? this._nearestAvailable(this._index, -1);
        if (index !== null) {
            this.showPage(index);
        }
    }

    _syncHeight() {
        const win = this.get_root() || Gtk.Application.get_default()?.get_active_window();
        if (!win || !win.get_css_classes) return;

        let targetH = 300;
        if (this._assistantActive) {
            targetH = 380;
        } else if (this._settingsActive) {
            targetH = 300;
        } else if (this.page && typeof this.page.getDesiredHeight === 'function') {
            targetH = this.page.getDesiredHeight();
        } else if (this.page?.name === 'music' || this.page?.name === 'focus') {
            targetH = 195;
        } else if (this.page?.name === 'shelf' || this.page?.name === 'usage') {
            targetH = 240;
        }

        const classes = win.get_css_classes();
        for (const cls of classes) {
            if (cls.startsWith('isle-h-')) {
                win.remove_css_class(cls);
            }
        }
        win.add_css_class(`isle-h-${targetH}`);
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
        // Equalizer Bars: show flat line when paused, bouncing when music is playing
        this._headerBars.set_visible(true);
        this._headerBars.playing = this._active && Playback.isPlaying(this._daemon?.state?.nowPlaying);

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

    destroy() {
        this._clearAllHoverTimers();
        this._stopClockTick();
    }
});

