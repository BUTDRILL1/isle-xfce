// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Text formatting shared by the island's views.
// Ported for Isle XFCE GTK4 runtime.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let clockFormat = 'system';

export function release() {
    clockFormat = 'system';
}

export function setClockFormat(format) {
    clockFormat = format;
}

export function uses12Hour() {
    if (clockFormat === '24h' || clockFormat === '12h')
        return clockFormat === '12h';
    return false; // Standard 24h default on Linux / XFCE
}

export function clockParts(dateTime = GLib.DateTime.new_now_local(), twelveHour = uses12Hour()) {
    const time = dateTime.format(twelveHour ? '%l:%M' : '%H:%M').trim();
    const meridiem = twelveHour ? dateTime.format('%p').trim() : '';
    return { time, meridiem };
}

export function timeOfDay(dateTime) {
    return dateTime.format(uses12Hour() ? '%l:%M %p' : '%H:%M').trim();
}

export function duration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

export function hoursMinutes(ms) {
    if (ms < 60000)
        return ms > 0 ? '<1m' : '0m';
    const minutes = Math.round(ms / 60000);
    const hours = Math.floor(minutes / 60);
    if (!hours)
        return `${minutes}m`;
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export function phaseName(phase) {
    return {
        idle: 'Ready to focus',
        focus: 'Focus',
        short_break: 'Short break',
        long_break: 'Long break',
    }[phase] ?? phase;
}

export function nowMs() {
    return Math.floor(GLib.get_real_time() / 1000);
}

