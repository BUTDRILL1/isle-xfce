// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

//! Real-time telemetry monitoring for network throughput and battery runtime.
//! Reads /proc/net/dev and UPower D-Bus asynchronously/periodically.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export function getDefaultInterface() {
    try {
        const [ok, data] = GLib.file_get_contents('/proc/net/route');
        if (ok) {
            const text = new TextDecoder().decode(data);
            const lines = text.split('\n');
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].trim().split(/\s+/);
                if (parts.length >= 2 && parts[1] === '00000000') {
                    return parts[0];
                }
            }
        }
    } catch (e) {}
    return null;
}

export function readNetDev() {
    try {
        const [ok, data] = GLib.file_get_contents('/proc/net/dev');
        if (!ok) return {};
        const text = new TextDecoder().decode(data);
        const lines = text.split('\n');
        const stats = {};
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx === -1) continue;
            const iface = line.slice(0, idx).trim();
            const parts = line.slice(idx + 1).trim().split(/\s+/);
            if (parts.length >= 10) {
                const rxBytes = parseInt(parts[0], 10);
                const txBytes = parseInt(parts[8], 10);
                if (!isNaN(rxBytes) && !isNaN(txBytes)) {
                    stats[iface] = { rxBytes, txBytes };
                }
            }
        }
        return stats;
    } catch (e) {
        return {};
    }
}

export function getActiveInterface(stats) {
    const def = getDefaultInterface();
    if (def && stats[def]) return def;
    let best = null;
    let max = -1;
    for (const [iface, d] of Object.entries(stats)) {
        if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth')) continue;
        if (d.rxBytes + d.txBytes > max) {
            max = d.rxBytes + d.txBytes;
            best = iface;
        }
    }
    return best || 'wlo1';
}

export function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 50) return '0 KB/s';
    if (bytesPerSec >= 1048576) {
        return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
    }
    const kb = bytesPerSec / 1024;
    if (kb >= 10) {
        return `${Math.round(kb)} KB/s`;
    }
    return `${kb.toFixed(1)} KB/s`;
}

export function formatBatteryTime(seconds, isCharging) {
    if (!seconds || seconds <= 0) return null;
    const s = Math.round(seconds);
    const hours = Math.floor(s / 3600);
    const mins = Math.round((s % 3600) / 60);

    let timeStr = '';
    if (hours > 0 && mins > 0) {
        timeStr = `${hours}h ${mins}m`;
    } else if (hours > 0) {
        timeStr = `${hours}h`;
    } else if (mins > 0) {
        timeStr = `${mins}m`;
    } else {
        return null;
    }

    if (isCharging) {
        return `${timeStr} to full`;
    } else {
        return `${timeStr} remaining`;
    }
}

let _cachedBattery = {
    timeToEmpty: 0,
    timeToFull: 0,
    state: 0,
    percentage: 0,
    lastUpdateUs: 0,
};

export function queryUPower() {
    const nowUs = GLib.get_monotonic_time();
    if (_cachedBattery.lastUpdateUs > 0 && (nowUs - _cachedBattery.lastUpdateUs) < 1500000) {
        return _cachedBattery;
    }

    try {
        const bus = Gio.DBus.system;
        const res = bus.call_sync(
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.DBus.Properties',
            'GetAll',
            new GLib.Variant('(s)', ['org.freedesktop.UPower.Device']),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            500,
            null
        );
        const dict = res.deepUnpack()[0];
        _cachedBattery = {
            timeToEmpty: Number(dict['TimeToEmpty']?.unpack() || 0),
            timeToFull: Number(dict['TimeToFull']?.unpack() || 0),
            state: Number(dict['State']?.unpack() || 0),
            percentage: Number(dict['Percentage']?.unpack() || 0),
            lastUpdateUs: nowUs,
        };
    } catch (e) {
        _cachedBattery.lastUpdateUs = nowUs;
    }
    return _cachedBattery;
}

