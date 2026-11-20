// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Centralized persistent configuration store for Isle XFCE (~/.config/isle/settings.json).
//! Normalizes, validates, persists, and broadcasts all UI, tab, appearance, hardware,
//! WiZ, AI assistant, and usage preferences while maintaining zero secrets on disk here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Format from './format.js';

export const TAB_CATALOG = [
    { id: 'music', label: 'Music', icon: 'isle-music' },
    { id: 'notifications', label: 'Alerts', icon: 'isle-bell' },
    { id: 'focus', label: 'Timer', icon: 'isle-timer' },
    { id: 'reminders', label: 'Reminders', icon: 'isle-tasks' },
    { id: 'shelf', label: 'Shelf', icon: 'isle-shelf' },
    { id: 'calendar', label: 'Calendar', icon: 'isle-calendar' },
    { id: 'apps', label: 'Apps', icon: 'isle-apps' },
    { id: 'devices', label: 'Status', icon: 'isle-headphones' },
    { id: 'lights', label: 'Lights', icon: 'isle-bulb' },
    { id: 'usage', label: 'Usage', icon: 'isle-gauge' },
];

export const ACCENT_PRESETS = [
    { id: 'blue', label: 'Blue', hex: '#0a84ff' },
    { id: 'purple', label: 'Purple', hex: '#bf5af2' },
    { id: 'green', label: 'Green', hex: '#30d158' },
    { id: 'orange', label: 'Orange', hex: '#ff9f0a' },
    { id: 'pink', label: 'Pink', hex: '#ff375f' },
    { id: 'teal', label: 'Teal', hex: '#30d5c8' },
];

export const INDICATOR_COLORS = [
    { id: 'blue', label: 'Blue', hex: '#0a84ff' },
    { id: 'green', label: 'Green', hex: '#30d158' },
    { id: 'cyan', label: 'Cyan', hex: '#32d2ff' },
    { id: 'purple', label: 'Purple', hex: '#bf5af2' },
    { id: 'amber', label: 'Amber', hex: '#ff9f0a' },
    { id: 'white', label: 'White', hex: '#ffffff' },
];

export const AI_PROVIDERS = [
    { id: 'auto', label: 'Auto' },
    { id: 'nim', label: 'NIM' },
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
    { id: 'grok', label: 'Grok' },
    { id: 'opencode', label: 'opencode' },
    { id: 'agy', label: 'Agy' },
];

