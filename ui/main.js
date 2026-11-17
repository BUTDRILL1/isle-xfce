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
import * as Format from './format.js';

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
        usagePage,         // usage
    ];

    // 5. Mount CompactView and ExpandedView onto overlay
    const compactView = new CompactView(daemon);
    const expandedView = new ExpandedView(daemon, {}, {}, {}, pages);

    // Wire Dynamic Island notification peek alert onto compact notch
    notificationCenter.connect('banner', (_center, notification) => {
        compactView.showNotificationPeek(notification);
    });

    // 6. Settings persistence and Glass Opacity control
    const settingsDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'isle']);
    const settingsPath = GLib.build_filenamev([settingsDir, 'settings.json']);
    
    let currentGlassOpacity = 15;
    globalThis.isleSoundEnabled = true;
    globalThis.isleTabSwitchMode = 'hover';
    globalThis.isleTabHoverHoldTime = 500;

    const loadSettings = () => {
        try {
            const f = Gio.File.new_for_path(settingsPath);
            if (f.query_exists(null)) {
                const [ok, contents] = f.load_contents(null);
                if (ok) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    if (data.glassOpacity !== undefined) currentGlassOpacity = data.glassOpacity;
                    if (data.clockFormat) Format.setClockFormat(data.clockFormat);
                    if (data.soundEnabled !== undefined) globalThis.isleSoundEnabled = Boolean(data.soundEnabled);
                    if (data.tabSwitchMode) globalThis.isleTabSwitchMode = data.tabSwitchMode;
                    if (data.tabHoverHoldTime !== undefined) globalThis.isleTabHoverHoldTime = Number(data.tabHoverHoldTime);
                }
            }
        } catch (e) {
            print('[Isle] Could not load settings:', e.message);
        }
    };

    const saveSettings = () => {
        try {
            GLib.mkdir_with_parents(settingsDir, 0o755);
            const data = {
                glassOpacity: currentGlassOpacity,
                clockFormat: Format.uses12Hour() ? '12h' : '24h',
                soundEnabled: globalThis.isleSoundEnabled !== false,
                tabSwitchMode: globalThis.isleTabSwitchMode || 'hover',
                tabHoverHoldTime: globalThis.isleTabHoverHoldTime || 500,
            };
            const f = Gio.File.new_for_path(settingsPath);
            f.replace_contents(JSON.stringify(data, null, 2), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            print('[Isle] Could not save settings:', e.message);
        }
    };
    globalThis.isleSaveSettings = saveSettings;

    const glassProvider = new Gtk.CssProvider();
    Gtk.StyleContext.add_provider_for_display(win.get_display(), glassProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 20);

    const glArea = overlay.get_child();

    globalThis.isleSetGlassOpacity = (percent) => {
        currentGlassOpacity = percent;
        saveSettings();
        const val = percent > 1 ? percent / 100.0 : percent;
        if (glArea && glArea.set_opacity) {
            glArea.set_opacity(Math.min(1.0, val / 0.15));
        }
        glassProvider.load_from_string(`
            .isle-overlay {
                background-color: rgba(20, 20, 22, ${val.toFixed(2)});
            }
        `);
    };
    globalThis.isleGetGlassOpacity = () => currentGlassOpacity;

    loadSettings();
    globalThis.isleSetGlassOpacity(currentGlassOpacity);

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

    const lightningOverlay = new LightningOverlay();
    overlay.add_overlay(lightningOverlay);
    overlay.add_overlay(compactView);
    overlay.add_overlay(expandedView);

    let lastExpanded = null;
    const updateVisibility = (isExpanded) => {
        if (lastExpanded === isExpanded) return;
        lastExpanded = isExpanded;
        lightningOverlay.setExpanded(isExpanded);

        if (isExpanded) {
            compactView.set_visible(false);
            compactView.set_opacity(0.0);
            expandedView.set_visible(true);
            expandedView.set_opacity(1.0);
            expandedView.setActive(true);
        } else {
            expandedView.set_visible(false);
            expandedView.set_opacity(0.0);
            expandedView.setActive(false);
            compactView.set_visible(true);
            compactView.set_opacity(1.0);
        }
    };

    updateVisibility(false);

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
                        expandedView.toggleAssistant(true);
                        updateVisibility(true);
                    } else if (cmd === 'toggle') {
                        if (expandedView.isAssistantOpen) {
                            expandedView.toggleAssistant(false);
                        } else {
                            expandedView.toggleAssistant(true);
                            updateVisibility(true);
                        }
                    } else if (cmd === 'close') {
                        expandedView.toggleAssistant(false);
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
        const height = win.get_height();
        updateVisibility(height > 150);
        return GLib.SOURCE_CONTINUE;
    });

    // 6. Connect Keyboard navigation
    const keyController = new Gtk.EventControllerKey();
    keyController.connect('key-pressed', (controller, keyval, keycode, state) => {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

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
        if (focusWidget instanceof Gtk.Editable || focusWidget instanceof Gtk.Entry || focusWidget instanceof Gtk.TextView) {
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

