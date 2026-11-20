// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Dedicated AI Quota page for Isle XFCE GTK4 runtime.
//! Connects end-to-end with isled Usage1 D-Bus service, settingsStore, and authStore.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { getAuthStore } from '../authStore.js';
import { Page } from '../page.js';
import { getSettingsStore } from '../settingsStore.js';
import { iconButton, label, pillButton } from '../widgets.js';

const ACCENTS = {
    claude: '#d97857',
    codex: '#0fa47f',
    grok: '#e5e7eb',
    antigravity: '#60a5fa',
    nim: '#76b900',
};

function formatRelativeReset(resetsAtMs) {
    if (!resetsAtMs || resetsAtMs <= 0) return '';
    const diffSec = Math.max(0, Math.round((resetsAtMs - Date.now()) / 1000));
    if (diffSec < 60) return 'resets <1m';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `resets in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `resets in ${hours}h ${remMins}m` : `resets in ${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `resets in ${days}d ${remHours}h` : `resets in ${days}d`;
}

function formatUpdatedAgo(updatedMs) {
    if (!updatedMs || updatedMs <= 0) return 'not synced';
    const diffSec = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));
    if (diffSec < 15) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
}

export const QuotaPage = GObject.registerClass({
    GTypeName: 'IsleGtkQuotaPage',
}, class QuotaPage extends Page {
    _init(daemon, { height = 245 } = {}) {
        super._init(daemon, {
            name: 'quota',
            available: true,
            height,
        });

        this._selectedFilter = 'all';
        this._lastAlert = null;
        this._dotProviders = [];
        this._settings = getSettingsStore();

        this._root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-quota-root'],
        });
        this.append(this._root);

        this._buildHeader();
        this._buildFilterStrip();

        this._scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            propagate_natural_height: false,
            css_classes: ['isle-quota-scroll'],
        });
        this._listBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.START,
            css_classes: ['isle-quota-list'],
        });
        this._scroll.set_child(this._listBox);
        this._root.append(this._scroll);

        this.watch(['usage'], () => this._render());

        this._settingsSubId = this._settings.subscribe(['usage', 'assistant'], () => this._render());
        this._alertId = this.daemon?.connect?.('usage-alert', (_d, provider, win, percent, resetsAtMs) => {
            this._lastAlert = { provider, window: win, percent, resetsAtMs, at: Date.now() };
            this._render();
        }) ?? 0;

        this.connect('map', () => {
            this._render();
            if (this._settings.get().usage?.enabled && this.daemon?._proxies?.['usage']) {
                this.daemon.call('usage', 'Refresh').catch(() => {});
            }
        });

        this.connect('destroy', () => {
            if (this._settingsSubId) this._settings.unsubscribe(this._settingsSubId);
            if (this._alertId && this.daemon?.disconnect) {
                this.daemon.disconnect(this._alertId);
            }
        });

        this._render();
    }

    getDesiredHeight() {
        return 245;
    }

    _buildHeader() {
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-quota-header'],
        });

        const title = label('AI Quota', 'isle-quota-title', {
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        header.append(title);

        this._modeBadge = label('Isle Default', 'isle-usage-plan', {
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        header.append(this._modeBadge);

        this._toggleBtn = pillButton('Tracking Off', 'isle-quota-toggle', () => {
            const cur = Boolean(this._settings.get().usage?.enabled);
            this._settings.set('usage.enabled', !cur);
        });
        this._toggleBtn.set_focus_on_click(false);
        header.append(this._toggleBtn);

        this._refreshBtn = iconButton('isle-update-symbolic', 'isle-button-flat isle-quota-refresh', () => {
            if (!this._settings.get().usage?.enabled) {
                this._settings.set('usage.enabled', true);
                return;
            }
            this.daemon?.call?.('usage', 'Refresh').catch(() => {});
        }, { size: 15, accessibleName: 'Refresh AI Quota' });
        this._refreshBtn.set_tooltip_text('Refresh quota now');
        this._refreshBtn.set_focus_on_click(false);
        header.append(this._refreshBtn);

        this._root.append(header);
    }

    _buildFilterStrip() {
        this._filterStrip = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 5,
            hexpand: true,
            css_classes: ['isle-quota-filters'],
        });

        this._filterButtons = {};
        const filters = [
            { id: 'all', label: 'All' },
            { id: 'claude', label: 'Claude' },
            { id: 'codex', label: 'Codex' },
            { id: 'grok', label: 'Grok' },
            { id: 'antigravity', label: 'Antigravity' },
            { id: 'nim', label: 'NIM' },
        ];

        for (const f of filters) {
            const btn = new Gtk.Button({
                css_classes: ['isle-quota-chip'],
                focus_on_click: false,
            });
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 5,
                valign: Gtk.Align.CENTER,
            });
            if (f.id !== 'all') {
                const dot = new Gtk.Box({
                    css_classes: ['isle-quota-chip-dot'],
                    valign: Gtk.Align.CENTER,
                });
                this._applyDotColor(dot, ACCENTS[f.id] || '#94a3b8');
                row.append(dot);
            }
            row.append(label(f.label, 'isle-quota-chip-label'));
            btn.set_child(row);
            btn.connect('clicked', () => {
                this._selectedFilter = f.id;
                this._render();
            });
            this._filterButtons[f.id] = btn;
            this._filterStrip.append(btn);
        }

        this._root.append(this._filterStrip);
    }

    _applyDotColor(widget, hex) {
        const provider = new Gtk.CssProvider();
        provider.load_from_data(`* { background-color: ${hex}; }`, -1);
        widget.get_style_context().add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        this._dotProviders.push(provider);
    }

    _clearList() {
        this._dotProviders = [];
        let child = this._listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._listBox.remove(child);
            child = next;
        }
    }

    _render() {
        const settings = this._settings.get();
        const usageCfg = settings.usage || {};
        const enabled = Boolean(usageCfg.enabled);
        const aiMode = settings.assistant?.mode === 'custom' ? 'Custom AI' : 'Isle Default';

        this._modeBadge.set_text(aiMode);
        this._toggleBtn.set_label(enabled ? 'Tracking On' : 'Tracking Off');
        if (enabled) this._toggleBtn.add_css_class('active');
        else this._toggleBtn.remove_css_class('active');

        this._refreshBtn.set_sensitive(Boolean(this.daemon?._proxies?.['usage']));

        for (const [id, btn] of Object.entries(this._filterButtons)) {
            if (id === this._selectedFilter) btn.add_css_class('active');
            else btn.remove_css_class('active');
        }

        this._clearList();

        if (this._lastAlert && Date.now() - this._lastAlert.at < 10 * 60 * 1000) {
            this._renderAlertBanner(this._lastAlert);
        }

        const liveProviders = this.daemon?.state?.usage?.providers ?? [];
        const liveById = new Map(liveProviders.map(p => [p.id, p]));
        const authStore = getAuthStore();
        const authStatuses = new Map(authStore.getProviderStatuses().map(s => [s.id, s]));
        const nimStatus = authStore.getNimKeyStatus();

        if (!enabled) {
            this._renderDisabledBanner(authStatuses, nimStatus);
        }

        const warnMark = Number(usageCfg.warn ?? 80);
        const critMark = Number(usageCfg.critical ?? 95);

        const daemonIds = ['antigravity', 'claude', 'codex', 'grok'].filter(
            id => this._selectedFilter === 'all' || this._selectedFilter === id
        );

        let renderedAny = false;
        for (const id of daemonIds) {
            const provider = liveById.get(id);
            const auth = authStatuses.get(id === 'antigravity' ? 'agy' : id);
            const tracked = usageCfg[id] !== false;
            if (provider) {
                this._renderLiveProvider(provider, warnMark, critMark);
                renderedAny = true;
            } else if (enabled || this._selectedFilter === id || auth?.configured) {
                this._renderDaemonPlaceholder(id, auth, tracked, enabled);
                renderedAny = true;
            }
        }

        if (this._selectedFilter === 'all' || this._selectedFilter === 'nim') {
            this._renderStaticProviderCard({
                id: 'nim',
                name: 'NVIDIA NIM',
                badge: nimStatus.configured ? `Key (${nimStatus.source})` : 'No Key',
                ok: nimStatus.configured,
                detail: nimStatus.configured
                    ? `Active for ${aiMode} (${nimStatus.hint}). Pay-as-you-go / rate-limited per endpoint.`
                    : 'Add an NVIDIA NIM key in Settings → AI & Auth to enable Custom AI.',
            });
            renderedAny = true;
        }

        if (!renderedAny) {
            this._listBox.append(label('No quota providers selected.', 'isle-usage-empty', {
                halign: Gtk.Align.CENTER,
                margin_top: 16,
            }));
        }
    }

    _renderAlertBanner(alert) {
        const banner = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-quota-alert'],
        });
        const msg = `${alert.provider} ${alert.window} reached ${Math.round(alert.percent)}%`;
        banner.append(label(msg, 'isle-quota-alert-text', { hexpand: true, halign: Gtk.Align.START }));
        const dismiss = iconButton('isle-close-symbolic', 'isle-button-flat', () => {
            this._lastAlert = null;
            this._render();
        }, { size: 12, accessibleName: 'Dismiss alert' });
        dismiss.set_focus_on_click(false);
        banner.append(dismiss);
        this._listBox.append(banner);
    }

    _renderDisabledBanner(authStatuses, nimStatus) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-quota-card', 'isle-quota-banner'],
        });

        const col = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
        });
        col.append(label('Live AI plan polling is paused', 'isle-usage-window', { halign: Gtk.Align.START }));
        const readyCount = ['claude', 'codex', 'grok'].filter(id => authStatuses.get(id)?.configured).length
            + (nimStatus.configured ? 1 : 0);
        col.append(label(`${readyCount} local provider credential(s) detected`, 'isle-usage-reset', { halign: Gtk.Align.START }));
        card.append(col);

        const enableBtn = pillButton('Enable Tracking', 'isle-quota-enable-btn', () => {
            this._settings.set('usage.enabled', true);
        });
        enableBtn.set_focus_on_click(false);
        card.append(enableBtn);

        this._listBox.append(card);
    }

    _renderLiveProvider(provider, warnMark, critMark) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            css_classes: ['isle-quota-card'],
        });

        const head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            css_classes: ['isle-usage-head'],
        });

        const mark = new Gtk.Box({
            css_classes: ['isle-usage-mark'],
            valign: Gtk.Align.CENTER,
        });
        this._applyDotColor(mark, ACCENTS[provider.id] || '#3b82f6');
        head.append(mark);

        head.append(label(provider.name || provider.id, 'isle-usage-name', {
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        }));

        if (provider.plan) {
            head.append(label(provider.plan, 'isle-usage-plan', {
                halign: Gtk.Align.START,
                valign: Gtk.Align.CENTER,
            }));
        }

        const stampText = provider.note ? provider.note : formatUpdatedAgo(provider.updated_ms);
        const stamp = label(stampText, provider.note ? 'isle-usage-stamp warning' : 'isle-usage-stamp', {
            hexpand: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
        });
        stamp.set_ellipsize(Pango.EllipsizeMode.END);
        head.append(stamp);
        card.append(head);

        const windows = provider.windows || [];
        if (windows.length === 0) {
            card.append(label(provider.empty || provider.note || 'No usage windows reported yet.', 'isle-usage-empty', {
                halign: Gtk.Align.START,
                wrap: true,
            }));
        } else {
            for (const win of windows) {
                card.append(this._buildWindowRow(win, warnMark, critMark));
            }
        }

        this._listBox.append(card);
    }

    _buildWindowRow(win, warnMark, critMark) {
        const pct = Math.max(0, Math.min(100, Number(win.percent ?? 0)));
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 3,
            css_classes: ['isle-usage-limit'],
        });

        const line = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        line.append(label(win.label || 'Window', 'isle-usage-window', {
            halign: Gtk.Align.START,
        }));

        const resetStr = formatRelativeReset(win.resets_at_ms);
        line.append(label(resetStr, 'isle-usage-reset', {
            hexpand: true,
            halign: Gtk.Align.END,
        }));

        const pctCls = pct >= critMark ? 'isle-usage-percent critical' : 'isle-usage-percent';
        const pctLbl = label(`${Math.round(pct)}%`, pctCls, {
            halign: Gtk.Align.END,
        });
        pctLbl.set_xalign(1);
        line.append(pctLbl);
        row.append(line);

        const trackCls = ['isle-usage-track', pct >= critMark ? 'crit' : (pct >= warnMark ? 'warn' : 'ok')];
        const track = new Gtk.ProgressBar({
            fraction: pct / 100,
            hexpand: true,
            css_classes: trackCls,
        });
        row.append(track);

        return row;
    }

    _renderDaemonPlaceholder(id, auth, tracked, enabled) {
        const names = { antigravity: 'Antigravity', claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
        let status = 'Waiting for daemon';
        if (!tracked) status = 'Disabled in Settings';
        else if (!auth?.configured) status = 'Not signed in';
        else if (!enabled) status = 'Tracking off';

        this._renderStaticProviderCard({
            id,
            name: names[id] || id,
            badge: status,
            ok: Boolean(auth?.configured && tracked),
            detail: !auth?.configured
                ? `Sign in with \`${auth?.signInCmd || id}\` to track live plan usage.`
                : (!tracked
                    ? 'Enable this provider in Settings → AI & Auth → Track AI Plan Usage.'
                    : 'Waiting for next isled usage poll.'),
        });
    }

    _renderStaticProviderCard({ id, name, badge, ok, detail }) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            css_classes: ['isle-quota-card'],
        });

        const head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });

        const mark = new Gtk.Box({
            css_classes: ['isle-usage-mark'],
            valign: Gtk.Align.CENTER,
        });
        this._applyDotColor(mark, ACCENTS[id] || '#94a3b8');
        head.append(mark);

        head.append(label(name, 'isle-usage-name', {
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        }));

        head.append(label(badge, ok ? 'isle-quota-badge-ok' : 'isle-usage-plan', {
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
        }));
        card.append(head);

        const detailLbl = label(detail, 'isle-usage-empty', {
            halign: Gtk.Align.START,
            wrap: true,
        });
        card.append(detailLbl);

        this._listBox.append(card);
    }
});
