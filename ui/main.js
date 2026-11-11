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
import { Page } from './page.js';
import { AppsPage } from './pages/apps.js';
import { CalendarPage } from './pages/calendar.js';
import { DevicesPage } from './pages/devices.js';
import { MediaPage } from './pages/media.js';
import { ShelfPage } from './pages/shelf.js';
import { TasksPage } from './pages/tasks.js';
import { TimerPage } from './pages/timer.js';
import { UsagePage } from './pages/usage.js';

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

    // 4. Build authentic Page instances for the 10 canonical Isle tabs
    const mediaPage = new MediaPage(daemon);
    const timerPage = new TimerPage(daemon);
    const tasksPage = new TasksPage(daemon);
    const shelfPage = new ShelfPage(daemon);
    const calendarPage = new CalendarPage(daemon);
    const appsPage = new AppsPage(daemon);
    const devicesPage = new DevicesPage(daemon);
    const usagePage = new UsagePage(daemon);

    const otherPages = [
        {
            name: 'call',
            available: false,
            emptyInfo: {
                iconName: 'isle-phone',
                iconSize: 24,
                title: 'No active call',
                hint: 'Audio and video calls show here',
            },
        },
        {
            name: 'notifications',
            available: true,
            emptyInfo: {
                iconName: 'isle-bell',
                iconSize: 24,
                title: 'No notifications',
                hint: 'You’re all caught up',
            },
        },
    ].map(def => new Page(daemon, def));

    // Ordered matching canonical Isle tabs:
    // call, music, notifications, focus, reminders, shelf, calendar, apps, devices, usage
    const pages = [
        otherPages[0], // call
        mediaPage,     // music
        otherPages[1], // notifications
        timerPage,     // focus
        tasksPage,     // reminders
        shelfPage,     // shelf
        calendarPage,  // calendar
        appsPage,      // apps
        devicesPage,   // devices
        usagePage,     // usage
    ];

    // 5. Mount CompactView and ExpandedView onto overlay
    const compactView = new CompactView(daemon);
    const expandedView = new ExpandedView(daemon, {}, {}, {}, pages);

    // Expose for runtime inspection and testing
    globalThis.isleExpanded = expandedView;
    globalThis.isleCompact = compactView;

    overlay.add_overlay(compactView);
    overlay.add_overlay(expandedView);

    let lastExpanded = null;
    const updateVisibility = (isExpanded) => {
        if (lastExpanded === isExpanded) return;
        lastExpanded = isExpanded;

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
                    expandedView.showPage(tabName);
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
                    } else if (cmd === 'close') {
                        expandedView.toggleAssistant(false);
                    } else if (cmd.startsWith('ask:')) {
                        expandedView.toggleAssistant(true);
                        const q = cmd.slice(4);
                        expandedView.assistantView._entry.set_text(q);
                        expandedView.assistantView._submit();
                    } else if (cmd === 'test-card-root') {
                        expandedView.toggleAssistant(true);
                        expandedView.assistantView._presentCommandApprovalCard('install system package');
                    } else if (cmd === 'test-card-removes') {
                        expandedView.toggleAssistant(true);
                        expandedView.assistantView._presentCommandApprovalCard('remove cached files');
                    } else if (cmd === 'test-card-script') {
                        expandedView.toggleAssistant(true);
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
        } catch (_) {}
        return GLib.SOURCE_CONTINUE;
    });

    // Synchronize visibility with live window geometry and spring animations on each GTK tick
    win.add_tick_callback(() => {
        const height = win.get_height();
        updateVisibility(height > 80);
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