export const NIM_MODELS = [
    { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'Nemotron 120B' },
    { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
];

export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium'];

export const KEEP_CHAT_OPTIONS = [
    { id: 'day', label: 'Today' },
    { id: 'idle-30m', label: '30m idle' },
    { id: 'idle-2h', label: '2h idle' },
];

export const LANGUAGE_OPTIONS = [
    { id: 'auto', label: 'Auto' },
    { id: 'en', label: 'English' },
    { id: 'id', label: 'Indonesian' },
];

const VALID_TAB_IDS = TAB_CATALOG.map(t => t.id);
const VALID_TAB_SET = new Set(VALID_TAB_IDS);
const VALID_POWER_PROFILES = new Set(['power-saver', 'balanced', 'performance', 'lightning']);
const VALID_MUSIC_THEMES = new Set(['rainbow', 'club', 'fire', 'ocean', 'sesh']);
const VALID_SCREEN_REGIONS = new Set(['full_screen', 'top_center', 'mid_left', 'mid_right']);
const VALID_PROVIDERS = new Set(AI_PROVIDERS.map(p => p.id));
const VALID_WHISPER = new Set(WHISPER_MODELS);
const VALID_KEEP_CHAT = new Set(KEEP_CHAT_OPTIONS.map(o => o.id));
const VALID_LANGUAGES = new Set(LANGUAGE_OPTIONS.map(o => o.id));
const VALID_BOT_SHAPES = new Set(['circle', 'pebble', 'squircle', 'capsule', 'cloud', 'hexagon', 'drop', 'ghost']);
const HEX_RE = /^#[0-9a-f]{6}$/i;

function clampInt(v, min, max, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function validHex(v, fallback) {
    return typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : fallback;
}

export function createDefaults() {
    return {
        version: 2,
        glassOpacity: 15,
        clockFormat: '24h',
        soundEnabled: true,
        tabSwitchMode: 'hover',
        tabHoverHoldTime: 500,
        chargeLimitEnabled: true,
        chargeLimitPercent: 70,
        dndEnabled: false,
        powerProfile: null,
        wiz: {
            musicTheme: 'rainbow',
            musicSource: 'system',
            screenRegion: 'full_screen',
            fps: 20,
            brightness: 80,
            manualIp: '',
        },
        calendarViewMode: 'month',
        alarm: {
            hour: 7,
            min: 0,
            active: false,
        },
        tabs: {
            order: [...VALID_TAB_IDS],
            hidden: [],
            defaultTab: 'last',
        },
        header: {
            showAssistantBtn: true,
            showHeaderBars: true,
        },
        compact: {
            showBattery: true,
            showBot: true,
            showDate: true,
            showWifi: true,
            showVolume: true,
            showPrivacyDots: true,
        },
        appearance: {
            accentColor: '#0a84ff',
            batteryChargingColor: '#30d158',
            batteryCappedColor: '#0a84ff',
            lightningOverlayEnabled: true,
        },
        bot: {
            shape: 'cloud',
            colorMode: 'power',
            color: 'sky',
            glow: 'match',
        },
        behavior: {
            openMode: 'hover',
            peekEnabled: true,
            peekDurationMs: 3800,
            lyricsEnabled: true,
        },
        assistant: {
            provider: 'nim',
            nimModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
            claudeModel: '',
            codexModel: '',
            grokModel: '',
            opencodeModel: '',
            agyModel: '',
            whisperModel: 'base',
            language: 'auto',
            keepChat: 'day',
            ttsEnabled: true,
        },
        usage: {
            enabled: false,
            claude: true,
            codex: true,
            grok: true,
            warn: 80,
            critical: 95,
        },
    };
}

export class SettingsStore {
    constructor({ configDir } = {}) {
        this._configDir = configDir || GLib.build_filenamev([GLib.get_user_config_dir(), 'isle']);
        this._settingsPath = GLib.build_filenamev([this._configDir, 'settings.json']);
        this._state = createDefaults();
        this._subscribers = new Set();
        this._saveTimerId = 0;
    }

    get configDir() {
        return this._configDir;
    }

    get settingsPath() {
        return this._settingsPath;
    }

    get() {
        return this._state;
    }

    normalize(raw) {
        const d = createDefaults();
        const src = raw && typeof raw === 'object' ? raw : {};

        d.glassOpacity = clampInt(src.glassOpacity, 5, 85, d.glassOpacity);
        d.clockFormat = src.clockFormat === '12h' ? '12h' : '24h';
        if (src.soundEnabled !== undefined) d.soundEnabled = Boolean(src.soundEnabled);
        d.tabSwitchMode = src.tabSwitchMode === 'click' ? 'click' : 'hover';
        d.tabHoverHoldTime = clampInt(src.tabHoverHoldTime, 100, 2000, d.tabHoverHoldTime);
        if (src.chargeLimitEnabled !== undefined) d.chargeLimitEnabled = Boolean(src.chargeLimitEnabled);
        d.chargeLimitPercent = clampInt(src.chargeLimitPercent, 40, 95, d.chargeLimitPercent);
        if (src.dndEnabled !== undefined) d.dndEnabled = Boolean(src.dndEnabled);
        d.powerProfile = (typeof src.powerProfile === 'string' && VALID_POWER_PROFILES.has(src.powerProfile))
            ? src.powerProfile
            : null;
        d.calendarViewMode = src.calendarViewMode === 'week' ? 'week' : 'month';

        if (src.wiz && typeof src.wiz === 'object') {
            const w = src.wiz;
            d.wiz.musicTheme = VALID_MUSIC_THEMES.has(w.musicTheme) ? w.musicTheme : d.wiz.musicTheme;
            d.wiz.musicSource = w.musicSource === 'mic' ? 'mic' : 'system';
            d.wiz.screenRegion = VALID_SCREEN_REGIONS.has(w.screenRegion) ? w.screenRegion : d.wiz.screenRegion;
            d.wiz.fps = clampInt(w.fps, 5, 60, d.wiz.fps);
            d.wiz.brightness = clampInt(w.brightness, 10, 100, d.wiz.brightness);
            d.wiz.manualIp = typeof w.manualIp === 'string' ? w.manualIp.trim().slice(0, 64) : '';
        }

        if (src.alarm && typeof src.alarm === 'object') {
            d.alarm.hour = clampInt(src.alarm.hour, 0, 23, d.alarm.hour);
            d.alarm.min = clampInt(src.alarm.min, 0, 59, d.alarm.min);
            d.alarm.active = Boolean(src.alarm.active);
        }

        if (src.tabs && typeof src.tabs === 'object') {
            const order = [];
            const seen = new Set();
            if (Array.isArray(src.tabs.order)) {
                for (const id of src.tabs.order) {
                    if (typeof id === 'string' && VALID_TAB_SET.has(id) && !seen.has(id)) {
                        seen.add(id);
                        order.push(id);
                    }
                }
            }
            for (const id of VALID_TAB_IDS) {
                if (!seen.has(id)) {
                    seen.add(id);
                    order.push(id);
                }
            }
            d.tabs.order = order;

            const hidden = [];
            const hiddenSet = new Set();
            if (Array.isArray(src.tabs.hidden)) {
                for (const id of src.tabs.hidden) {
                    if (typeof id === 'string' && VALID_TAB_SET.has(id) && !hiddenSet.has(id)) {
                        hiddenSet.add(id);
                        hidden.push(id);
                    }
                }
            }
            // Guarantee at least one visible tab remains
            if (hidden.length >= VALID_TAB_IDS.length) {
                hidden.pop();
            }
            const finalHiddenSet = new Set(hidden);
            d.tabs.hidden = hidden;

            const visOrder = order.filter(id => !finalHiddenSet.has(id));
            const hidOrder = order.filter(id => finalHiddenSet.has(id));
            d.tabs.order = [...visOrder, ...hidOrder];

            const def = src.tabs.defaultTab;
            const visibleSet = new Set(visOrder);
            d.tabs.defaultTab = (def === 'last' || (typeof def === 'string' && visibleSet.has(def))) ? def : 'last';
        }

        if (src.header && typeof src.header === 'object') {
            if (src.header.showAssistantBtn !== undefined) d.header.showAssistantBtn = Boolean(src.header.showAssistantBtn);
            if (src.header.showHeaderBars !== undefined) d.header.showHeaderBars = Boolean(src.header.showHeaderBars);
        }

        if (src.compact && typeof src.compact === 'object') {
            for (const k of ['showBattery', 'showBot', 'showDate', 'showWifi', 'showVolume', 'showPrivacyDots']) {
                if (src.compact[k] !== undefined) d.compact[k] = Boolean(src.compact[k]);
            }
        }

        if (src.appearance && typeof src.appearance === 'object') {
            d.appearance.accentColor = validHex(src.appearance.accentColor, d.appearance.accentColor);
            d.appearance.batteryChargingColor = validHex(src.appearance.batteryChargingColor, d.appearance.batteryChargingColor);
            d.appearance.batteryCappedColor = validHex(src.appearance.batteryCappedColor, d.appearance.batteryCappedColor);
            if (src.appearance.lightningOverlayEnabled !== undefined) {
                d.appearance.lightningOverlayEnabled = Boolean(src.appearance.lightningOverlayEnabled);
            }
        }

        if (src.bot && typeof src.bot === 'object') {
            if (typeof src.bot.shape === 'string' && VALID_BOT_SHAPES.has(src.bot.shape)) {
                d.bot.shape = src.bot.shape;
            }
            d.bot.colorMode = src.bot.colorMode === 'fixed' ? 'fixed' : 'power';
            if (typeof src.bot.color === 'string' && src.bot.color.trim()) {
                d.bot.color = src.bot.color.trim().slice(0, 32);
            }
            if (typeof src.bot.glow === 'string' && src.bot.glow.trim()) {
                d.bot.glow = src.bot.glow.trim().slice(0, 32);
            }
        }

        if (src.behavior && typeof src.behavior === 'object') {
            d.behavior.openMode = src.behavior.openMode === 'click' ? 'click' : 'hover';
            if (src.behavior.peekEnabled !== undefined) d.behavior.peekEnabled = Boolean(src.behavior.peekEnabled);
            d.behavior.peekDurationMs = clampInt(src.behavior.peekDurationMs, 1500, 10000, d.behavior.peekDurationMs);
            if (src.behavior.lyricsEnabled !== undefined) d.behavior.lyricsEnabled = Boolean(src.behavior.lyricsEnabled);
        }

        if (src.assistant && typeof src.assistant === 'object') {
            const a = src.assistant;
            if (typeof a.provider === 'string' && VALID_PROVIDERS.has(a.provider)) d.assistant.provider = a.provider;
            if (typeof a.nimModel === 'string' && a.nimModel.trim()) d.assistant.nimModel = a.nimModel.trim();
            for (const mk of ['claudeModel', 'codexModel', 'grokModel', 'opencodeModel', 'agyModel']) {
                if (typeof a[mk] === 'string') d.assistant[mk] = a[mk].trim();
            }
            if (typeof a.whisperModel === 'string' && VALID_WHISPER.has(a.whisperModel)) d.assistant.whisperModel = a.whisperModel;
            if (typeof a.language === 'string' && VALID_LANGUAGES.has(a.language)) d.assistant.language = a.language;
            if (typeof a.keepChat === 'string' && VALID_KEEP_CHAT.has(a.keepChat)) d.assistant.keepChat = a.keepChat;
            if (a.ttsEnabled !== undefined) d.assistant.ttsEnabled = Boolean(a.ttsEnabled);
        }

        if (src.usage && typeof src.usage === 'object') {
            const u = src.usage;
            if (u.enabled !== undefined) d.usage.enabled = Boolean(u.enabled);
            if (u.claude !== undefined) d.usage.claude = Boolean(u.claude);
            if (u.codex !== undefined) d.usage.codex = Boolean(u.codex);
            if (u.grok !== undefined) d.usage.grok = Boolean(u.grok);
            d.usage.warn = clampInt(u.warn, 50, 95, d.usage.warn);
            d.usage.critical = clampInt(u.critical, Math.max(70, d.usage.warn + 1), 99, d.usage.critical);
        }

        return d;
    }

    _syncGlobals() {
        const s = this._state;
        Format.setClockFormat(s.clockFormat);
        globalThis.isleSoundEnabled = s.soundEnabled;
        globalThis.isleTabSwitchMode = s.tabSwitchMode;
        globalThis.isleTabHoverHoldTime = s.tabHoverHoldTime;
        globalThis.isleChargeLimitEnabled = s.chargeLimitEnabled;
        globalThis.isleChargeLimitPercent = s.chargeLimitPercent;
        globalThis.isleDndEnabled = s.dndEnabled;
        globalThis.islePowerProfile = s.powerProfile;
        globalThis.isleWizSettings = { ...s.wiz };
        globalThis.isleCalendarViewMode = s.calendarViewMode;
        globalThis.isleAlarmSettings = { ...s.alarm };
    }

    _absorbGlobals() {
        const s = this._state;
        if (globalThis.isleSoundEnabled !== undefined) s.soundEnabled = Boolean(globalThis.isleSoundEnabled);
        if (globalThis.isleTabSwitchMode) s.tabSwitchMode = globalThis.isleTabSwitchMode === 'click' ? 'click' : 'hover';
        if (globalThis.isleTabHoverHoldTime !== undefined) s.tabHoverHoldTime = globalThis.isleTabHoverHoldTime;
        if (globalThis.isleChargeLimitEnabled !== undefined) s.chargeLimitEnabled = Boolean(globalThis.isleChargeLimitEnabled);
        if (globalThis.isleChargeLimitPercent !== undefined) s.chargeLimitPercent = globalThis.isleChargeLimitPercent;
        if (globalThis.isleDndEnabled !== undefined) s.dndEnabled = Boolean(globalThis.isleDndEnabled);
        if (globalThis.islePowerProfile !== undefined) s.powerProfile = globalThis.islePowerProfile;
        if (globalThis.isleWizSettings && typeof globalThis.isleWizSettings === 'object') {
            s.wiz = {
                ...s.wiz,
                ...globalThis.isleWizSettings,
                manualIp: globalThis.isleWizSettings.manualIp !== undefined
                    ? globalThis.isleWizSettings.manualIp
                    : s.wiz.manualIp,
            };
        }
        if (globalThis.isleCalendarViewMode) s.calendarViewMode = globalThis.isleCalendarViewMode;
        if (globalThis.isleAlarmSettings && typeof globalThis.isleAlarmSettings === 'object') {
            s.alarm = { ...s.alarm, ...globalThis.isleAlarmSettings };
        }
        s.clockFormat = Format.uses12Hour() ? '12h' : '24h';
        this._state = this.normalize(s);
    }

    load() {
        try {
            const f = Gio.File.new_for_path(this._settingsPath);
            if (f.query_exists(null)) {
                const [ok, contents] = f.load_contents(null);
                if (ok) {
                    const parsed = JSON.parse(new TextDecoder().decode(contents));
                    this._state = this.normalize(parsed);
                }
            }
        } catch (e) {
            print('[Isle SettingsStore] Could not load settings:', e.message);
            this._state = createDefaults();
        }
        this._syncGlobals();
        return this._state;
    }

    save({ absorbGlobals = true } = {}) {
        if (this._saveTimerId) {
            GLib.source_remove(this._saveTimerId);
            this._saveTimerId = 0;
        }
        if (absorbGlobals) {
            this._absorbGlobals();
        } else {
            this._state = this.normalize(this._state);
            this._syncGlobals();
        }
        try {
            GLib.mkdir_with_parents(this._configDir, 0o700);
            const f = Gio.File.new_for_path(this._settingsPath);
            f.replace_contents(
                JSON.stringify(this._state, null, 2),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            return true;
        } catch (e) {
            print('[Isle SettingsStore] Could not save settings:', e.message);
            return false;
        }
    }

    saveDeferred(delayMs = 150) {
        if (this._saveTimerId) {
            GLib.source_remove(this._saveTimerId);
            this._saveTimerId = 0;
        }
        this._saveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(20, delayMs), () => {
            this._saveTimerId = 0;
            this.save({ absorbGlobals: false });
            return GLib.SOURCE_REMOVE;
        });
    }

    subscribe(topics, fn) {
        const set = topics === '*'
            ? '*'
            : new Set(Array.isArray(topics) ? topics : [topics]);
        const entry = { set, fn };
        this._subscribers.add(entry);
        return () => this._subscribers.delete(entry);
    }

    notify(changedTopics) {
        const list = changedTopics === '*'
            ? ['*']
            : (Array.isArray(changedTopics) ? changedTopics : [changedTopics]);
        for (const entry of [...this._subscribers]) {
            const match = entry.set === '*'
                || list.includes('*')
                || list.some(t => entry.set.has(t));
            if (!match) continue;
            try {
                entry.fn(this._state, list);
            } catch (e) {
                print('[Isle SettingsStore] Subscriber error:', e.message);
            }
        }
    }

    update(mutatorFn, topics = '*', { save = true, deferMs = 0 } = {}) {
        const draft = JSON.parse(JSON.stringify(this._state));
        mutatorFn(draft);
        this._state = this.normalize(draft);
        this._syncGlobals();
        if (deferMs > 0) {
            this.saveDeferred(deferMs);
        } else if (save) {
            this.save({ absorbGlobals: false });
        }
        if (topics) {
            this.notify(topics);
        }
        return this._state;
    }

    isTabHidden(tabId) {
        return this._state.tabs.hidden.includes(tabId);
    }

    visibleTabs() {
        const hidden = new Set(this._state.tabs.hidden);
        return this._state.tabs.order.filter(id => !hidden.has(id));
    }

    hiddenTabs() {
        const hidden = new Set(this._state.tabs.hidden);
        return this._state.tabs.order.filter(id => hidden.has(id));
    }

    setTabVisible(tabId, visible) {
        if (!VALID_TAB_SET.has(tabId)) return false;
        const hidden = new Set(this._state.tabs.hidden);
        const vis = this.visibleTabs();
        const hid = this.hiddenTabs();

        if (!visible) {
            if (vis.length <= 1 && !hidden.has(tabId)) {
                return false;
            }
            hidden.add(tabId);
        } else {
            hidden.delete(tabId);
        }

        const nextOrder = visible
            ? [...vis.filter(id => id !== tabId), tabId, ...hid.filter(id => id !== tabId)]
            : [...vis.filter(id => id !== tabId), ...hid.filter(id => id !== tabId), tabId];

        this.update(s => {
            s.tabs.hidden = [...hidden];
            s.tabs.order = nextOrder;
            if (!visible && s.tabs.defaultTab === tabId) {
                s.tabs.defaultTab = 'last';
            }
        }, 'tabs');
        return true;
    }

    moveTab(tabId, delta) {
        const vis = [...this.visibleTabs()];
        const idx = vis.indexOf(tabId);
        if (idx < 0) return false;
        const target = idx + (delta < 0 ? -1 : 1);
        if (target < 0 || target >= vis.length) return false;
        [vis[idx], vis[target]] = [vis[target], vis[idx]];
        this.update(s => {
            s.tabs.order = [...vis, ...this.hiddenTabs()];
        }, 'tabs');
        return true;
    }

    setVisibleTabOrder(newVisibleIds) {
        if (!Array.isArray(newVisibleIds)) return false;
        const curVis = this.visibleTabs();
        const curVisSet = new Set(curVis);
        const cleanVis = [];
        const seen = new Set();
        for (const id of newVisibleIds) {
            if (curVisSet.has(id) && !seen.has(id)) {
                seen.add(id);
                cleanVis.push(id);
            }
        }
        for (const id of curVis) {
            if (!seen.has(id)) {
                seen.add(id);
                cleanVis.push(id);
            }
        }
        this.update(s => {
            s.tabs.order = [...cleanVis, ...this.hiddenTabs()];
        }, 'tabs');
        return true;
    }

    buildAssistantContext() {
        const a = this._state.assistant;
        return {
            provider: a.provider,
            nim_model: a.nimModel,
            claude_model: a.claudeModel,
            codex_model: a.codexModel,
            grok_model: a.grokModel,
            opencode_model: a.opencodeModel,
            agy_model: a.agyModel,
            whisper_model: a.whisperModel,
            language: a.language,
            keep_chat: a.keepChat,
        };
    }

    syncTtsMuteFlag() {
        const runtimeDir = GLib.get_user_runtime_dir();
        if (!runtimeDir) return;
        const flagFile = Gio.File.new_for_path(GLib.build_filenamev([runtimeDir, 'isle-speech-muted']));
        try {
            if (this._state.assistant.ttsEnabled) {
                if (flagFile.query_exists(null)) flagFile.delete(null);
            } else if (!flagFile.query_exists(null)) {
                flagFile.create(Gio.FileCreateFlags.NONE, null);
            }
        } catch (e) {
            print('[Isle SettingsStore] Could not sync TTS mute flag:', e.message);
        }
    }

    exportBackup(destPath) {
        try {
            const f = Gio.File.new_for_path(destPath);
            f.replace_contents(
                JSON.stringify(this._state, null, 2),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            return true;
        } catch (e) {
            print('[Isle SettingsStore] Export failed:', e.message);
            return false;
        }
    }

    reload() {
        this.load();
        this.notify('*');
        return this._state;
    }

    resetToDefaults() {
        this._state = createDefaults();
        this._syncGlobals();
        this.save({ absorbGlobals: false });
        this.notify('*');
        return this._state;
    }
}

let _instance = null;
export function getSettingsStore() {
    if (!_instance) {
        _instance = new SettingsStore();
        _instance.load();
    }
    return _instance;
}
