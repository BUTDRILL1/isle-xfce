// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Categorized Isle Settings Hub for Isle XFCE expanded view.
//! Zero popovers/dropdowns (all inline chips, sliders, toggles, and entries)
//! to preserve X11 override-redirect focus and hover state.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { Page } from '../page.js';
import { icon, label, pillButton } from '../widgets.js';
import { BotIcon } from '../botIcon.js';
import { COLORS, SHAPES, paletteFor } from '../bot.js';
import {
    ACCENT_PRESETS,
    AI_PROVIDERS,
    INDICATOR_COLORS,
    KEEP_CHAT_OPTIONS,
    LANGUAGE_OPTIONS,
    NIM_MODELS,
    TAB_CATALOG,
    WHISPER_MODELS,
    getSettingsStore,
} from '../settingsStore.js';
import { getAuthStore } from '../authStore.js';
import { getPowerProfile, getTelemetryMonitor, setPowerProfile } from '../telemetry.js';

const CATEGORIES = [
    { id: 'tabs', label: 'Tabs' },
    { id: 'look', label: 'Look' },
    { id: 'behavior', label: 'Behavior' },
    { id: 'hardware', label: 'Hardware' },
    { id: 'ai', label: 'AI & Auth' },
    { id: 'system', label: 'System' },
];

const TAB_META = new Map(TAB_CATALOG.map(t => [t.id, t]));

function clearChildren(box) {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}

function makeCard(orientation = Gtk.Orientation.VERTICAL) {
    return new Gtk.Box({
        orientation,
        spacing: 6,
        hexpand: true,
        css_classes: ['isle-settings-card'],
    });
}

function makeTitleBox(titleText, subtitleText) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 1,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    });
    const t = label(titleText, 'isle-title');
    t.set_halign(Gtk.Align.START);
    const s = label(subtitleText, 'isle-subtitle');
    s.set_halign(Gtk.Align.START);
    s.set_ellipsize(Pango.EllipsizeMode.END);
    box.append(t);
    box.append(s);
    return { box, title: t, subtitle: s };
}

function styleChip(btn, active) {
    btn.set_css_classes(['isle-output-chip', active ? 'active' : 'idle']);
}

function makeChipRows(items, getActiveId, onSelect, { perRow = 5 } = {}) {
    const outer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        hexpand: true,
    });
    const buttons = [];

    const sync = () => {
        const activeId = getActiveId();
        buttons.forEach(({ btn, id }) => styleChip(btn, id === activeId));
    };

    for (let i = 0; i < items.length; i += perRow) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 5,
            hexpand: true,
        });
        for (const item of items.slice(i, i + perRow)) {
            const btn = new Gtk.Button({
                label: item.label,
                tooltip_text: item.tooltip || item.label,
                hexpand: perRow <= 4,
                focus_on_click: false,
            });
            styleChip(btn, item.id === getActiveId());
            btn.connect('clicked', () => {
                onSelect(item.id);
                sync();
            });
            buttons.push({ btn, id: item.id });
            row.append(btn);
        }
        outer.append(row);
    }

    return { widget: outer, sync };
}

function makeToggleRow(titleText, subtitleText, getVal, onToggle, { onLabel = 'On', offLabel = 'Off', width = 66 } = {}) {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        valign: Gtk.Align.CENTER,
        hexpand: true,
    });
    const info = makeTitleBox(titleText, subtitleText);
    row.append(info.box);

    const btn = pillButton('', 'isle-pill-small', () => {
        const next = !getVal();
        onToggle(next);
        sync();
    });
    btn.set_focus_on_click(false);
    btn.set_size_request(width, 26);

    const sync = () => {
        const on = Boolean(getVal());
        btn.set_label(on ? onLabel : offLabel);
        if (on) {
            btn.add_css_class('isle-pill-accent');
            btn.remove_css_class('isle-pill-small');
        } else {
            btn.remove_css_class('isle-pill-accent');
            btn.add_css_class('isle-pill-small');
        }
    };
    sync();
    row.append(btn);
    return { row, btn, info, sync };
}

function makeSwatchRow(items, getVal, onSelect) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 5,
        valign: Gtk.Align.CENTER,
    });
    const entries = [];

    const sync = () => {
        const cur = (getVal() || '').toLowerCase();
        entries.forEach(({ btn, match }) => {
            if (match.toLowerCase() === cur) btn.add_css_class('active');
            else btn.remove_css_class('active');
        });
    };

    for (const item of items) {
        const dot = new Gtk.Box({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER });
        dot.set_size_request(14, 14);
        const prov = new Gtk.CssProvider();
        prov.load_from_data(`box { background-color: ${item.hex}; border-radius: 7px; }`, -1);
        dot.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const match = item.value ?? item.hex;
        const btn = new Gtk.Button({
            child: dot,
            tooltip_text: item.label,
            css_classes: ['isle-settings-swatch'],
        });
        btn.connect('clicked', () => {
            onSelect(match);
            sync();
        });
        entries.push({ btn, match });
        box.append(btn);
    }
    sync();
    return { widget: box, sync };
}

function wrapScroll(childBox) {
    const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        hexpand: true,
        vexpand: true,
        css_classes: ['isle-settings-scrolled'],
    });
    childBox.set_margin_start(14);
    childBox.set_margin_end(14);
    childBox.set_margin_top(2);
    childBox.set_margin_bottom(6);
    scrolled.set_child(childBox);
    return scrolled;
}