export function getBatteryTelemetry(daemonBattery) {
    const upower = queryUPower();
    const pct = Math.round(daemonBattery?.percent ?? upower.percentage ?? 0);
    if (!daemonBattery && !upower.percentage) return null;

    const isCharging = Boolean(daemonBattery?.charging || upower.state === 1);
    const isPlugged = Boolean(daemonBattery?.plugged || upower.state === 1 || upower.state === 4 || upower.state === 5);

    const timeToFull = daemonBattery?.time_to_full || upower.timeToFull;
    const timeToEmpty = daemonBattery?.time_to_empty || upower.timeToEmpty;

    let timeStr = null;
    if (isCharging && timeToFull > 0) {
        timeStr = formatBatteryTime(timeToFull, true);
    } else if (!isPlugged && timeToEmpty > 0) {
        timeStr = formatBatteryTime(timeToEmpty, false);
    }

    let statusDesc = '';
    if (isCharging) {
        statusDesc = timeStr ? `Charging · ${timeStr}` : 'Charging';
    } else if (isPlugged) {
        statusDesc = pct >= 99 ? 'Fully charged' : (timeStr ? `Plugged in · ${timeStr}` : 'AC Connected');
    } else {
        statusDesc = timeStr ? timeStr : 'Battery';
    }

    return {
        percent: pct,
        statusDesc,
        fullText: `${pct}% (${statusDesc})`,
        timeStr,
        isCharging,
        isPlugged,
    };
}

let _lastNetSample = null;
let _cachedThroughput = {
    iface: 'wlo1',
    rxBytesSec: 0,
    txBytesSec: 0,
    downSpeedStr: '0 KB/s',
    upSpeedStr: '0 KB/s',
    formatted: 'wlo1: ↓ 0 KB/s · ↑ 0 KB/s',
};

export function sampleNetworkThroughput() {
    const stats = readNetDev();
    const iface = getActiveInterface(stats);
    const nowUs = GLib.get_monotonic_time();

    if (!iface || !stats[iface]) {
        return _cachedThroughput;
    }

    const cur = stats[iface];
    if (_lastNetSample && _lastNetSample.iface === iface) {
        const dtSec = (nowUs - _lastNetSample.timeUs) / 1000000.0;
        if (dtSec >= 0.5) {
            const rxDelta = cur.rxBytes - _lastNetSample.rxBytes;
            const txDelta = cur.txBytes - _lastNetSample.txBytes;
            const rxSpeed = rxDelta >= 0 ? rxDelta / dtSec : 0;
            const txSpeed = txDelta >= 0 ? txDelta / dtSec : 0;

            const downSpeedStr = formatSpeed(rxSpeed);
            const upSpeedStr = formatSpeed(txSpeed);

            _cachedThroughput = {
                iface,
                rxBytesSec: rxSpeed,
                txBytesSec: txSpeed,
                downSpeedStr,
                upSpeedStr,
                formatted: `${iface}: ↓ ${downSpeedStr} · ↑ ${upSpeedStr}`,
            };

            _lastNetSample = {
                iface,
                rxBytes: cur.rxBytes,
                txBytes: cur.txBytes,
                timeUs: nowUs,
            };
        }
    } else {
        _lastNetSample = {
            iface,
            rxBytes: cur.rxBytes,
            txBytes: cur.txBytes,
            timeUs: nowUs,
        };
        _cachedThroughput = {
            iface,
            rxBytesSec: 0,
            txBytesSec: 0,
            downSpeedStr: '0 KB/s',
            upSpeedStr: '0 KB/s',
            formatted: `${iface}: ↓ 0 KB/s · ↑ 0 KB/s`,
        };
    }

    return _cachedThroughput;
}

export const TelemetryMonitor = GObject.registerClass({
    GTypeName: 'IsleTelemetryMonitorService',
    Signals: {
        'updated': {},
    },
}, class extends GObject.Object {
    _init() {
        super._init();
        sampleNetworkThroughput();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            sampleNetworkThroughput();
            this.emit('updated');
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }
});

let _serviceInstance = null;
export function getTelemetryMonitor() {
    if (!_serviceInstance) {
        _serviceInstance = new TelemetryMonitor();
    }
    return _serviceInstance;
}
