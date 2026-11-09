// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Now Playing page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/media.js.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as Format from '../format.js';
import * as Playback from '../playback.js';
import { Art, Slider, icon, iconButton, label, setButtonIcon } from '../widgets.js';
import { Page } from '../page.js';

const ART_SIZE = 104;
const PROGRESS_REFRESH_MS = 250;

export const MediaPage = GObject.registerClass({
    GTypeName: 'IsleGtkMediaPage',
}, class MediaPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'music',
            height,
        });

        this._playerBox = null;
        this._emptyBox = null;
        this._art = null;
        this._title = null;
        this._artist = null;
        this._elapsed = null;
        this._remaining = null;
        this._scrubber = null;
        this._playButton = null;
        this._prevButton = null;
        this._nextButton = null;

        this._buildUi();

        this.watch(['nowPlaying', 'lyrics', 'players'], () => this._update());
        this._update();
    }

    _buildUi() {
        // Stack to switch between Player view and Empty view
        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 150,
            hexpand: true,
            vexpand: true,
        });

        // 1. Empty view
        this._emptyBox = this._buildEmpty({
            iconName: 'isle-media',
            iconSize: 28,
            title: 'Nothing playing',
            hint: 'Play music or podcasts in any player',
        });
        this._stack.add_named(this._emptyBox, 'empty');

        // 2. Player view
        this._playerBox = this._buildPlayer();
        this._stack.add_named(this._playerBox, 'player');

        this.append(this._stack);
    }

    _buildPlayer() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 16,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-player'],
        });

        // Album Art
        this._art = new Art({ size: ART_SIZE, radius: 16 });
        const click = new Gtk.GestureClick();
        click.connect('released', () => this.daemon.call('media', 'Raise'));
        this._art.add_controller(click);
        row.append(this._art);

        // Right column: head, progress, controls
        const col = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-player-column'],
        });

        // Head: Title & Artist
        const head = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            css_classes: ['isle-player-head'],
        });

        const texts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.START,
            css_classes: ['isle-player-texts'],
        });

        this._title = label('', 'isle-track-title');
        this._title.set_ellipsize(Pango.EllipsizeMode.END);
        this._title.set_halign(Gtk.Align.START);

        this._artist = label('', 'isle-track-subtitle');
        this._artist.set_ellipsize(Pango.EllipsizeMode.END);
        this._artist.set_halign(Gtk.Align.START);

        texts.append(this._title);
        texts.append(this._artist);
        head.append(texts);

        // Right mode icons (placeholder / lyrics / output toggle)
        const modes = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            css_classes: ['isle-player-modes'],
        });
        const lyricsBtn = iconButton('isle-lyrics', 'isle-button-flat isle-mode-toggle', () => {}, {
            size: 16,
            accessibleName: 'Show lyrics',
        });
        const outputBtn = iconButton('isle-output', 'isle-button-flat isle-mode-toggle', () => {}, {
            size: 16,
            accessibleName: 'Volume and output',
        });
        modes.append(lyricsBtn);
        modes.append(outputBtn);
        head.append(modes);
        col.append(head);

        // Progress row: Elapsed, Scrubber, Remaining
        const progress = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-player-progress'],
        });

        this._elapsed = label('0:00', 'isle-time');
        this._remaining = label('−0:00', 'isle-time isle-time-end');
        this._scrubber = new Slider();
        this._scrubber.connect('released', (_slider, fraction) => {
            const length = this.daemon.state.nowPlaying?.length_us ?? 0;
            if (length > 0)
                this.daemon.call('media', 'SetPosition', Math.round(fraction * length));
        });

        progress.append(this._elapsed);
        progress.append(this._scrubber);
        progress.append(this._remaining);
        col.append(progress);

        // Transport controls
        const transport = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-transport'],
        });

        this._prevButton = iconButton('isle-backward-symbolic', 'isle-button-flat', () => {
            this.daemon.call('media', 'Previous');
        }, { size: 18, accessibleName: 'Previous' });

        this._playButton = iconButton('isle-play-symbolic', 'isle-button-flat isle-play', () => {
            this.daemon.call('media', 'PlayPause');
        }, { size: 22, accessibleName: 'Play or pause' });

        this._nextButton = iconButton('isle-forward-symbolic', 'isle-button-flat', () => {
            this.daemon.call('media', 'Next');
        }, { size: 18, accessibleName: 'Next' });

        transport.append(this._prevButton);
        transport.append(this._playButton);
        transport.append(this._nextButton);
        col.append(transport);

        row.append(col);
        return row;
    }

    get relevant() {
        return Playback.showsClosed(this.daemon?.state?.nowPlaying);
    }

    _update() {
        const nowPlaying = this.daemon?.state?.nowPlaying;
        const hasTrack = Playback.hasTrack(nowPlaying);

        if (!hasTrack) {
            this._stack.set_visible_child_name('empty');
            this.cancel('progress');
            return;
        }

        this._stack.set_visible_child_name('player');

        // Set metadata
        this._title.set_text(nowPlaying.title || 'Unknown');
        this._artist.set_text(nowPlaying.artist || nowPlaying.album || 'Unknown Artist');
        this._art.setPath(nowPlaying.art_path || null);

        // Transport button state
        const playing = Playback.isPlaying(nowPlaying);
        const playIcon = playing ? 'isle-pause-symbolic' : 'isle-play-symbolic';
        setButtonIcon(this._playButton, playIcon);

        this._syncProgress();
        if (playing) {
            this.later('progress', PROGRESS_REFRESH_MS, () => this._updateProgressLoop(), { keep: true });
        } else {
            this.cancel('progress');
        }
    }

    _updateProgressLoop() {
        const nowPlaying = this.daemon?.state?.nowPlaying;
        if (Playback.isPlaying(nowPlaying)) {
            this._syncProgress();
            this.later('progress', PROGRESS_REFRESH_MS, () => this._updateProgressLoop(), { keep: true });
        }
    }

    _syncProgress() {
        const nowPlaying = this.daemon?.state?.nowPlaying;
        if (!nowPlaying?.available) return;

        const posMs = Playback.positionMs(nowPlaying);
        const lenMs = Playback.lengthMs(nowPlaying);

        this._elapsed.set_text(Format.duration(posMs));
        if (lenMs > 0) {
            this._remaining.set_text(`−${Format.duration(Math.max(0, lenMs - posMs))}`);
            this._scrubber.value = Math.min(1, Math.max(0, posMs / lenMs));
        } else {
            this._remaining.set_text('');
            this._scrubber.value = 0;
        }
    }
});