export const SettingsPage = GObject.registerClass({
    GTypeName: 'IsleGtkSettingsPage',
}, class SettingsPage extends Page {
    _init(daemon, { height = 240 } = {}) {
        super._init(daemon, {
            name: 'settings',
            height,
        });

        this._store = getSettingsStore();
        this._auth = getAuthStore();
        this._activeCat = 'tabs';
        this._catBtns = new Map();
        this._syncers = [];
        this._destroyHooks = [];

        const root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            vexpand: true,
        });

        // 1. Header Row
        const headerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_start: 14,
            margin_end: 14,
            margin_top: 2,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        const titleBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 7,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        titleBox.append(new Gtk.Image({ gicon: icon('isle-settings'), pixel_size: 15 }));
        titleBox.append(label('Isle Settings', 'isle-title'));
        headerRow.append(titleBox);

        const closeBtn = pillButton('Done', 'isle-pill-small', () => this.emit('request-close'));
        closeBtn.set_size_request(54, 24);
        headerRow.append(closeBtn);
        root.append(headerRow);

        // 2. Category Navigation Pill Bar
        const navWrap = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            margin_start: 14,
            margin_end: 14,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-settings-nav'],
        });
        for (const cat of CATEGORIES) {
            const btn = new Gtk.Button({
                label: cat.label,
                css_classes: ['isle-settings-nav-btn', ...(cat.id === this._activeCat ? ['active'] : [])],
            });
            btn.connect('clicked', () => this._switchCategory(cat.id));
            this._catBtns.set(cat.id, btn);
            navWrap.append(btn);
        }
        root.append(navWrap);

        // 3. Category Stack
        this._catStack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 140,
            hexpand: true,
            vexpand: true,
        });

        let tabsScroll = null;
        tabsScroll = wrapScroll(this._buildTabsCategory(() => tabsScroll));
        this._catStack.add_named(tabsScroll, 'tabs');
        this._catStack.add_named(wrapScroll(this._buildLookCategory()), 'look');
        this._catStack.add_named(wrapScroll(this._buildBehaviorCategory()), 'behavior');
        this._catStack.add_named(wrapScroll(this._buildHardwareCategory()), 'hardware');
        this._catStack.add_named(wrapScroll(this._buildAiAuthCategory()), 'ai');
        this._catStack.add_named(wrapScroll(this._buildSystemCategory()), 'system');
        this._catStack.set_visible_child_name(this._activeCat);

        root.append(this._catStack);
        this.append(root);

        const storeUnsub = this._store.subscribe('*', (_st, topics) => this._syncMatching(topics));
        this.connect('map', () => this._syncAll());
        this.connect('destroy', () => {
            storeUnsub();
            for (const fn of this._destroyHooks) {
                try { fn(); } catch (_) {}
            }
            this._destroyHooks = [];
        });
    }

    _registerSync(topics, ...fns) {
        const set = topics === '*'
            ? '*'
            : new Set(Array.isArray(topics) ? topics : [topics]);
        for (const fn of fns) {
            this._syncers.push({ set, fn });
        }
    }

    _switchCategory(catId) {
        this._activeCat = catId;
        for (const [id, btn] of this._catBtns.entries()) {
            if (id === catId) btn.add_css_class('active');
            else btn.remove_css_class('active');
        }
        this._catStack.set_visible_child_name(catId);
        const catTopics = {
            tabs: ['tabs', 'header'],
            look: ['appearance', 'compact', 'bot', 'powerProfile', 'clock'],
            behavior: ['behavior', 'dnd', 'sound', 'calendar'],
            hardware: ['chargeLimit', 'powerProfile', 'wiz'],
            ai: ['assistant', 'usage'],
            system: [],
        }[catId] || ['*'];
        this._syncMatching(catTopics);
    }

    _syncMatching(changedTopics) {
        const list = changedTopics === '*'
            ? ['*']
            : (Array.isArray(changedTopics) ? changedTopics : [changedTopics]);
        for (const entry of this._syncers) {
            const match = entry.set === '*'
                || list.includes('*')
                || list.some(t => entry.set.has(t));
            if (!match) continue;
            try { entry.fn(); } catch (_) {}
        }
    }

    _syncAll() {
        this._syncMatching(['*']);
    }

    // ── Category 1: Tabs ───────────────────────────────────────────────

    _buildTabsCategory(getScroll) {
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });

        // Card 1: Visible Tabs & Order
        const cardTabs = makeCard();
        const tabsHdr = makeTitleBox('Visible Tabs & Order', 'Drag ⠿ to reorder · hidden tabs move below');
        cardTabs.append(tabsHdr.box);

        const visibleHead = label('VISIBLE', 'isle-settings-subhead', { halign: Gtk.Align.START });
        cardTabs.append(visibleHead);

        const visibleListBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true });
        cardTabs.append(visibleListBox);

        const hiddenSection = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true });
        const hiddenHead = label('HIDDEN', 'isle-settings-subhead', { halign: Gtk.Align.START });
        hiddenSection.append(hiddenHead);
        const hiddenListBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true });
        hiddenSection.append(hiddenListBox);
        cardTabs.append(hiddenSection);

        let visibleRows = [];
        let dragState = null;

        const drag = new Gtk.GestureDrag({ button: 1 });
        drag.connect('drag-begin', (_g, startX, startY) => {
            dragState = null;
            if (visibleRows.length <= 1) return;
            const picked = visibleListBox.pick(startX, startY, Gtk.PickFlags.DEFAULT);
            if (picked instanceof Gtk.Button || picked?.get_ancestor?.(Gtk.Button)) return;
            const idx = visibleRows.findIndex(r => {
                const a = r.get_allocation();
                return startY >= a.y && startY <= a.y + a.height;
            });
            if (idx < 0) return;
            dragState = {
                row: visibleRows[idx],
                startY,
                startIdx: idx,
                currentIdx: idx,
                active: false,
                moved: false,
            };
        });
        drag.connect('drag-update', (_g, _dx, dy) => {
            if (!dragState) return;
            if (!dragState.active) {
                if (Math.abs(dy) < 5) return;
                dragState.active = true;
                dragState.row.add_css_class('dragging');
                visibleListBox.set_cursor_from_name('grabbing');
            }
            const curY = dragState.startY + dy;
            let targetIdx = dragState.currentIdx;
            for (let i = 0; i < visibleRows.length; i++) {
                const a = visibleRows[i].get_allocation();
                const mid = a.y + a.height / 2;
                if (i < dragState.currentIdx && curY < mid) {
                    targetIdx = i;
                    break;
                }
                if (i > dragState.currentIdx && curY > mid) {
                    targetIdx = i;
                }
            }
            targetIdx = Math.max(0, Math.min(visibleRows.length - 1, targetIdx));
            if (targetIdx !== dragState.currentIdx) {
                const [movedRow] = visibleRows.splice(dragState.currentIdx, 1);
                visibleRows.splice(targetIdx, 0, movedRow);
                const prev = targetIdx > 0 ? visibleRows[targetIdx - 1] : null;
                visibleListBox.reorder_child_after(movedRow, prev);
                dragState.currentIdx = targetIdx;
                dragState.moved = true;
            }
        });
        const finishDrag = () => {
            if (!dragState) return;
            const wasMoved = dragState.moved;
            dragState.row.remove_css_class('dragging');
            visibleListBox.set_cursor(null);
            const newOrder = visibleRows.map(r => r._tabId);
            dragState = null;
            if (wasMoved) {
                this._store.setVisibleTabOrder(newOrder);
            }
        };
        drag.connect('drag-end', finishDrag);
        drag.connect('cancel', finishDrag);
        visibleListBox.add_controller(drag);

        // Card 2: Default Landing Tab
        const cardLanding = makeCard();
        cardLanding.append(makeTitleBox('Default Landing Tab', 'Tab shown when the notch opens').box);
        const landingContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
        cardLanding.append(landingContainer);

        const rebuildTabLists = () => {
            if (dragState) return;
            const scroll = getScroll?.();
            const vadj = scroll?.get_vadjustment?.();
            const savedY = vadj ? vadj.get_value() : 0;

            const visibleIds = this._store.visibleTabs();
            const hiddenIds = this._store.hiddenTabs();
            const visibleCount = visibleIds.length;

            visibleHead.set_text(`VISIBLE (${visibleCount})`);
            clearChildren(visibleListBox);
            visibleRows = [];

            visibleIds.forEach((tabId, idx) => {
                const meta = TAB_META.get(tabId);
                if (!meta) return;

                const row = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    css_classes: ['isle-settings-tab-row'],
                });
                row._tabId = tabId;
                row.set_cursor_from_name('grab');

                const grip = label('⠿', 'isle-settings-drag-grip');
                row.append(grip);
                row.append(new Gtk.Image({ gicon: icon(meta.icon), pixel_size: 14 }));
                row.append(label(meta.label, 'isle-title', { hexpand: true, halign: Gtk.Align.START }));

                const upBtn = new Gtk.Button({
                    label: '▲',
                    css_classes: ['isle-settings-mini-btn'],
                    sensitive: idx > 0,
                    focus_on_click: false,
                });
                upBtn.set_cursor_from_name('pointer');
                upBtn.connect('clicked', () => this._store.moveTab(tabId, -1));
                row.append(upBtn);

                const downBtn = new Gtk.Button({
                    label: '▼',
                    css_classes: ['isle-settings-mini-btn'],
                    sensitive: idx < visibleCount - 1,
                    focus_on_click: false,
                });
                downBtn.set_cursor_from_name('pointer');
                downBtn.connect('clicked', () => this._store.moveTab(tabId, 1));
                row.append(downBtn);

                const hideBtn = new Gtk.Button({ label: 'Hide', focus_on_click: false });
                styleChip(hideBtn, true);
                hideBtn.set_size_request(54, 22);
                hideBtn.set_cursor_from_name('pointer');
                hideBtn.connect('clicked', () => {
                    if (visibleCount <= 1) {
                        tabsHdr.subtitle.set_text('Keep at least one tab visible');
                        return;
                    }
                    tabsHdr.subtitle.set_text('Drag ⠿ to reorder · hidden tabs move below');
                    this._store.setTabVisible(tabId, false);
                });
                row.append(hideBtn);

                visibleRows.push(row);
                visibleListBox.append(row);
            });

            clearChildren(hiddenListBox);
            hiddenSection.set_visible(hiddenIds.length > 0);
            if (hiddenIds.length > 0) {
                hiddenHead.set_text(`HIDDEN (${hiddenIds.length})`);
                for (const tabId of hiddenIds) {
                    const meta = TAB_META.get(tabId);
                    if (!meta) continue;

                    const row = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 6,
                        valign: Gtk.Align.CENTER,
                        hexpand: true,
                        css_classes: ['isle-settings-tab-row', 'hidden-row'],
                    });
                    const ic = new Gtk.Image({ gicon: icon(meta.icon), pixel_size: 14 });
                    ic.set_opacity(0.6);
                    row.append(ic);
                    const lbl = label(meta.label, 'isle-title', { hexpand: true, halign: Gtk.Align.START });
                    lbl.set_opacity(0.6);
                    row.append(lbl);

                    const showBtn = new Gtk.Button({ label: '+ Show', focus_on_click: false });
                    styleChip(showBtn, false);
                    showBtn.set_size_request(60, 22);
                    showBtn.set_cursor_from_name('pointer');
                    showBtn.connect('clicked', () => this._store.setTabVisible(tabId, true));
                    row.append(showBtn);
                    hiddenListBox.append(row);
                }
            }

            clearChildren(landingContainer);
            const landingItems = [
                { id: 'last', label: 'Last Open' },
                ...visibleIds.map(id => ({ id, label: TAB_META.get(id)?.label || id })),
            ];
            const chips = makeChipRows(
                landingItems,
                () => this._store.get().tabs.defaultTab,
                id => this._store.update(st => { st.tabs.defaultTab = id; }, 'tabs'),
                { perRow: 5 }
            );
            landingContainer.append(chips.widget);

            if (scroll && vadj && savedY > 0) {
                scroll.add_tick_callback(() => {
                    const maxY = Math.max(0, vadj.get_upper() - vadj.get_page_size());
                    vadj.set_value(Math.min(savedY, maxY));
                    return GLib.SOURCE_REMOVE;
                });
            }
        };
        rebuildTabLists();
        this._registerSync('tabs', rebuildTabLists);
        col.append(cardTabs);
        col.append(cardLanding);

        // Card 3: Header Controls
        const cardHeader = makeCard();
        cardHeader.append(makeTitleBox('Header Controls', 'Customize icons on the top right of expanded view').box);
        const asstToggle = makeToggleRow(
            'AI Sparkle Button',
            'Show quick assistant sparkle button in header',
            () => this._store.get().header.showAssistantBtn,
            v => this._store.update(s => { s.header.showAssistantBtn = v; }, 'header')
        );
        const barsToggle = makeToggleRow(
            'Audio Equalizer Bars',
            'Show animated equalizer bars beside header clock',
            () => this._store.get().header.showHeaderBars,
            v => this._store.update(s => { s.header.showHeaderBars = v; }, 'header')
        );
        cardHeader.append(asstToggle.row);
        cardHeader.append(barsToggle.row);
        this._registerSync('header', asstToggle.sync, barsToggle.sync);
        col.append(cardHeader);

        return col;
    }

    // ── Category 2: Look ───────────────────────────────────────────────

    _buildLookCategory() {
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });

        // Card 1: Glass Opacity
        const cardGlass = makeCard();
        const glassTop = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        glassTop.append(makeTitleBox('Glass Opacity', 'Frosted background transparency (5%–85%)').box);

        const glassScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 85,
                step_increment: 1,
                page_increment: 5,
                value: this._store.get().glassOpacity,
            }),
            digits: 0,
            hexpand: true,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            css_classes: ['isle-settings-scale'],
        });
        let syncingGlass = false;
        const glassBtns = [];
        const presetsBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, valign: Gtk.Align.CENTER });
        const syncGlassUi = () => {
            const cur = this._store.get().glassOpacity;
            syncingGlass = true;
            if (Math.round(glassScale.get_value()) !== cur) glassScale.set_value(cur);
            syncingGlass = false;
            glassBtns.forEach(({ btn, p }) => {
                if (cur === p) {
                    btn.add_css_class('isle-pill-accent');
                    btn.remove_css_class('isle-pill-small');
                } else {
                    btn.remove_css_class('isle-pill-accent');
                    btn.add_css_class('isle-pill-small');
                }
            });
        };
        for (const p of [10, 15, 25, 50]) {
            const btn = pillButton(`${p}%`, 'isle-pill-small', () => {
                this._store.update(s => { s.glassOpacity = p; }, 'appearance');
            });
            btn.set_size_request(42, 24);
            glassBtns.push({ btn, p });
            presetsBox.append(btn);
        }
        glassTop.append(presetsBox);
        cardGlass.append(glassTop);
        glassScale.connect('value-changed', () => {
            if (syncingGlass) return;
            const val = Math.round(glassScale.get_value());
            this._store.update(s => { s.glassOpacity = val; }, 'appearance', { save: false, deferMs: 150 });
        });
        cardGlass.append(glassScale);
        syncGlassUi();
        this._registerSync('appearance', syncGlassUi);
        col.append(cardGlass);

        // Card 2: Accent & Battery Colors
        const cardColors = makeCard();
        cardColors.append(makeTitleBox('Accent & Battery Colors', 'Theme highlight and compact battery digit tints').box);

        const mkColorRow = (title, items, getter, setter) => {
            const r = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
            r.append(label(title, 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
            const sw = makeSwatchRow(items, getter, setter);
            r.append(sw.widget);
            cardColors.append(r);
            this._registerSync('appearance', sw.sync);
        };
        mkColorRow('Accent Color', ACCENT_PRESETS,
            () => this._store.get().appearance.accentColor,
            hex => this._store.update(s => { s.appearance.accentColor = hex; }, 'appearance'));
        mkColorRow('Charging Digits', INDICATOR_COLORS,
            () => this._store.get().appearance.batteryChargingColor,
            hex => this._store.update(s => { s.appearance.batteryChargingColor = hex; }, 'appearance'));
        mkColorRow('AC Capped Digits', INDICATOR_COLORS,
            () => this._store.get().appearance.batteryCappedColor,
            hex => this._store.update(s => { s.appearance.batteryCappedColor = hex; }, 'appearance'));
        col.append(cardColors);

        // Card 3: Compact Notch Elements
        const cardCompact = makeCard();
        cardCompact.append(makeTitleBox('Compact Notch Elements', 'Choose what appears in the collapsed pill').box);
        const compactGrid = new Gtk.Grid({ row_spacing: 5, column_spacing: 6, hexpand: true });
        const compactDefs = [
            ['showBattery', 'Battery %'],
            ['showBot', 'Bot Avatar'],
            ['showDate', 'Weekday'],
            ['showWifi', 'Wi-Fi Bars'],
            ['showVolume', 'Volume %'],
            ['showPrivacyDots', 'Privacy Dots'],
        ];
        compactDefs.forEach(([key, lbl], i) => {
            const btn = new Gtk.Button({ label: lbl, hexpand: true });
            const syncBtn = () => styleChip(btn, Boolean(this._store.get().compact[key]));
            btn.connect('clicked', () => {
                this._store.update(s => { s.compact[key] = !s.compact[key]; }, 'compact');
            });
            syncBtn();
            this._registerSync('compact', syncBtn);
            compactGrid.attach(btn, i % 3, Math.floor(i / 3), 1, 1);
        });
        cardCompact.append(compactGrid);
        col.append(cardCompact);

        // Card 4: Bot Avatar
        const cardBot = makeCard();
        const botHdrRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        botHdrRow.append(makeTitleBox('Bot Avatar', 'Morphing shape and color palette').box);
        const previewIcon = new BotIcon(30, { shape: this._store.get().bot.shape, palette: paletteFor('sky', 'match') });
        botHdrRow.append(previewIcon);
        cardBot.append(botHdrRow);

        const shapeItems = Object.entries(SHAPES).map(([id, s]) => ({ id, label: s.label }));
        const shapeChips = makeChipRows(
            shapeItems,
            () => this._store.get().bot.shape,
            id => this._store.update(s => { s.bot.shape = id; }, 'bot'),
            { perRow: 4 }
        );
        cardBot.append(shapeChips.widget);

        const modeRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER, hexpand: true });
        modeRow.append(label('Color Mode', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const botColorMode = makeChipRows(
            [{ id: 'power', label: 'Power Profile' }, { id: 'fixed', label: 'Custom' }],
            () => this._store.get().bot.colorMode,
            id => this._store.update(s => { s.bot.colorMode = id; }, 'bot'),
            { perRow: 2 }
        );
        modeRow.append(botColorMode.widget);
        cardBot.append(modeRow);

        const customPaletteRevealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            transition_duration: 150,
            reveal_child: this._store.get().bot.colorMode === 'fixed',
        });
        const botColorItems = Object.entries(COLORS).map(([id, c]) => ({ id, label: c.label, hex: c.body, value: id }));
        const botSwatches = makeSwatchRow(
            botColorItems,
            () => this._store.get().bot.color,
            colorId => this._store.update(s => { s.bot.color = colorId; }, 'bot')
        );
        customPaletteRevealer.set_child(botSwatches.widget);
        cardBot.append(customPaletteRevealer);

        const syncBotCard = () => {
            const b = this._store.get().bot;
            shapeChips.sync();
            botColorMode.sync();
            botSwatches.sync();
            customPaletteRevealer.set_reveal_child(b.colorMode === 'fixed');
            const colorArg = b.colorMode === 'fixed' ? b.color : (getPowerProfile() === 'lightning' ? '#bf5af2' : '#30d158');
            previewIcon.look = { shape: b.shape, palette: paletteFor(colorArg, b.glow) };
        };
        syncBotCard();
        this._registerSync(['bot', 'powerProfile'], syncBotCard);
        col.append(cardBot);

        // Card 5: Effects & Clock
        const cardFx = makeCard();
        const lightningToggle = makeToggleRow(
            'Lightning AC Overlay',
            'Animated rising lightning bolts in Lightning + AC mode',
            () => this._store.get().appearance.lightningOverlayEnabled,
            v => this._store.update(s => { s.appearance.lightningOverlayEnabled = v; }, 'appearance')
        );
        cardFx.append(lightningToggle.row);

        const clockRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        clockRow.append(label('Clock Format', 'isle-title', { hexpand: true, halign: Gtk.Align.START }));
        const clockChips = makeChipRows(
            [{ id: '12h', label: '12-Hour' }, { id: '24h', label: '24-Hour' }],
            () => this._store.get().clockFormat,
            fmt => {
                this._store.update(s => { s.clockFormat = fmt; }, 'clock');
                globalThis.isleExpanded?._tickClock?.();
                globalThis.isleCompact?._tickClock?.();
            },
            { perRow: 2 }
        );
        clockRow.append(clockChips.widget);
        cardFx.append(clockRow);
        this._registerSync('appearance', lightningToggle.sync);
        this._registerSync('clock', clockChips.sync);
        col.append(cardFx);

        return col;
    }

    // ── Category 3: Behavior ───────────────────────────────────────────

    _buildBehaviorCategory() {
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });

        // Card 1: Notch Open Mode
        const cardOpen = makeCard();
        const openRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        openRow.append(makeTitleBox('Notch Open Mode', 'Unfold on pointer hover or require click').box);
        const openChips = makeChipRows(
            [{ id: 'hover', label: 'Hover' }, { id: 'click', label: 'Click Only' }],
            () => this._store.get().behavior.openMode,
            m => this._store.update(s => { s.behavior.openMode = m; }, 'behavior'),
            { perRow: 2 }
        );
        openRow.append(openChips.widget);
        cardOpen.append(openRow);
        this._registerSync('behavior', openChips.sync);
        col.append(cardOpen);

        // Card 2: Tab Switching & Hold Time
        const cardTabSwitch = makeCard();
        const switchTop = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        switchTop.append(makeTitleBox('Tab Switching', 'Switch header tabs on hover dwell or click').box);
        const switchChips = makeChipRows(
            [{ id: 'hover', label: 'Hover' }, { id: 'click', label: 'Click' }],
            () => this._store.get().tabSwitchMode,
            m => this._store.update(s => { s.tabSwitchMode = m; }, 'behavior'),
            { perRow: 2 }
        );
        switchTop.append(switchChips.widget);
        cardTabSwitch.append(switchTop);

        const holdRevealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            transition_duration: 160,
            reveal_child: this._store.get().tabSwitchMode !== 'click',
        });
        const holdBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true });
        const holdHead = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        holdHead.append(label('Hold Time', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const holdValLbl = label(`${this._store.get().tabHoverHoldTime} ms`, 'isle-settings-value');
        holdHead.append(holdValLbl);
        holdBox.append(holdHead);

        const holdScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 100,
                upper: 2000,
                step_increment: 50,
                page_increment: 100,
                value: this._store.get().tabHoverHoldTime,
            }),
            hexpand: true,
            draw_value: false,
            css_classes: ['isle-settings-scale'],
        });
        let syncingHold = false;
        holdScale.connect('value-changed', () => {
            if (syncingHold) return;
            const val = Math.round(holdScale.get_value() / 50) * 50;
            holdValLbl.set_text(`${val} ms`);
            this._store.update(s => { s.tabHoverHoldTime = val; }, 'behavior', { save: false, deferMs: 150 });
        });
        holdBox.append(holdScale);
        holdRevealer.set_child(holdBox);
        cardTabSwitch.append(holdRevealer);

        const syncSwitchUi = () => {
            const st = this._store.get();
            switchChips.sync();
            holdRevealer.set_reveal_child(st.tabSwitchMode !== 'click');
            holdValLbl.set_text(`${st.tabHoverHoldTime} ms`);
            syncingHold = true;
            if (Math.round(holdScale.get_value()) !== st.tabHoverHoldTime) holdScale.set_value(st.tabHoverHoldTime);
            syncingHold = false;
        };
        this._registerSync('behavior', syncSwitchUi);
        col.append(cardTabSwitch);

        // Card 3: Notifications & Peeks
        const cardNotif = makeCard();
        const dndToggle = makeToggleRow(
            'Do Not Disturb',
            'Silence compact notification peek banners',
            () => this._store.get().dndEnabled,
            v => {
                if (globalThis.isleNotifications) {
                    globalThis.isleNotifications.dnd = v;
                } else {
                    this._store.update(s => { s.dndEnabled = v; }, 'dnd');
                }
            }
        );
        const peekToggle = makeToggleRow(
            'Compact Notification Peeks',
            'Show sliding Dynamic Island banners for incoming alerts',
            () => this._store.get().behavior.peekEnabled,
            v => this._store.update(s => { s.behavior.peekEnabled = v; }, 'behavior')
        );
        cardNotif.append(dndToggle.row);
        cardNotif.append(peekToggle.row);

        const peekHead = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        peekHead.append(label('Peek Duration', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const peekValLbl = label('', 'isle-settings-value');
        peekHead.append(peekValLbl);
        cardNotif.append(peekHead);

        const peekScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 2000,
                upper: 8000,
                step_increment: 200,
                page_increment: 500,
                value: this._store.get().behavior.peekDurationMs,
            }),
            hexpand: true,
            draw_value: false,
            css_classes: ['isle-settings-scale'],
        });
        let syncingPeek = false;
        peekScale.connect('value-changed', () => {
            if (syncingPeek) return;
            const ms = Math.round(peekScale.get_value() / 200) * 200;
            peekValLbl.set_text(`${(ms / 1000).toFixed(1)} s`);
            this._store.update(s => { s.behavior.peekDurationMs = ms; }, 'behavior', { save: false, deferMs: 150 });
        });
        cardNotif.append(peekScale);

        const syncNotifUi = () => {
            dndToggle.sync();
            peekToggle.sync();
            const ms = this._store.get().behavior.peekDurationMs;
            peekValLbl.set_text(`${(ms / 1000).toFixed(1)} s`);
            syncingPeek = true;
            if (Math.round(peekScale.get_value()) !== ms) peekScale.set_value(ms);
            syncingPeek = false;
        };
        syncNotifUi();
        this._registerSync(['behavior', 'dnd'], syncNotifUi);
        col.append(cardNotif);

        // Card 4: Audio, Lyrics & Calendar
        const cardMisc = makeCard();
        const soundRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER, hexpand: true });
        soundRow.append(makeTitleBox('Timer & Alarm Audio', 'Play chime when countdown or alarm finishes').box);
        const testSoundBtn = pillButton('Test', 'isle-pill-small', () => {
            try { GLib.spawn_command_line_async('canberra-gtk-play -i bell'); } catch (_) {}
        });
        testSoundBtn.set_size_request(46, 26);
        soundRow.append(testSoundBtn);

        const soundBtn = pillButton('', 'isle-pill-small', () => {
            const next = !this._store.get().soundEnabled;
            this._store.update(s => { s.soundEnabled = next; }, 'sound');
            if (next) {
                try { GLib.spawn_command_line_async('canberra-gtk-play -i bell'); } catch (_) {}
            }
        });
        soundBtn.set_size_request(74, 26);
        soundRow.append(soundBtn);
        cardMisc.append(soundRow);

        const lyricsToggle = makeToggleRow(
            'Synced Lyrics (LRCLIB)',
            'Enable daemon lyrics lookup for playing tracks',
            () => this._store.get().behavior.lyricsEnabled,
            v => this._store.update(s => { s.behavior.lyricsEnabled = v; }, 'behavior')
        );
        cardMisc.append(lyricsToggle.row);

        const calRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        calRow.append(label('Calendar Default View', 'isle-title', { hexpand: true, halign: Gtk.Align.START }));
        const calChips = makeChipRows(
            [{ id: 'month', label: 'Month' }, { id: 'week', label: 'Week' }],
            () => this._store.get().calendarViewMode,
            m => this._store.update(s => { s.calendarViewMode = m; }, 'calendar'),
            { perRow: 2 }
        );
        calRow.append(calChips.widget);
        cardMisc.append(calRow);

        const syncMiscUi = () => {
            const on = this._store.get().soundEnabled;
            soundBtn.set_label(on ? 'Sound On' : 'Muted');
            if (on) {
                soundBtn.add_css_class('isle-pill-accent');
                soundBtn.remove_css_class('isle-pill-small');
            } else {
                soundBtn.remove_css_class('isle-pill-accent');
                soundBtn.add_css_class('isle-pill-small');
            }
            lyricsToggle.sync();
            calChips.sync();
        };
        syncMiscUi();
        this._registerSync(['behavior', 'sound', 'calendar'], syncMiscUi);
        col.append(cardMisc);

        return col;
    }

    // ── Category 4: Hardware ───────────────────────────────────────────

    _buildHardwareCategory() {
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });

        // Card 1: Battery Charge Limit
        const cardCap = makeCard();
        const capTop = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER, hexpand: true });
        capTop.append(makeTitleBox('Battery Charge Limit', 'Hold battery level on AC via HP EC daemon').box);

        const daemonPill = label('Checking…', 'isle-settings-badge');
        capTop.append(daemonPill);

        const capBtn = pillButton('', 'isle-pill-small', () => {
            const cur = globalThis.isleGetChargeLimit ? globalThis.isleGetChargeLimit().enabled : this._store.get().chargeLimitEnabled;
            if (globalThis.isleSetChargeLimit) {
                globalThis.isleSetChargeLimit({ enabled: !cur }, { save: true });
            } else {
                this._store.update(s => { s.chargeLimitEnabled = !cur; }, 'chargeLimit');
            }
        });
        capBtn.set_size_request(60, 26);
        capTop.append(capBtn);
        cardCap.append(capTop);

        const presetRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5, valign: Gtk.Align.CENTER, hexpand: true });
        presetRow.append(label('Target Cap', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const capBtns = [];
        let syncingCap = false;

        const capScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower: 40,
                upper: 95,
                step_increment: 1,
                page_increment: 5,
                value: this._store.get().chargeLimitPercent,
            }),
            digits: 0,
            hexpand: true,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            css_classes: ['isle-settings-scale'],
        });
        capScale.set_format_value_func((_s, v) => `${Math.round(v)}%`);

        for (const p of [40, 60, 70, 80]) {
            const btn = pillButton(`${p}%`, 'isle-pill-small', () => {
                if (globalThis.isleSetChargeLimit) globalThis.isleSetChargeLimit({ percent: p }, { save: true });
                else this._store.update(s => { s.chargeLimitPercent = p; }, 'chargeLimit');
            });
            btn.set_size_request(44, 24);
            capBtns.push({ btn, p });
            presetRow.append(btn);
        }
        cardCap.append(presetRow);

        capScale.connect('value-changed', () => {
            if (syncingCap) return;
            const val = Math.round(capScale.get_value());
            if (globalThis.isleSetChargeLimit) {
                globalThis.isleSetChargeLimit({ percent: val }, { save: false });
                this._store.saveDeferred(150);
            } else {
                this._store.update(s => { s.chargeLimitPercent = val; }, 'chargeLimit', { save: false, deferMs: 150 });
            }
        });
        cardCap.append(capScale);

        const refreshChargeStatus = () => {
            const enabled = this._store.get().chargeLimitEnabled;
            const pct = this._store.get().chargeLimitPercent;
            capBtn.set_label(enabled ? 'On' : 'Off');
            if (enabled) {
                capBtn.add_css_class('isle-pill-accent');
                capBtn.remove_css_class('isle-pill-small');
            } else {
                capBtn.remove_css_class('isle-pill-accent');
                capBtn.add_css_class('isle-pill-small');
            }
            syncingCap = true;
            if (Math.round(capScale.get_value()) !== pct) capScale.set_value(pct);
            syncingCap = false;
            capBtns.forEach(({ btn, p }) => {
                if (pct === p) {
                    btn.add_css_class('isle-pill-accent');
                    btn.remove_css_class('isle-pill-small');
                } else {
                    btn.remove_css_class('isle-pill-accent');
                    btn.add_css_class('isle-pill-small');
                }
            });

            try {
                if (GLib.file_test('/run/isle-charge-limit.json', GLib.FileTest.EXISTS)) {
                    const [ok, raw] = GLib.file_get_contents('/run/isle-charge-limit.json');
                    if (ok) {
                        const info = JSON.parse(new TextDecoder().decode(raw));
                        const text = info.inhibited
                            ? `Holding ${info.limitPercent}%`
                            : (info.enabled ? `Cap ${info.limitPercent}%` : 'Monitor Off');
                        daemonPill.set_text(text);
                        daemonPill.set_css_classes(['isle-settings-badge', info.enabled ? 'ok' : 'missing']);
                        return;
                    }
                }
            } catch (_) {}
            daemonPill.set_text('Daemon Offline');
            daemonPill.set_css_classes(['isle-settings-badge', 'missing']);
        };
        refreshChargeStatus();
        this._registerSync('chargeLimit', refreshChargeStatus);
        col.append(cardCap);

        // Card 2: Power Profile
        const cardPower = makeCard();
        cardPower.append(makeTitleBox('Power Profile', 'Active CPU & GPU performance preset').box);
        const powerChips = makeChipRows(
            [
                { id: 'power-saver', label: 'Saver' },
                { id: 'balanced', label: 'Balanced' },
                { id: 'performance', label: 'Perf' },
                { id: 'lightning', label: 'Lightning' },
            ],
            () => getPowerProfile() || this._store.get().powerProfile || 'balanced',
            profile => {
                this._store.update(s => { s.powerProfile = profile; }, 'powerProfile');
                setPowerProfile(profile, () => powerChips.sync());
            },
            { perRow: 4 }
        );
        cardPower.append(powerChips.widget);
        const mon = getTelemetryMonitor();
        const pwrHandler = mon.connect('power-changed', () => powerChips.sync());
        this._destroyHooks.push(() => mon.disconnect(pwrHandler));
        this._registerSync('powerProfile', powerChips.sync);
        col.append(cardPower);

        // Card 3: WiZ Smart Bulb
        const cardWiz = makeCard();
        cardWiz.append(makeTitleBox('WiZ Smart Bulb', 'Manual IP override & Music/Screen defaults').box);

        const ipRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        const ipEntry = new Gtk.Entry({
            placeholder_text: 'Manual Bulb IP (optional, e.g. 192.168.1.50)',
            text: this._store.get().wiz.manualIp || '',
            hexpand: true,
            css_classes: ['isle-settings-entry'],
        });
        const applyIp = (val) => {
            this._store.update(s => { s.wiz.manualIp = val.trim(); }, 'wiz');
        };
        ipEntry.connect('activate', () => applyIp(ipEntry.get_text()));
        ipRow.append(ipEntry);

        const setIpBtn = pillButton('Set IP', 'isle-pill-accent', () => applyIp(ipEntry.get_text()));
        setIpBtn.set_size_request(56, 26);
        ipRow.append(setIpBtn);

        const autoIpBtn = pillButton('Auto', 'isle-pill-small', () => {
            ipEntry.set_text('');
            applyIp('');
        });
        autoIpBtn.set_size_request(48, 26);
        ipRow.append(autoIpBtn);
        cardWiz.append(ipRow);

        const themeChips = makeChipRows(
            [
                { id: 'rainbow', label: 'Rainbow' },
                { id: 'club', label: 'Club' },
                { id: 'fire', label: 'Fire' },
                { id: 'ocean', label: 'Ocean' },
                { id: 'sesh', label: 'Sesh' },
            ],
            () => this._store.get().wiz.musicTheme,
            t => this._store.update(s => { s.wiz.musicTheme = t; }, 'wiz'),
            { perRow: 5 }
        );
        cardWiz.append(themeChips.widget);

        const srcRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        srcRow.append(label('Audio Source', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const srcChips = makeChipRows(
            [{ id: 'system', label: 'System Audio' }, { id: 'mic', label: 'Microphone' }],
            () => this._store.get().wiz.musicSource,
            src => this._store.update(s => { s.wiz.musicSource = src; }, 'wiz'),
            { perRow: 2 }
        );
        srcRow.append(srcChips.widget);
        cardWiz.append(srcRow);

        const fpsHead = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        fpsHead.append(label('Default Sync FPS', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const fpsValLbl = label(`${this._store.get().wiz.fps} FPS`, 'isle-settings-value');
        fpsHead.append(fpsValLbl);
        cardWiz.append(fpsHead);
        const fpsScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({ lower: 5, upper: 60, step_increment: 1, page_increment: 5, value: this._store.get().wiz.fps }),
            hexpand: true,
            draw_value: false,
            css_classes: ['isle-settings-scale'],
        });
        let syncingFps = false;
        fpsScale.connect('value-changed', () => {
            if (syncingFps) return;
            const v = Math.round(fpsScale.get_value());
            fpsValLbl.set_text(`${v} FPS`);
            this._store.update(s => { s.wiz.fps = v; }, 'wiz', { save: false, deferMs: 150 });
        });
        cardWiz.append(fpsScale);

        const brHead = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        brHead.append(label('Default Brightness', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const brValLbl = label(`${this._store.get().wiz.brightness}%`, 'isle-settings-value');
        brHead.append(brValLbl);
        cardWiz.append(brHead);
        const brScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({ lower: 10, upper: 100, step_increment: 1, page_increment: 5, value: this._store.get().wiz.brightness }),
            hexpand: true,
            draw_value: false,
            css_classes: ['isle-settings-scale'],
        });
        let syncingBr = false;
        brScale.connect('value-changed', () => {
            if (syncingBr) return;
            const v = Math.round(brScale.get_value());
            brValLbl.set_text(`${v}%`);
            this._store.update(s => { s.wiz.brightness = v; }, 'wiz', { save: false, deferMs: 150 });
        });
        cardWiz.append(brScale);

        const hasEntryFocus = (e) => {
            const f = e?.get_root?.()?.get_focus?.();
            return Boolean(f && (f === e || f.is_ancestor?.(e)));
        };

        const syncWizUi = () => {
            const w = this._store.get().wiz;
            themeChips.sync();
            srcChips.sync();
            if (!hasEntryFocus(ipEntry) && ipEntry.get_text().trim() !== (w.manualIp || '')) {
                ipEntry.set_text(w.manualIp || '');
            }
            fpsValLbl.set_text(`${w.fps} FPS`);
            syncingFps = true;
            if (Math.round(fpsScale.get_value()) !== w.fps) fpsScale.set_value(w.fps);
            syncingFps = false;

            brValLbl.set_text(`${w.brightness}%`);
            syncingBr = true;
            if (Math.round(brScale.get_value()) !== w.brightness) brScale.set_value(w.brightness);
            syncingBr = false;
        };
        this._registerSync('wiz', syncWizUi);
        col.append(cardWiz);

        return col;
    }

    // ── Category 5: AI & Auth ──────────────────────────────────────────

    _buildAiAuthCategory() {
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });

        const modelKeyForProvider = (p) => ({
            nim: 'nimModel',
            auto: 'nimModel',
            claude: 'claudeModel',
            codex: 'codexModel',
            grok: 'grokModel',
            opencode: 'opencodeModel',
            agy: 'agyModel',
        }[p] || 'nimModel');

        // Card 1: Assistant Provider & CLI Auth Status
        const cardProv = makeCard();
        cardProv.append(makeTitleBox('Assistant Provider', 'Select AI backend and check local sign-in status').box);
        const provChips = makeChipRows(
            AI_PROVIDERS,
            () => this._store.get().assistant.provider,
            id => this._store.update(s => { s.assistant.provider = id; }, 'assistant'),
            { perRow: 4 }
        );
        cardProv.append(provChips.widget);

        const statusListBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true });
        cardProv.append(statusListBox);
        col.append(cardProv);

        // Card 2: Model Selection
        const cardModel = makeCard();
        const modelInfo = makeTitleBox('Model Selection', 'Pick a preset or enter a custom model ID');
        cardModel.append(modelInfo.box);
        const nimChips = makeChipRows(
            NIM_MODELS,
            () => this._store.get().assistant.nimModel,
            m => this._store.update(s => { s.assistant.nimModel = m; }, 'assistant'),
            { perRow: 2 }
        );
        cardModel.append(nimChips.widget);

        const modelRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        const modelEntry = new Gtk.Entry({
            placeholder_text: 'Custom model ID (blank = provider default)',
            hexpand: true,
            css_classes: ['isle-settings-entry'],
        });
        const applyModel = () => {
            const p = this._store.get().assistant.provider;
            const mk = modelKeyForProvider(p);
            const val = modelEntry.get_text().trim();
            this._store.update(s => { s.assistant[mk] = val; }, 'assistant');
        };
        modelEntry.connect('activate', applyModel);
        modelRow.append(modelEntry);
        const modelBtn = pillButton('Apply', 'isle-pill-accent', applyModel);
        modelBtn.set_size_request(56, 26);
        modelRow.append(modelBtn);
        cardModel.append(modelRow);
        col.append(cardModel);

        // Card 3: Voice, Speech & Memory
        const cardVoice = makeCard();
        cardVoice.append(makeTitleBox('Voice, Speech & Memory', 'Speech recognition, TTS voice & chat retention').box);
        const ttsToggle = makeToggleRow(
            'TTS Voice Output',
            'Speak assistant replies via Piper TTS',
            () => this._store.get().assistant.ttsEnabled,
            v => {
                this._store.update(s => { s.assistant.ttsEnabled = v; }, 'assistant');
                this._store.syncTtsMuteFlag();
            }
        );
        cardVoice.append(ttsToggle.row);

        const langRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        langRow.append(label('Language', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const langChips = makeChipRows(
            LANGUAGE_OPTIONS,
            () => this._store.get().assistant.language,
            l => this._store.update(s => { s.assistant.language = l; }, 'assistant'),
            { perRow: 3 }
        );
        langRow.append(langChips.widget);
        cardVoice.append(langRow);

        const whRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        whRow.append(label('Whisper', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const whChips = makeChipRows(
            WHISPER_MODELS.map(w => ({ id: w, label: w })),
            () => this._store.get().assistant.whisperModel,
            w => this._store.update(s => { s.assistant.whisperModel = w; }, 'assistant'),
            { perRow: 4 }
        );
        whRow.append(whChips.widget);
        cardVoice.append(whRow);

        const memRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER, hexpand: true });
        memRow.append(label('Chat Memory', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const memChips = makeChipRows(
            KEEP_CHAT_OPTIONS,
            () => this._store.get().assistant.keepChat,
            k => this._store.update(s => { s.assistant.keepChat = k; }, 'assistant'),
            { perRow: 3 }
        );
        memRow.append(memChips.widget);
        cardVoice.append(memRow);
        col.append(cardVoice);

        // Card 4: AI Plan Usage Tracking
        const cardUsage = makeCard();
        const usageToggle = makeToggleRow(
            'Track AI Plan Usage',
            'Monitor Claude, Codex, and Grok usage limits',
            () => this._store.get().usage.enabled,
            v => this._store.update(s => { s.usage.enabled = v; }, 'usage')
        );
        cardUsage.append(usageToggle.row);

        const usageProvRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5, hexpand: true });
        const usageProvBtns = [];
        for (const [k, lbl] of [['claude', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok']]) {
            const btn = new Gtk.Button({ label: lbl, hexpand: true });
            btn.connect('clicked', () => {
                this._store.update(s => { s.usage[k] = !s.usage[k]; }, 'usage');
            });
            usageProvBtns.push({ btn, k });
            usageProvRow.append(btn);
        }
        cardUsage.append(usageProvRow);

        const warnHead = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        warnHead.append(label('Warn Threshold', 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
        const warnValLbl = label(`${this._store.get().usage.warn}%`, 'isle-settings-value');
        warnHead.append(warnValLbl);
        cardUsage.append(warnHead);
        const warnScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({ lower: 50, upper: 95, step_increment: 5, page_increment: 5, value: this._store.get().usage.warn }),
            hexpand: true,
            draw_value: false,
            css_classes: ['isle-settings-scale'],
        });
        let syncingWarn = false;
        warnScale.connect('value-changed', () => {
            if (syncingWarn) return;
            const v = Math.round(warnScale.get_value());
            warnValLbl.set_text(`${v}%`);
            this._store.update(s => {
                s.usage.warn = v;
                if (s.usage.critical <= v) s.usage.critical = Math.min(99, v + 10);
            }, 'usage', { save: false, deferMs: 150 });
        });
        cardUsage.append(warnScale);
        col.append(cardUsage);

        // Card 5: NVIDIA NIM API Key (0600)
        const cardNim = makeCard();
        const nimTop = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER, hexpand: true });
        nimTop.append(makeTitleBox('NVIDIA NIM Key (0600)', 'Stored strictly in ~/.config/isle/nim_api_key').box);
        const nimBadge = label('', 'isle-settings-badge');
        nimTop.append(nimBadge);
        cardNim.append(nimTop);

        const nimEntryRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, hexpand: true });
        const nimEntry = new Gtk.PasswordEntry({
            placeholder_text: 'nvapi-...',
            show_peek_icon: true,
            hexpand: true,
            css_classes: ['isle-settings-entry'],
        });
        const saveNim = () => {
            const raw = nimEntry.get_text().trim();
            if (!raw) return;
            this._auth.setNimKey(raw);
            nimEntry.set_text('');
            syncAiAuth();
        };
        nimEntry.connect('activate', saveNim);
        nimEntryRow.append(nimEntry);

        const nimSaveBtn = pillButton('Save Key', 'isle-pill-accent', saveNim);
        nimSaveBtn.set_size_request(68, 26);
        nimEntryRow.append(nimSaveBtn);

        const nimClearBtn = pillButton('Clear', 'isle-pill-small', () => {
            this._auth.clearNimKey();
            nimEntry.set_text('');
            syncAiAuth();
        });
        nimClearBtn.set_size_request(50, 26);
        nimEntryRow.append(nimClearBtn);
        cardNim.append(nimEntryRow);
        col.append(cardNim);

        // Card 6: Auth Vault (~/.config/isle/auth.json, 0600)
        const cardVault = makeCard();
        cardVault.append(makeTitleBox('Auth Vault (~/.config/isle/auth.json, 0600)', 'Private token store outside settings.json').box);
        const vaultListBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true });
        cardVault.append(vaultListBox);

        const vaultAddRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5, hexpand: true });
        const vaultIdEntry = new Gtk.Entry({
            placeholder_text: 'name (e.g. openai)',
            css_classes: ['isle-settings-entry'],
        });
        vaultIdEntry.set_size_request(120, 26);
        const vaultSecretEntry = new Gtk.PasswordEntry({
            placeholder_text: 'secret / token',
            show_peek_icon: true,
            hexpand: true,
            css_classes: ['isle-settings-entry'],
        });
        const saveVault = () => {
            const ok = this._auth.setVaultEntry(vaultIdEntry.get_text(), vaultSecretEntry.get_text());
            if (ok) {
                vaultIdEntry.set_text('');
                vaultSecretEntry.set_text('');
                syncAiAuth();
            }
        };
        vaultSecretEntry.connect('activate', saveVault);
        const vaultSaveBtn = pillButton('Save', 'isle-pill-accent', saveVault);
        vaultSaveBtn.set_size_request(50, 26);
        vaultAddRow.append(vaultIdEntry);
        vaultAddRow.append(vaultSecretEntry);
        vaultAddRow.append(vaultSaveBtn);
        cardVault.append(vaultAddRow);
        col.append(cardVault);

        const syncAiAuth = () => {
            const st = this._store.get();
            provChips.sync();
            nimChips.sync();
            ttsToggle.sync();
            langChips.sync();
            whChips.sync();
            memChips.sync();
            usageToggle.sync();

            const curProv = st.assistant.provider;
            const mk = modelKeyForProvider(curProv);
            modelInfo.subtitle.set_text(`Active key: ${curProv} (${mk})`);
            const fWidget = modelEntry.get_root?.()?.get_focus?.();
            const modelFocused = Boolean(fWidget && (fWidget === modelEntry || fWidget.is_ancestor?.(modelEntry)));
            if (!modelFocused) {
                modelEntry.set_text(st.assistant[mk] || '');
            }

            usageProvBtns.forEach(({ btn, k }) => styleChip(btn, Boolean(st.usage[k])));
            warnValLbl.set_text(`${st.usage.warn}%`);
            syncingWarn = true;
            if (Math.round(warnScale.get_value()) !== st.usage.warn) warnScale.set_value(st.usage.warn);
            syncingWarn = false;

            const nimSt = this._auth.getNimKeyStatus();
            if (nimSt.configured) {
                nimBadge.set_text(`${nimSt.source === 'env' ? 'Env' : 'Saved'} · ${nimSt.hint}`);
                nimBadge.set_css_classes(['isle-settings-badge', 'ok']);
            } else {
                nimBadge.set_text('Not Set');
                nimBadge.set_css_classes(['isle-settings-badge', 'missing']);
            }

            clearChildren(statusListBox);
            for (const p of this._auth.getProviderStatuses()) {
                const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER, hexpand: true });
                row.append(label(p.name, 'isle-subtitle', { hexpand: true, halign: Gtk.Align.START }));
                const badgeText = p.configured ? (p.id === 'nim' ? 'Key Set' : 'Signed In') : (p.cliFound ? 'Not Signed In' : 'CLI Missing');
                const badge = label(badgeText, 'isle-settings-badge');
                badge.add_css_class(p.configured ? 'ok' : 'missing');
                row.append(badge);
                if (!p.configured && p.signInCmd) {
                    const siBtn = new Gtk.Button({ label: 'Sign In', css_classes: ['isle-settings-mini-btn'] });
                    siBtn.connect('clicked', () => this._auth.launchSignIn(p.id));
                    row.append(siBtn);
                }
                statusListBox.append(row);
            }

            clearChildren(vaultListBox);
            const entries = this._auth.listVaultEntries();
            if (entries.length === 0) {
                vaultListBox.append(label('No extra tokens stored', 'isle-subtitle'));
            } else {
                for (const item of entries) {
                    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER, hexpand: true });
                    row.append(label(item.id, 'isle-title', { halign: Gtk.Align.START }));
                    row.append(label(item.hint, 'isle-subtitle', { hexpand: true, halign: Gtk.Align.END }));
                    const delBtn = new Gtk.Button({ label: 'Remove', css_classes: ['isle-settings-mini-btn'] });
                    delBtn.connect('clicked', () => {
                        this._auth.deleteVaultEntry(item.id);
                        syncAiAuth();
                    });
                    row.append(delBtn);
                    vaultListBox.append(row);
                }
            }
        };
        syncAiAuth();
        this._registerSync(['assistant', 'usage'], syncAiAuth);

        return col;
    }

    // ── Category 6: System ─────────────────────────────────────────────

    _buildSystemCategory() {
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });

        // Card 1: Configuration Storage
        const cardStore = makeCard();
        const storeInfo = makeTitleBox(
            'Configuration Storage',
            `${this._store.settingsPath}`
        );
        cardStore.append(storeInfo.box);
        const authPathLbl = label(`Auth vault: ${this._auth.vaultPath} (0600)`, 'isle-subtitle');
        authPathLbl.set_halign(Gtk.Align.START);
        authPathLbl.set_ellipsize(Pango.EllipsizeMode.END);
        cardStore.append(authPathLbl);

        const feedbackLbl = label('Settings auto-save continuously across restarts', 'isle-subtitle');
        feedbackLbl.set_halign(Gtk.Align.START);
        cardStore.append(feedbackLbl);

        const actionsRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5, hexpand: true });

        const reloadBtn = new Gtk.Button({ label: 'Reload Disk', hexpand: true, css_classes: ['isle-output-chip', 'idle'] });
        reloadBtn.connect('clicked', () => {
            this._store.reload();
            feedbackLbl.set_text('Reloaded settings from disk');
        });
        actionsRow.append(reloadBtn);

        const exportBtn = new Gtk.Button({ label: 'Export Backup', hexpand: true, css_classes: ['isle-output-chip', 'idle'] });
        exportBtn.connect('clicked', () => {
            const dest = GLib.build_filenamev([GLib.get_home_dir(), 'isle-settings-backup.json']);
            const ok = this._store.exportBackup(dest);
            feedbackLbl.set_text(ok ? `Exported backup (no secrets) to ${dest}` : 'Export failed');
        });
        actionsRow.append(exportBtn);

        const openDirBtn = new Gtk.Button({ label: 'Open Folder', hexpand: true, css_classes: ['isle-output-chip', 'idle'] });
        openDirBtn.connect('clicked', () => {
            try { Gio.Subprocess.new(['xdg-open', this._store.configDir], Gio.SubprocessFlags.NONE); } catch (_) {}
        });
        actionsRow.append(openDirBtn);

        let resetArmed = false;
        let resetTimerId = 0;
        const resetBtn = new Gtk.Button({ label: 'Reset Defaults', hexpand: true, css_classes: ['isle-output-chip', 'idle'] });
        resetBtn.connect('clicked', () => {
            if (!resetArmed) {
                resetArmed = true;
                resetBtn.set_label('Confirm?');
                resetBtn.set_css_classes(['isle-output-chip', 'active']);
                if (resetTimerId) GLib.source_remove(resetTimerId);
                resetTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    resetTimerId = 0;
                    resetArmed = false;
                    resetBtn.set_label('Reset Defaults');
                    resetBtn.set_css_classes(['isle-output-chip', 'idle']);
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            if (resetTimerId) {
                GLib.source_remove(resetTimerId);
                resetTimerId = 0;
            }
            resetArmed = false;
            resetBtn.set_label('Reset Defaults');
            resetBtn.set_css_classes(['isle-output-chip', 'idle']);
            this._store.resetToDefaults();
            this._store.syncTtsMuteFlag();
            feedbackLbl.set_text('Reset preferences to defaults (auth keys preserved)');
        });
        this._destroyHooks.push(() => {
            if (resetTimerId) {
                GLib.source_remove(resetTimerId);
                resetTimerId = 0;
            }
        });
        actionsRow.append(resetBtn);
        cardStore.append(actionsRow);
        col.append(cardStore);

        // Card 2: XFCE Preferences
        const cardXfce = makeCard(Gtk.Orientation.HORIZONTAL);
        cardXfce.append(makeTitleBox('XFCE System Preferences', 'Launch XFCE settings manager for hardware & displays').box);
        const launchBtn = pillButton('Open Settings', 'isle-pill-small', () => {
            try {
                GLib.spawn_command_line_async('xfce4-settings-manager');
            } catch (err) {
                console.warn('[Isle Settings] Failed to launch xfce4-settings-manager:', err.message);
            }
        });
        launchBtn.set_size_request(106, 26);
        cardXfce.append(launchBtn);
        col.append(cardXfce);

        return col;
    }
});
