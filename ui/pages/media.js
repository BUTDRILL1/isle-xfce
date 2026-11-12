// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Now Playing, Lyrics, and Audio Outputs page for Isle XFCE GTK4 runtime.
//! Faithful port of upstream gnome-extension/src/pages/media.js.

import Gio from 'gi://Gio';
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

function runAsync(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        return new Promise(resolve => {
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    resolve(stdout?.trim() ?? '');
                } catch {
                    resolve('');
                }
            });
        });
    } catch {
        return Promise.resolve('');
    }
}

export const MediaPage = GObject.registerClass({
    GTypeName: 'IsleGtkMediaPage',
}, class MediaPage extends Page {
    _init(daemon, { height = 150 } = {}) {
        super._init(daemon, {
            name: 'music',
            height,
        });

        this._mode = 'player'; // 'player', 'lyrics', or 'audio'
        this._audioVolume = 0.5;
        this._audioMuted = false;
        this._lastLyricsKey = null;
        this._lyricLineWidgets = [];
        this._lastActiveLineIdx = -1;

        // Player view widgets
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
        this._lyricsBtn = null;
        this._outputBtn = null;

        // Audio view widgets
        this._audioBox = null;
        this._audioSlider = null;
        this._audioVolumeText = null;
        this._audioMuteBtn = null;
        this._outputList = null;

        // Lyrics view widgets
        this._lyricsBox = null;
        this._lyricsArt = null;
        this._lyricsTitle = null;
        this._lyricsArtist = null;
        this._lyricsElapsed = null;
        this._lyricsRemaining = null;
        this._lyricsScrubber = null;
        this._lyricsPlayBtn = null;
        this._lyricsScroll = null;
        this._lyricsColumn = null;

        this._buildUi();

        this.watch(['nowPlaying', 'lyrics', 'players'], () => this._update());
        this._update();
        this._refreshAudio();
    }

    _buildUi() {
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

        // 2. Standard Player view
        this._playerBox = this._buildPlayer();
        this._stack.add_named(this._playerBox, 'player');

        // 3. Audio & Volume view
        this._audioBox = this._buildAudio();
        this._stack.add_named(this._audioBox, 'audio');

        // 4. Synced Lyrics view
        this._lyricsBox = this._buildLyrics();
        this._stack.add_named(this._lyricsBox, 'lyrics');

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

        // Right mode icons (lyrics & volume/output)
        const modes = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            css_classes: ['isle-player-modes'],
        });
        this._lyricsBtn = iconButton('isle-lyrics', 'isle-button-flat isle-mode-toggle', () => {
            this._toggleMode('lyrics');
        }, {
            size: 16,
            accessibleName: 'Show lyrics',
        });
        this._outputBtn = iconButton('isle-output', 'isle-button-flat isle-mode-toggle', () => {
            this._toggleMode('audio');
        }, {
            size: 16,
            accessibleName: 'Volume and output',
        });
        modes.append(this._lyricsBtn);
        modes.append(this._outputBtn);
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

    _buildAudio() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            css_classes: ['isle-audio-layout'],
        });

        // Top volume row
        const volumeRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-volume-row'],
        });

        this._audioMuteBtn = iconButton('audio-volume-high-symbolic', 'isle-button-flat', () => {
            this._toggleAudioMute();
        }, { size: 18, accessibleName: 'Mute' });

        this._audioSlider = new Slider({ scrollStep: 0.05 });
        this._audioSlider.connect('value-changed', (_slider, val) => {
            this._setAudioVolume(val);
        });

        this._audioVolumeText = label('50%', 'isle-volume-text');

        const backBtn = iconButton('isle-output-fill', 'isle-button-flat isle-mode-toggle on', () => {
            this._toggleMode('audio');
        }, { size: 16, accessibleName: 'Back to player' });

        volumeRow.append(this._audioMuteBtn);
        volumeRow.append(this._audioSlider);
        volumeRow.append(this._audioVolumeText);
        volumeRow.append(backBtn);
        box.append(volumeRow);

        // Output sink list
        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });

        this._outputList = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            css_classes: ['isle-output-list'],
        });
        scroll.set_child(this._outputList);
        box.append(scroll);

        return box;
    }

    _buildLyrics() {
        const layout = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 20,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.FILL,
            css_classes: ['isle-lyrics-layout'],
        });

        // Left side: 64x64 art, title, artist, progress, controls, mode buttons
        const side = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-lyrics-side'],
        });
        side.set_size_request(220, -1);

        const top = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            css_classes: ['isle-player-top'],
        });
        this._lyricsArt = new Art({ size: 64, radius: 12 });
        top.append(this._lyricsArt);

        const texts = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-player-texts'],
        });
        this._lyricsTitle = label('', 'isle-side-title');
        this._lyricsTitle.set_ellipsize(Pango.EllipsizeMode.END);
        this._lyricsTitle.set_halign(Gtk.Align.START);
        this._lyricsArtist = label('', 'isle-side-artist');
        this._lyricsArtist.set_ellipsize(Pango.EllipsizeMode.END);
        this._lyricsArtist.set_halign(Gtk.Align.START);
        texts.append(this._lyricsTitle);
        texts.append(this._lyricsArtist);
        top.append(texts);
        side.append(top);

        // Progress row on lyrics side
        const progress = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            css_classes: ['isle-player-progress'],
        });
        this._lyricsElapsed = label('0:00', 'isle-time');
        this._lyricsRemaining = label('−0:00', 'isle-time isle-time-end');
        this._lyricsScrubber = new Slider();
        this._lyricsScrubber.connect('released', (_slider, fraction) => {
            const length = this.daemon.state.nowPlaying?.length_us ?? 0;
            if (length > 0)
                this.daemon.call('media', 'SetPosition', Math.round(fraction * length));
        });
        progress.append(this._lyricsElapsed);
        progress.append(this._lyricsScrubber);
        progress.append(this._lyricsRemaining);
        side.append(progress);

        // Controls row
        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-lyrics-controls'],
        });
        const lyricsBack = iconButton('isle-lyrics-fill', 'isle-button-flat isle-mode-toggle on', () => {
            this._toggleMode('lyrics');
        }, { size: 16, accessibleName: 'Hide lyrics' });

        const transport = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            halign: Gtk.Align.CENTER,
            css_classes: ['isle-transport'],
        });
        const prev = iconButton('isle-backward-symbolic', 'isle-button-flat', () => {
            this.daemon.call('media', 'Previous');
        }, { size: 16, accessibleName: 'Previous' });
        this._lyricsPlayBtn = iconButton('isle-play-symbolic', 'isle-button-flat isle-play', () => {
            this.daemon.call('media', 'PlayPause');
        }, { size: 18, accessibleName: 'Play or pause' });
        const next = iconButton('isle-forward-symbolic', 'isle-button-flat', () => {
            this.daemon.call('media', 'Next');
        }, { size: 16, accessibleName: 'Next' });
        transport.append(prev);
        transport.append(this._lyricsPlayBtn);
        transport.append(next);

        const audioFromLyrics = iconButton('isle-output', 'isle-button-flat isle-mode-toggle', () => {
            this._toggleMode('audio');
        }, { size: 16, accessibleName: 'Volume and output' });

        controls.append(lyricsBack);
        controls.append(transport);
        controls.append(audioFromLyrics);
        side.append(controls);
        layout.append(side);

        // Right side: Lyrics scroll view
        this._lyricsScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ['isle-lyrics-scroll'],
        });
        this._lyricsColumn = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            hexpand: true,
            valign: Gtk.Align.START,
            css_classes: ['isle-lyrics-column'],
        });
        this._lyricsScroll.set_child(this._lyricsColumn);
        layout.append(this._lyricsScroll);

        return layout;
    }

    _toggleMode(mode) {
        this._mode = this._mode === mode ? 'player' : mode;
        if (this._mode === 'audio') {
            this._refreshAudio();
        }
        if (this._mode === 'lyrics') {
            this.daemon.call('media', 'SetLyrics', true);
        }
        this._update();
    }

    async _refreshAudio() {
        const stdout = await runAsync(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@']);
        const m = stdout.match(/Volume:\s+([0-9.]+)/);
        const isMuted = stdout.includes('[MUTED]');
        const vol = m ? parseFloat(m[1]) : 0.5;
        this._audioVolume = vol;
        this._audioMuted = isMuted;

        if (this._audioSlider) this._audioSlider.value = vol;
        if (this._audioVolumeText) this._audioVolumeText.set_text(`${Math.round(vol * 100)}%`);
        if (this._audioMuteBtn) {
            const iconName = isMuted ? 'audio-volume-muted' : (vol > 0.5 ? 'audio-volume-high-symbolic' : 'audio-volume-medium-symbolic');
            setButtonIcon(this._audioMuteBtn, iconName);
        }

        this._refreshAudioOutputs();
    }

    async _refreshAudioOutputs() {
        const stdout = await runAsync(['wpctl', 'status']);
        if (!stdout || !this._outputList) return;

        while (this._outputList.get_first_child()) {
            this._outputList.remove(this._outputList.get_first_child());
        }

        const lines = stdout.split('\n');
        let inSinks = false;
        for (const line of lines) {
            if (line.includes('Sinks:')) {
                inSinks = true;
                continue;
            }
            if (inSinks && (line.includes('Sources:') || line.includes('Filters:') || line.includes('Streams:'))) {
                break;
            }
            if (inSinks) {
                const match = line.match(/([* ]?)\s*(\d+)\.\s+([^\[]+)/);
                if (match) {
                    const isDefault = match[1].includes('*');
                    const id = match[2];
                    const name = match[3].trim();

                    const btn = new Gtk.Button({
                        css_classes: ['isle-output-button', isDefault ? 'active' : 'idle'],
                        hexpand: true,
                    });
                    const row = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 10,
                        hexpand: true,
                        valign: Gtk.Align.CENTER,
                        css_classes: ['isle-output-row'],
                    });
                    const iconName = name.toLowerCase().includes('headphone') ? 'isle-headphones-symbolic' : 'isle-speaker-device-symbolic';
                    const devIcon = new Gtk.Image({
                        gicon: icon(iconName),
                        pixel_size: 16,
                    });
                    const devLbl = label(name, 'isle-output-name');
                    devLbl.set_hexpand(true);
                    devLbl.set_halign(Gtk.Align.START);
                    devLbl.set_ellipsize(Pango.EllipsizeMode.END);

                    row.append(devIcon);
                    row.append(devLbl);
                    if (isDefault) {
                        const checkImg = new Gtk.Image({
                            gicon: icon('isle-check-symbolic'),
                            pixel_size: 14,
                        });
                        row.append(checkImg);
                    }
                    btn.set_child(row);
                    btn.connect('clicked', () => {
                        runAsync(['wpctl', 'set-default', id]).then(() => {
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                                this._refreshAudio();
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                    });
                    this._outputList.append(btn);
                }
            }
        }
    }

    _toggleAudioMute() {
        runAsync(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']).then(() => {
            this._refreshAudio();
        });
    }

    _setAudioVolume(val) {
        this._audioVolume = val;
        if (this._audioVolumeText) this._audioVolumeText.set_text(`${Math.round(val * 100)}%`);
        runAsync(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', val.toFixed(2)]);
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

        // Switch to the active view mode
        this._stack.set_visible_child_name(this._mode);

        // Update standard Player view metadata
        this._title.set_text(nowPlaying.title || 'Unknown');
        this._artist.set_text(nowPlaying.artist || nowPlaying.album || 'Unknown Artist');
        this._art.setPath(nowPlaying.art_path || null);

        // Update Lyrics view metadata
        this._lyricsTitle.set_text(nowPlaying.title || 'Unknown');
        this._lyricsArtist.set_text(nowPlaying.artist || nowPlaying.album || 'Unknown Artist');
        this._lyricsArt.setPath(nowPlaying.art_path || null);

        // Update Play/Pause button icons
        const playing = Playback.isPlaying(nowPlaying);
        const playIcon = playing ? 'isle-pause-symbolic' : 'isle-play-symbolic';
        setButtonIcon(this._playButton, playIcon);
        setButtonIcon(this._lyricsPlayBtn, playIcon);

        this._syncProgress();
        if (this._mode === 'lyrics') {
            this._syncLyrics();
        }

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
            if (this._mode === 'lyrics') {
                this._syncLyrics();
            }
            this.later('progress', PROGRESS_REFRESH_MS, () => this._updateProgressLoop(), { keep: true });
        }
    }

    _syncProgress() {
        const nowPlaying = this.daemon?.state?.nowPlaying;
        if (!nowPlaying?.available) return;

        const posMs = Playback.positionMs(nowPlaying);
        const lenMs = Playback.lengthMs(nowPlaying);

        const elapsedStr = Format.duration(posMs);
        this._elapsed.set_text(elapsedStr);
        this._lyricsElapsed.set_text(elapsedStr);

        if (lenMs > 0) {
            const remStr = `−${Format.duration(Math.max(0, lenMs - posMs))}`;
            this._remaining.set_text(remStr);
            this._lyricsRemaining.set_text(remStr);
            const frac = Math.min(1, Math.max(0, posMs / lenMs));
            this._scrubber.value = frac;
            this._lyricsScrubber.value = frac;
        } else {
            this._remaining.set_text('');
            this._lyricsRemaining.set_text('');
            this._scrubber.value = 0;
            this._lyricsScrubber.value = 0;
        }
    }

    _syncLyrics() {
        const lyrics = this.daemon?.state?.lyrics;
        const nowPlaying = this.daemon?.state?.nowPlaying;
        if (!this._lyricsColumn) return;

        const trackKey = `${nowPlaying?.artist || ''}-${nowPlaying?.title || ''}`;
        if (this._lastLyricsKey !== trackKey) {
            this._lastLyricsKey = trackKey;
            this.daemon.call('media', 'SetLyrics', true);

            while (this._lyricsColumn.get_first_child()) {
                this._lyricsColumn.remove(this._lyricsColumn.get_first_child());
            }
            this._lyricLineWidgets = [];

            if (!lyrics || !lyrics.lines || lyrics.lines.length === 0) {
                const status = lyrics?.status || 'loading';
                const emptyBox = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 6,
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    vexpand: true,
                    hexpand: true,
                });
                const iconName = status === 'instrumental' ? 'isle-music' : 'isle-lyrics';
                const img = new Gtk.Image({ gicon: icon(iconName), pixel_size: 24 });
                const titleText = status === 'instrumental'
                    ? 'Instrumental'
                    : (status === 'loading' ? 'Looking for lyrics...' : 'No lyrics for this song');
                const titleLbl = label(titleText, 'isle-lyrics-state-title');
                emptyBox.append(img);
                emptyBox.append(titleLbl);
                this._lyricsColumn.append(emptyBox);
                return;
            }

            for (let i = 0; i < lyrics.lines.length; i++) {
                const line = lyrics.lines[i];
                const btn = new Gtk.Button({
                    css_classes: ['isle-lyric-button', 'isle-button-flat'],
                    hexpand: true,
                });
                const lbl = label(line.text || '♪', 'isle-lyric-line');
                lbl.set_wrap(true);
                lbl.set_halign(Gtk.Align.START);
                btn.set_child(lbl);
                if (line.time_ms >= 0) {
                    btn.connect('clicked', () => {
                        this.daemon.call('media', 'SetPosition', line.time_ms * 1000);
                    });
                }
                this._lyricsColumn.append(btn);
                this._lyricLineWidgets.push({ btn, lbl, timeMs: line.time_ms });
            }
        }

        if (this._lyricLineWidgets && this._lyricLineWidgets.length > 0) {
            const currentMs = Playback.positionMs(nowPlaying);
            let activeIdx = -1;
            for (let i = 0; i < this._lyricLineWidgets.length; i++) {
                if (this._lyricLineWidgets[i].timeMs <= currentMs) {
                    activeIdx = i;
                } else {
                    break;
                }
            }

            for (let i = 0; i < this._lyricLineWidgets.length; i++) {
                const w = this._lyricLineWidgets[i];
                if (i === activeIdx) {
                    w.btn.add_css_class('current');
                    w.lbl.set_opacity(1.0);
                } else if (i < activeIdx) {
                    w.btn.remove_css_class('current');
                    w.lbl.set_opacity(0.4);
                } else {
                    w.btn.remove_css_class('current');
                    w.lbl.set_opacity(0.7);
                }
            }

            if (activeIdx >= 0 && activeIdx !== this._lastActiveLineIdx) {
                this._lastActiveLineIdx = activeIdx;
                const activeWidget = this._lyricLineWidgets[activeIdx].btn;
                const adj = this._lyricsScroll.get_vadjustment();
                if (adj && activeWidget.get_parent()) {
                    const alloc = activeWidget.get_allocation();
                    if (alloc.y > 0) {
                        adj.set_value(Math.max(0, alloc.y - 80));
                    }
                }
            }
        }
    }
});
