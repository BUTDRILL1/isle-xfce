// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Dynamic Now Playing, Volume, and Lyrics page for Isle XFCE GTK4 runtime.
//! Supports collapsible tiles with dynamic spring height adaptation.

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

        this._showVolume = false;
        this._showLyrics = false;
        this._audioVolume = 0.5;
        this._audioMuted = false;
        this._lastLyricsKey = null;
        this._lyricLineWidgets = [];
        this._lastActiveLineIdx = -1;

        // Player tile widgets
        this._mainBox = null;
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

        // Volume tile widgets
        this._volumeRevealer = null;
        this._volumeSlider = null;
        this._volumeText = null;
        this._volumeMuteBtn = null;
        this._chipsBox = null;

        // Lyrics tile widgets
        this._lyricsRevealer = null;
        this._lyricsScroll = null;
        this._lyricsColumn = null;

        this._buildUi();

        this.watch(['nowPlaying', 'lyrics', 'players'], () => this._update());
        this._update();
        this._refreshAudio();
    }

    getDesiredHeight() {
        let h = 195;
        if (this._showVolume) h += 65;
        if (this._showLyrics) h += 135;
        return h;
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

        // 2. Dynamic content container with stacked tiles
        this._mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.START,
            css_classes: ['isle-media-container'],
        });

        // ── Tile 1: Music Player Tile (Top) ─────────────────────────────
        const playerTile = this._buildPlayerTile();
        this._mainBox.append(playerTile);

        // ── Tile 2: Volume & Output Tile (Middle) ───────────────────────
        this._volumeRevealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            transition_duration: 200,
            reveal_child: false,
        });
        const volumeTile = this._buildVolumeTile();
        this._volumeRevealer.set_child(volumeTile);
        this._mainBox.append(this._volumeRevealer);

        // ── Tile 3: Synced Lyrics Tile (Bottom) ─────────────────────────
        this._lyricsRevealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            transition_duration: 200,
            reveal_child: false,
        });
        const lyricsTile = this._buildLyricsTile();
        this._lyricsRevealer.set_child(lyricsTile);
        this._mainBox.append(this._lyricsRevealer);

        this._stack.add_named(this._mainBox, 'player');
        this.append(this._stack);
    }

    _buildPlayerTile() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 16,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            css_classes: ['isle-player'],
        });

        // Album Art (104x104)
        this._art = new Art({ size: ART_SIZE, radius: 16 });
        const click = new Gtk.GestureClick();
        click.connect('released', () => this.daemon.call('media', 'Raise'));
        this._art.add_controller(click);
        row.append(this._art);

        // Controls column
        const col = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ['isle-player-column'],
        });

        // Head: Title, Subtitle, Mode Buttons
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

        // Right mode toggle buttons
        const modes = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            css_classes: ['isle-player-modes'],
        });
        this._lyricsBtn = iconButton('isle-lyrics', 'isle-button-flat isle-mode-toggle', () => {
            this._toggleLyrics();
        }, {
            size: 16,
            accessibleName: 'Toggle lyrics',
        });
        this._outputBtn = iconButton('isle-output', 'isle-button-flat isle-mode-toggle', () => {
            this._toggleVolume();
        }, {
            size: 16,
            accessibleName: 'Toggle volume and output',
        });
        modes.append(this._lyricsBtn);
        modes.append(this._outputBtn);
        head.append(modes);
        col.append(head);

        // Progress row
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

    _buildVolumeTile() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            css_classes: ['isle-volume-tile'],
        });

        // Top row: Mute button, Volume slider, Volume percent text
        const topRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        this._volumeMuteBtn = iconButton('audio-volume-high-symbolic', 'isle-button-flat', () => {
            this._toggleAudioMute();
        }, { size: 16, accessibleName: 'Mute' });

        this._volumeSlider = new Slider({ scrollStep: 0.05 });
        this._volumeSlider.connect('value-changed', (_slider, val) => {
            this._setAudioVolume(val);
        });

        this._volumeText = label('50%', 'isle-volume-text');

        topRow.append(this._volumeMuteBtn);
        topRow.append(this._volumeSlider);
        topRow.append(this._volumeText);
        box.append(topRow);

        // Bottom row: Sinks chips selector
        this._chipsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        box.append(this._chipsBox);

        return box;
    }

    _buildLyricsTile() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            css_classes: ['isle-lyrics-tile'],
        });

        this._lyricsScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });

        this._lyricsColumn = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
            valign: Gtk.Align.START,
            css_classes: ['isle-lyrics-column'],
        });
        this._lyricsScroll.set_child(this._lyricsColumn);
        box.append(this._lyricsScroll);

        return box;
    }

    _toggleVolume() {
        this._showVolume = !this._showVolume;
        if (this._showVolume) {
            this._refreshAudio();
        }
        this._syncModeState();
    }

    _toggleLyrics() {
        this._showLyrics = !this._showLyrics;
        if (this._showLyrics) {
            this.daemon.call('media', 'SetLyrics', true);
        }
        this._syncModeState();
    }

    _syncModeState() {
        if (this._outputBtn) {
            if (this._showVolume) {
                this._outputBtn.add_css_class('on');
                setButtonIcon(this._outputBtn, 'isle-output-fill');
            } else {
                this._outputBtn.remove_css_class('on');
                setButtonIcon(this._outputBtn, 'isle-output');
            }
        }
        if (this._lyricsBtn) {
            if (this._showLyrics) {
                this._lyricsBtn.add_css_class('on');
                setButtonIcon(this._lyricsBtn, 'isle-lyrics-fill');
            } else {
                this._lyricsBtn.remove_css_class('on');
                setButtonIcon(this._lyricsBtn, 'isle-lyrics');
            }
        }

        this._volumeRevealer.set_reveal_child(this._showVolume);
        this._lyricsRevealer.set_reveal_child(this._showLyrics);

        this.emit('height-changed');
    }

    async _refreshAudio() {
        const stdout = await runAsync(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@']);
        const m = stdout.match(/Volume:\s+([0-9.]+)/);
        const isMuted = stdout.includes('[MUTED]');
        const vol = m ? parseFloat(m[1]) : 0.5;
        this._audioVolume = vol;
        this._audioMuted = isMuted;

        if (this._volumeSlider) this._volumeSlider.value = vol;
        if (this._volumeText) this._volumeText.set_text(`${Math.round(vol * 100)}%`);
        if (this._volumeMuteBtn) {
            const iconName = isMuted ? 'audio-volume-muted' : (vol > 0.5 ? 'audio-volume-high-symbolic' : 'audio-volume-medium-symbolic');
            setButtonIcon(this._volumeMuteBtn, iconName);
        }

        this._refreshAudioOutputs();
    }

    async _refreshAudioOutputs() {
        const stdout = await runAsync(['wpctl', 'status']);
        if (!stdout || !this._chipsBox) return;

        while (this._chipsBox.get_first_child()) {
            this._chipsBox.remove(this._chipsBox.get_first_child());
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
                    const shortName = name.replace(/^Ryzen HD Audio Controller\s*/i, '').trim();

                    const chip = new Gtk.Button({
                        css_classes: ['isle-output-chip', isDefault ? 'active' : 'idle'],
                    });
                    const chipRow = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 6,
                        valign: Gtk.Align.CENTER,
                    });
                    const iconName = name.toLowerCase().includes('headphone') ? 'isle-headphones-symbolic' : 'isle-speaker-device-symbolic';
                    chipRow.append(new Gtk.Image({ gicon: icon(iconName), pixel_size: 13 }));
                    chipRow.append(label(shortName || name, ''));
                    chip.set_child(chipRow);

                    chip.connect('clicked', () => {
                        runAsync(['wpctl', 'set-default', id]).then(() => {
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                                this._refreshAudio();
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                    });
                    this._chipsBox.append(chip);
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
        if (this._volumeText) this._volumeText.set_text(`${Math.round(val * 100)}%`);
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
        if (this._showLyrics) {
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
            if (this._showLyrics) {
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

        this._elapsed.set_text(Format.duration(posMs));
        if (lenMs > 0) {
            this._remaining.set_text(`−${Format.duration(Math.max(0, lenMs - posMs))}`);
            this._scrubber.value = Math.min(1, Math.max(0, posMs / lenMs));
        } else {
            this._remaining.set_text('');
            this._scrubber.value = 0;
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
                const img = new Gtk.Image({ gicon: icon(iconName), pixel_size: 20 });
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
                        adj.set_value(Math.max(0, alloc.y - 40));
                    }
                }
            }
        }
    }
});
