// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! GJS Frontend entry point for Isle XFCE.
//! Mounts upstream Isle Compact and Expanded views directly onto the Rust X11/GTK4 substrate.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import { CompactView } from './compact.js';
import { Daemon } from './daemon.js';
import { ExpandedView } from './expanded.js';
import { LightningOverlay } from './lightning.js';
import { Page } from './page.js';
import { NotificationCenter } from './notifications.js';
import { getAuthStore } from './authStore.js';
import { getSettingsStore } from './settingsStore.js';
import { TalkbackView } from './talkback.js';
import { AppsPage } from './pages/apps.js';
import { CalendarPage } from './pages/calendar.js';
import { DevicesPage } from './pages/devices.js';
import { LightsPage } from './pages/lights.js';
import { MediaPage } from './pages/media.js';
import { NotificationsPage } from './pages/notifications.js';
import { ShelfPage } from './pages/shelf.js';
import { TasksPage } from './pages/tasks.js';
import { TimerPage } from './pages/timer.js';
import { UsagePage } from './pages/usage.js';
import { QuotaPage } from './pages/quota.js';
import * as Format from './format.js';
import { getPowerProfile, setPowerProfile } from './telemetry.js';

export function init() {
    print('[Isle GJS] Initializing Isle UI Frontend with D-Bus Daemon Integration...');

    // Acquire org.gnome.Shell on the session bus for secure caller authorization in isled
    try {
        Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.gnome.Shell',
            Gio.BusNameOwnerFlags.NONE,
            null,
            () => print('[Isle GJS] Acquired org.gnome.Shell bus name for secure D-Bus caller authorization'),
            () => print('[Isle GJS] Note: org.gnome.Shell bus name already held or not acquired')
        );
    } catch (e) {
        print('[Isle GJS] Note on org.gnome.Shell ownership:', e.message);
    }

    // 1. Locate active window and overlay from the Rust host
    const app = Gtk.Application.get_default();
    if (!app) {
        print('[Isle GJS] ERROR: No default GtkApplication found');
        return;
    }

    const win = app.get_active_window();
    if (!win) {
        print('[Isle GJS] ERROR: No active GtkWindow found');
        return;
    }

    // 2. Inject normalized Isle stylesheet
    const provider = new Gtk.CssProvider();
    const cssFile = Gio.File.new_for_path('/home/butarch/Desktop/isle-xfce/ui/stylesheet-gtk.css');
    try {
        provider.load_from_file(cssFile);
        const display = win.get_display();
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 10);
        print('[Isle GJS] Successfully injected stylesheet-gtk.css into display provider');
    } catch (err) {
        print('[Isle GJS] Error loading CSS:', err.message);
    }

    const overlay = win.get_child();
    if (!overlay || !(overlay instanceof Gtk.Overlay)) {
        print('[Isle GJS] ERROR: Window child is not a GtkOverlay:', overlay);
        return;
    }

    overlay.set_overflow(Gtk.Overflow.HIDDEN);

    // 3. Connect to the running isled D-Bus daemon
    const daemon = new Daemon();
    globalThis.isleDaemon = daemon;

    // Notification center & FreeDesktop notification server
    const notificationCenter = new NotificationCenter();
    globalThis.isleNotifications = notificationCenter;

    // 3b. Centralized settings & auth initialization (loaded before building pages)
    const settingsStore = getSettingsStore();
    getAuthStore();

    const chargeLimitListeners = new Set();
    const notifyChargeLimitListeners = () => {
        const snapshot = globalThis.isleGetChargeLimit();
        for (const fn of chargeLimitListeners) {
            try {
                fn(snapshot);
            } catch (e) {
                print('[Isle] Charge limit listener error:', e.message);
            }
        }
    };

    globalThis.isleSaveSettings = () => settingsStore.save({ absorbGlobals: true });

    globalThis.isleGetChargeLimit = () => {
        const s = settingsStore.get();
        return {
            enabled: Boolean(s.chargeLimitEnabled),
            percent: s.chargeLimitPercent,
        };
    };

    globalThis.isleOnChargeLimitChanged = (fn) => {
        chargeLimitListeners.add(fn);
        return () => chargeLimitListeners.delete(fn);
    };

    globalThis.isleSetChargeLimit = ({ enabled, percent } = {}, { save = true } = {}) => {
        settingsStore.update(s => {
            if (enabled !== undefined) s.chargeLimitEnabled = Boolean(enabled);
            if (percent !== undefined) s.chargeLimitPercent = percent;
        }, 'chargeLimit', { save });
        return globalThis.isleGetChargeLimit();
    };

    const hexToRgbTuple = (hex, fallback = '10, 132, 255') => {
        if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
        return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16),
        ].join(', ');
    };

    const themeProvider = new Gtk.CssProvider();
    Gtk.StyleContext.add_provider_for_display(win.get_display(), themeProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 20);

    const glArea = overlay.get_child();

    const applyThemeCss = () => {
        const s = settingsStore.get();
        const op = s.glassOpacity > 1 ? s.glassOpacity / 100.0 : s.glassOpacity;
        if (glArea && glArea.set_opacity) {
            glArea.set_opacity(Math.min(1.0, op / 0.15));
        }
        const accent = s.appearance.accentColor || '#0a84ff';
        const accRgb = hexToRgbTuple(accent, '10, 132, 255');
        const chg = s.appearance.batteryChargingColor || '#30d158';
        const cap = s.appearance.batteryCappedColor || '#0a84ff';
        const capRgb = hexToRgbTuple(cap, '10, 132, 255');

        themeProvider.load_from_string(`
            .isle-overlay {
                background-color: rgba(20, 20, 22, ${op.toFixed(2)});
            }
            .isle-pill-accent,
            button.isle-settings-nav-btn.active,
            .isle-settings-scale highlight {
                background-color: ${accent};
            }
            .isle-settings-value,
            .isle-header-settings.active {
                color: ${accent};
            }
            .isle-output-chip.active {
                background-color: rgba(${accRgb}, 0.28);
            }
            .isle-settings-tab-row.dragging {
                background-color: rgba(${accRgb}, 0.24);
                border-color: rgba(${accRgb}, 0.75);
            }
            entry.isle-settings-entry:focus-within,
            passwordentry.isle-settings-entry:focus-within {
                border-color: ${accent};
            }
            .isle-compact-vstat.charging .isle-compact-vdigit {
                color: ${chg};
            }
            .isle-compact-vstat.capped .isle-compact-vdigit {
                color: ${cap};
            }
            button.isle-battery-cap-btn.cap-active,
            #isleIsland.isle-translucent button.isle-battery-cap-btn.cap-active,
            #isleIsland.isle-glass-dark button.isle-battery-cap-btn.cap-active {
                background-color: rgba(${capRgb}, 0.28);
                border-color: rgba(${capRgb}, 0.55);
                color: ${cap};
            }
            button.isle-battery-cap-btn.cap-active:hover,
            #isleIsland.isle-translucent button.isle-battery-cap-btn.cap-active:hover,
            #isleIsland.isle-glass-dark button.isle-battery-cap-btn.cap-active:hover {
                background-color: rgba(${capRgb}, 0.38);
            }
        `);
    };

    globalThis.isleSetGlassOpacity = (percent, { save = true } = {}) => {
        settingsStore.update(s => {
            s.glassOpacity = percent;
        }, 'appearance', { save });
    };
    globalThis.isleGetGlassOpacity = () => settingsStore.get().glassOpacity;

    applyThemeCss();
    settingsStore.syncTtsMuteFlag();

    let syncingDnd = false;
    notificationCenter.dnd = Boolean(settingsStore.get().dndEnabled);
    notificationCenter.connect('dnd-changed', () => {
        if (syncingDnd) return;
        settingsStore.update(s => {
            s.dndEnabled = Boolean(notificationCenter.dnd);
        }, 'dnd');
    });

    const initPower = settingsStore.get().powerProfile;
    if (initPower && initPower !== getPowerProfile()) {
        setPowerProfile(initPower, null, { silent: true });
    }

    // 4. Build authentic Page instances for the 10 canonical Isle tabs
    const mediaPage = new MediaPage(daemon);
    const notificationsPage = new NotificationsPage(daemon, notificationCenter);
    const timerPage = new TimerPage(daemon);
    const tasksPage = new TasksPage(daemon);
    const shelfPage = new ShelfPage(daemon);
    const calendarPage = new CalendarPage(daemon);
    const appsPage = new AppsPage(daemon);
    const devicesPage = new DevicesPage(daemon, { notificationCenter });
    const lightsPage = new LightsPage(daemon);
    const quotaPage = new QuotaPage(daemon);
    const usagePage = new UsagePage(daemon);

    const callPage = new Page(daemon, {
        name: 'call',
        available: false,
        emptyInfo: {
            iconName: 'isle-phone',
            iconSize: 24,
            title: 'No active call',
            hint: 'Audio and video calls show here',
        },
    });

    // Ordered matching canonical Isle tabs:
    // call, music, notifications, focus, reminders, shelf, calendar, apps, devices, usage
    const pages = [
        callPage,          // call
        mediaPage,         // music
        notificationsPage, // notifications
        timerPage,         // focus
        tasksPage,         // reminders
        shelfPage,         // shelf
        calendarPage,      // calendar
        appsPage,          // apps
        devicesPage,       // devices
        lightsPage,        // lights
        quotaPage,         // quota
        usagePage,         // usage
    ];

    // 5. Mount CompactView and ExpandedView onto overlay
    const compactView = new CompactView(daemon);
    const expandedView = new ExpandedView(daemon, {}, {}, {}, pages);

    const applyOpenMode = () => {
        if (settingsStore.get().behavior.openMode === 'click') {
            win.add_css_class('isle-click-to-open');
        } else {
            win.remove_css_class('isle-click-to-open');
        }
    };
    const pushUsageConfig = () => {
        if (daemon._proxies?.['usage']) {
            daemon.call('usage', 'SetConfig', JSON.stringify(settingsStore.get().usage)).catch(() => {});
        }
    };
    const pushLyricsConfig = () => {
        if (daemon._proxies?.['media']) {
            daemon.call('media', 'SetLyrics', Boolean(settingsStore.get().behavior.lyricsEnabled)).catch(() => {});
        }
    };

    const initState = settingsStore.get();
    expandedView.applyTabConfig(initState.tabs);
    expandedView.applyHeaderConfig(initState.header);
    applyOpenMode();
    if (initState.tabs.defaultTab !== 'last') {
        expandedView.showPage(initState.tabs.defaultTab, { animate: false });
    }

    daemon.connect('appeared', (_d, ifaceName) => {
        if (ifaceName === 'media') pushLyricsConfig();
        if (ifaceName === 'usage') pushUsageConfig();
    });

    settingsStore.subscribe('*', (state, topics) => {
        if (topics.includes('*') || topics.includes('appearance')) {
            applyThemeCss();
        }
        if (topics.includes('*') || topics.includes('tabs')) {
            expandedView.applyTabConfig(state.tabs);
        }
        if (topics.includes('*') || topics.includes('header')) {
            expandedView.applyHeaderConfig(state.header);
        }
        if (topics.includes('*') || topics.includes('behavior')) {
            applyOpenMode();
            pushLyricsConfig();
        }
        if (topics.includes('*') || topics.includes('usage')) {
            pushUsageConfig();
        }
        if (topics.includes('*') || topics.includes('chargeLimit')) {
            notifyChargeLimitListeners();
        }
        if (topics.includes('*') || topics.includes('clock')) {
            expandedView._tickClock();
            compactView._tickClock();
        }
        if (topics.includes('*') || topics.includes('assistant')) {
            settingsStore.syncTtsMuteFlag();
        }
        if (topics.includes('*') || topics.includes('dnd')) {
            syncingDnd = true;
            notificationCenter.dnd = Boolean(state.dndEnabled);
            syncingDnd = false;
        }
    });

    // Wire Dynamic Island notification peek alert onto compact notch
    notificationCenter.connect('banner', (_center, notification) => {
        compactView.showNotificationPeek(notification);
    });

    // Connect settings gear from header
    expandedView.connect('settings-requested', () => {
        expandedView.toggleSettings();
    });

    // Expose for runtime inspection and testing
    globalThis.isleExpanded = expandedView;
    globalThis.isleCompact = compactView;

    // Global Alarm / Timer Ringing Alert dispatcher (dispatches to expanded or compact based on open state)
    globalThis.isleShowAlert = (alert) => {
        if (lastExpanded) {
            expandedView.showAlarmOverlay(alert);
        } else {
            compactView.showAlarmAlert(alert);
        }
    };

    const talkbackView = new TalkbackView(daemon);
    talkbackView.set_visible(false);
    talkbackView.set_opacity(0.0);

    const lightningOverlay = new LightningOverlay();
    overlay.add_overlay(lightningOverlay);
    overlay.add_overlay(compactView);
    overlay.add_overlay(expandedView);
    overlay.add_overlay(talkbackView);

    let lastExpanded = null;
    let lastHeight = -1;
    let talkbackVisualActive = false;

    talkbackView.connect('close-requested', () => {
        win.remove_css_class('isle-mode-talkback');
        lastHeight = -1;
        syncMorphProgress(win.get_height());
    });

    const syncMorphProgress = (height) => {
        if (height === lastHeight) return;
        lastHeight = height;

        const isTalkback = win.has_css_class('isle-mode-talkback');
        if (isTalkback) {
            talkbackVisualActive = true;
        } else if (height <= 42) {
            talkbackVisualActive = false;
        }

        // Smoothly fade out compactView from height 38..85, then fade in active view (Talkback 240x240 or Expanded)
        if (height <= 85) {
            const compactAlpha = Math.max(0, Math.min(1, 1 - (height - 38) / 47));
            expandedView.set_visible(false);
            expandedView.set_opacity(0.0);
            talkbackView.set_visible(false);
            talkbackView.set_opacity(0.0);
            compactView.set_visible(true);
            compactView.set_opacity(compactAlpha);
            if (lastExpanded !== false) {
                lastExpanded = false;
                lightningOverlay.setExpanded(false);
                expandedView.setActive(false);
            }
        } else if (talkbackVisualActive) {
            const tbAlpha = Math.max(0, Math.min(1, (height - 85) / 115));
            compactView.set_visible(false);
            compactView.set_opacity(0.0);
            expandedView.set_visible(false);
            expandedView.set_opacity(0.0);
            talkbackView.set_visible(true);
            talkbackView.set_opacity(tbAlpha);
            if (lastExpanded !== true) {
                lastExpanded = true;
                lightningOverlay.setExpanded(true);
                expandedView.setActive(false);
            }
        } else {
            const expAlpha = Math.max(0, Math.min(1, (height - 85) / 135));
            compactView.set_visible(false);
            compactView.set_opacity(0.0);
            talkbackView.set_visible(false);
            talkbackView.set_opacity(0.0);
            expandedView.set_visible(true);
            expandedView.set_opacity(expAlpha);
            if (lastExpanded !== true) {
                lastExpanded = true;
                lightningOverlay.setExpanded(true);
                const defTab = settingsStore.get().tabs.defaultTab;
                if (
                    defTab &&
                    defTab !== 'last' &&
                    !expandedView.isSettingsOpen &&
                    !expandedView.isAssistantOpen &&
                    !win.has_css_class('isle-force-expand')
                ) {
                    expandedView.showPage(defTab, { animate: false });
                }
                expandedView.setActive(true);
            }
        }
    };

    const updateVisibility = (isExpanded) => {
        lastHeight = -1;
        syncMorphProgress(isExpanded ? 300 : 38);
    };

    syncMorphProgress(38);

    // IPC trigger for automated verification
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        try {
            const f = Gio.File.new_for_path('/tmp/isle_tab');
            if (f.query_exists(null)) {
                const [ok, contents] = f.load_contents(null);
                if (ok) {
                    const tabName = new TextDecoder().decode(contents).trim();
                    f.delete(null);
                    print(`[Isle GJS IPC] Switching to requested tab: ${tabName}`);
                    talkbackVisualActive = false;
                    win.remove_css_class('isle-mode-talkback');
                    win.add_css_class('isle-force-expand');
                    updateVisibility(true);
                    if (tabName === 'settings') {
                        expandedView.toggleSettings(true);
                    } else {
                        expandedView.showPage(tabName);
                    }
                }
            }

            const fAsst = Gio.File.new_for_path('/tmp/isle_assistant');
            if (fAsst.query_exists(null)) {
                const [ok, contents] = fAsst.load_contents(null);
                if (ok) {
                    const cmd = new TextDecoder().decode(contents).trim();
                    fAsst.delete(null);
                    print(`[Isle GJS IPC] Assistant command: ${cmd}`);
                    if (cmd === 'open') {
                        talkbackVisualActive = false;
                        win.remove_css_class('isle-mode-talkback');
                        expandedView.toggleAssistant(true);
                        updateVisibility(true);
                    } else if (cmd === 'toggle') {
                        if (win.has_css_class('isle-mode-talkback') || talkbackView.isOpen) {
                            talkbackView.close();
                        } else {
                            if (expandedView.isAssistantOpen) {
                                expandedView.toggleAssistant(false);
                            }
                            win.remove_css_class('isle-force-expand');
                            win.remove_css_class('isle-mode-assistant');
                            talkbackVisualActive = true;
                            win.add_css_class('isle-mode-talkback');
                            talkbackView.open();
                            syncMorphProgress(Math.max(win.get_height(), 90));
                        }
                    } else if (cmd === 'close') {
                        if (win.has_css_class('isle-mode-talkback') || talkbackView.isOpen) {
                            talkbackView.close();
                        } else {
                            expandedView.toggleAssistant(false);
                        }
                    } else if (cmd.startsWith('ask:')) {
                        expandedView.toggleAssistant(true);
                        updateVisibility(true);
                        const q = cmd.slice(4);
                        expandedView.assistantView._entry.set_text(q);
                        expandedView.assistantView._submit();
                    } else if (cmd === 'test-card-root') {
                        expandedView.toggleAssistant(true);
                        updateVisibility(true);
                        expandedView.assistantView._presentCommandApprovalCard('install system package');
                    } else if (cmd === 'test-card-removes') {
                        expandedView.toggleAssistant(true);
                        updateVisibility(true);
                        expandedView.assistantView._presentCommandApprovalCard('remove cached files');
                    } else if (cmd === 'test-card-script') {
                        expandedView.toggleAssistant(true);
                        updateVisibility(true);
                        expandedView.assistantView._presentCommandApprovalCard('run remote script');
                    } else if (cmd === 'approve') {
                        expandedView.assistantView._onCardDecided(true);
                    } else if (cmd === 'deny') {
                        expandedView.assistantView._onCardDecided(false);
                    } else if (cmd === 'clear') {
                        expandedView.assistantView.clearConversation();
                    }
                }
            }

            const fSettings = Gio.File.new_for_path('/tmp/isle_settings');
            if (fSettings.query_exists(null)) {
                const [ok, contents] = fSettings.load_contents(null);
                if (ok) {
                    const cmd = new TextDecoder().decode(contents).trim();
                    fSettings.delete(null);
                    print(`[Isle GJS IPC] Settings command: ${cmd}`);
                    if (cmd === 'open') {
                        win.add_css_class('isle-force-expand');
                        updateVisibility(true);
                        expandedView.toggleSettings(true);
                    } else if (cmd === 'toggle') {
                        if (expandedView.isSettingsOpen) {
                            expandedView.toggleSettings(false);
                        } else {
                            win.add_css_class('isle-force-expand');
                            updateVisibility(true);
                            expandedView.toggleSettings(true);
                        }
                    } else if (cmd === 'close') {
                        expandedView.toggleSettings(false);
                        win.remove_css_class('isle-force-expand');
                    }
                }
            }

            const fAlert = Gio.File.new_for_path('/tmp/isle_test_alert');
            if (fAlert.query_exists(null)) {
                const [ok, contents] = fAlert.load_contents(null);
                if (ok) {
                    const mode = new TextDecoder().decode(contents).trim();
                    fAlert.delete(null);
                    if (mode === 'open') {
                        win.add_css_class('isle-force-expand');
                        updateVisibility(true);
                        expandedView.showAlarmOverlay({
                            type: 'timer',
                            timeStr: '00:00',
                            labelText: "Timer Done!",
                            onDismiss: () => {
                                print('[Test] Dismissed open overlay');
                                win.remove_css_class('isle-force-expand');
                            },
                            onSnooze: () => {
                                print('[Test] Snoozed open overlay');
                                win.remove_css_class('isle-force-expand');
                            },
                        });
                    } else {
                        win.remove_css_class('isle-force-expand');
                        updateVisibility(false);
                        compactView.showAlarmAlert({
                            type: 'alarm',
                            timeStr: '07:00',
                            labelText: 'Morning Alarm',
                            onDismiss: () => print('[Test] Dismissed compact alert'),
                            onSnooze: () => print('[Test] Snoozed compact alert'),
                        });
                    }
                }
            }
        } catch (e) {
            print('[Isle IPC ERROR]', e);
        }
        return GLib.SOURCE_CONTINUE;
    });

    // Synchronize visibility with live window geometry and spring animations on each GTK tick
    win.add_tick_callback(() => {
        syncMorphProgress(win.get_height());
        return GLib.SOURCE_CONTINUE;
    });

    // 6. Connect Keyboard navigation
    const keyController = new Gtk.EventControllerKey();
    keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

        if (win.has_css_class('isle-mode-talkback') || talkbackView.isOpen) {
            if (keyval === Gdk.KEY_Escape) {
                talkbackView.close();
                return true;
            }
        }

        // When Assistant is open, let Gtk.Entry receive all normal keyboard input
        // and handle Escape to close Assistant.
        if (expandedView.isAssistantOpen) {
            if (keyval === Gdk.KEY_Escape) {
                expandedView.toggleAssistant(false);
                return true;
            }
            return false;
        }

        // Check if an editable widget has focus in the window
        const focusWidget = win.get_focus();
        const isEditing = Boolean(focusWidget && (
            focusWidget instanceof Gtk.Editable ||
            focusWidget instanceof Gtk.Entry ||
            focusWidget instanceof Gtk.PasswordEntry ||
            focusWidget instanceof Gtk.TextView ||
            focusWidget.get_ancestor?.(Gtk.Editable)
        ));
        if (isEditing) {
            return false;
        }

        if (expandedView.isSettingsOpen) {
            if (keyval === Gdk.KEY_Escape) {
                expandedView.toggleSettings(false);
                return true;
            }
            return false;
        }

        // Ctrl+Tab / Ctrl+Shift+Tab
        if (ctrl && (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab)) {
            expandedView.stepPage(shift ? -1 : 1);
            return true;
        }

        // Left / Right Arrow navigation when expanded
        if (keyval === Gdk.KEY_Left) {
            expandedView.stepPage(-1);
            return true;
        }
        if (keyval === Gdk.KEY_Right) {
            expandedView.stepPage(1);
            return true;
        }

        // 1..9 number keys to switch directly to tabs
        if (keyval >= Gdk.KEY_1 && keyval <= Gdk.KEY_9) {
            const tabNum = keyval - Gdk.KEY_1 + 1;
            expandedView.showTab(tabNum);
            return true;
        }

        return false;
    });
    win.add_controller(keyController);

    print('[Isle GJS] Isle UI Frontend initialized successfully with live daemon data.');
}

init();

