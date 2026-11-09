// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Helpers for the daemon's `NowPlaying` and `Lyrics` state.
// Ported for Isle XFCE GTK4 runtime.

import GioUnix from 'gi://GioUnix';
import { nowMs } from './format.js';

export function isPlaying(nowPlaying) {
    return Boolean(nowPlaying?.available && nowPlaying.status === 'Playing');
}

export function hasTrack(nowPlaying) {
    return Boolean(nowPlaying?.available && Boolean(nowPlaying.title));
}

export function showsClosed(nowPlaying) {
    return hasTrack(nowPlaying) && !nowPlaying.resting;
}

function rateOf(nowPlaying) {
    return nowPlaying.rate ?? 1;
}

export function positionMs(nowPlaying) {
    if (!nowPlaying?.available)
        return 0;
    let position = nowPlaying.position_us / 1000;
    if (nowPlaying.status === 'Playing')
        position += (nowMs() - nowPlaying.sampled_at_ms) * rateOf(nowPlaying);
    const length = nowPlaying.length_us / 1000;
    return length > 0 ? Math.min(Math.max(position, 0), length) : Math.max(position, 0);
}

export function lengthMs(nowPlaying) {
    return (nowPlaying?.length_us ?? 0) / 1000;
}

const playerApps = new Map();
const MAX_PLAYER_APPS = 20;

export function playerApp({ desktop_entry: entry, identity }) {
    const key = `${entry}|${identity}`;
    if (!playerApps.has(key)) {
        let app = null;
        if (entry) {
            try {
                app = GioUnix.DesktopAppInfo.new(`${entry}.desktop`);
            } catch (_) {}
        }
        if (!app && identity) {
            try {
                const results = GioUnix.DesktopAppInfo.search(identity);
                if (results && results.length > 0 && results[0].length > 0) {
                    app = GioUnix.DesktopAppInfo.new(results[0][0]);
                }
            } catch (_) {}
        }
        if (playerApps.size >= MAX_PLAYER_APPS)
            playerApps.delete(playerApps.keys().next().value);
        playerApps.set(key, app);
    }
    return playerApps.get(key);
}

