// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Phase 2A Widget Library Showcase for Isle XFCE.
//! Exercises and visually proves all ported Isle design system components.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {
    Art,
    Bars,
    BotIcon,
    LevelBar,
    Lines,
    PrivacyDots,
    RecordingDot,
    Ring,
    Slider,
    VolumeGlyph,
    cornerClose,
    iconButton,
    label,
    pillButton,
    revealClose,
    setEnabled,
    setButtonIcon,
    wrapLines,
} from './widgets.js';

export const ShowcaseView = GObject.registerClass({
    GTypeName: 'IsleGtkShowcaseView',
}, class ShowcaseView extends Gtk.Box {
    _init() {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 22,
            margin_end: 22,
            css_classes: ['isle-showcase-view'],
        });

        // ── 1. Header Row: Avatar, Title with Lines, Privacy & Recording Dots, Ring ──
        const headerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        // Assistant Bot Avatar
        this._bot = new BotIcon(20, { shape: 'cloud', color: 'cloud', glow: 'match' });
        headerRow.append(this._bot);

        // Multi-line wrapping title via Lines
        const titleLabel = label('Isle Phase 2A Widget Library', 'isle-header-title');
        wrapLines(titleLabel);
        this._titleLines = new Lines(titleLabel, 1);
        this._titleLines.set_hexpand(true);
        headerRow.append(this._titleLines);

        // Breathing red recording dot
        this._recDot = new RecordingDot();
        headerRow.append(this._recDot);

        // Privacy indicator dots
        this._privacy = new PrivacyDots();
        this._privacy.update({ camera: true, microphone: true });
        headerRow.append(this._privacy);

        // Circular progress ring with fill sweep
        this._ring = new Ring({ size: 22, lineWidth: 2.5, progress: 0.65 });
        this._ring.fillTo(0.85, { delay: 300, duration: 800 });
        headerRow.append(this._ring);

        // Corner close button
        this._closeBtn = cornerClose(() => print('[Showcase] Close clicked'));
        headerRow.append(this._closeBtn);
        revealClose(this._closeBtn, true);

        this.append(headerRow);

        // ── 2. Media Row: Art, Track info, VolumeGlyph, Slider, Bars ──────────
        const mediaRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        // Cover Art with rounded clipping and placeholder
        this._art = new Art({ size: 44, radius: 10 });
        mediaRow.append(this._art);

        // Middle track and volume column
        const trackCol = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        const trackTitle = label('Solar Fields — Sol (Isle Master)', 'isle-media-title');
        wrapLines(trackTitle);
        trackCol.append(trackTitle);

        const volumeRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });

        this._volume = new VolumeGlyph({ size: 16 });
        this._volume.setLevel(0.66, false);
        volumeRow.append(this._volume);

        this._slider = new Slider({ scrollStep: 0.05 });
        this._slider.set_hexpand(true);
        this._slider.value = 0.66;
        volumeRow.append(this._slider);

        this._volText = label('66%', 'isle-volume-text');
        volumeRow.append(this._volText);

        this._slider.connect('value-changed', (s, val) => {
            this._volume.setLevel(val, val < 0.01);
            this._levelBar.level = val;
            this._volText.set_text(`${Math.round(val * 100)}%`);
        });

        trackCol.append(volumeRow);
        mediaRow.append(trackCol);

        // LevelBar and dancing equalizer bars
        const rightCol = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        this._levelBar = new LevelBar({ width: 50 });
        this._levelBar.level = 0.66;
        rightCol.append(this._levelBar);

        this._bars = new Bars({ height: 16, count: 5 });
        this._bars.playing = true;
        rightCol.append(this._bars);

        mediaRow.append(rightCol);
        this.append(mediaRow);

        // ── 3. Actions Row: pillButtons, iconButtons, and disabled state ───────
        const actionRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        // Standard grey pill button
        const pillNormal = pillButton('Play', 'isle-pill-small', () => {
            this._bars.playing = !this._bars.playing;
        });
        actionRow.append(pillNormal);

        // Accent pill button (e.g. Join call)
        const pillAccent = pillButton('Join Call', 'isle-pill-small isle-pill-accent', () => {
            this._ring.fillTo(1.0);
        });
        actionRow.append(pillAccent);

        // White pill button (e.g. Done/OK)
        const pillWhite = pillButton('Done', 'isle-pill-small isle-pill-white', () => {
            this._levelBar.growTo(0.95);
        });
        actionRow.append(pillWhite);

        // Spacer
        const spacer = new Gtk.Box({ hexpand: true });
        actionRow.append(spacer);

        // Round icon button
        const playBtn = iconButton('isle-play-symbolic', 'isle-button-round', () => {
            this._bars.playing = !this._bars.playing;
        }, { size: 14 });
        actionRow.append(playBtn);

        // Flat icon button
        const nextBtn = iconButton('isle-next-symbolic', 'isle-button-flat', () => {
            print('[Showcase] Next clicked');
        }, { size: 14 });
        actionRow.append(nextBtn);

        // Disabled button demonstrating setEnabled opacity & reactivity
        const disabledBtn = pillButton('Disabled', 'isle-pill-small');
        setEnabled(disabledBtn, false);
        actionRow.append(disabledBtn);

        this.append(actionRow);
    }
});
