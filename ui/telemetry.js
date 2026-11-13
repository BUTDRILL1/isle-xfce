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

let _lastCpuSample = null;
let _cachedCpuPct = 0;

export function sampleCpuUsage() {
    try {
        const [ok, data] = GLib.file_get_contents('/proc/stat');
        if (!ok) return _cachedCpuPct;
        const firstLine = new TextDecoder().decode(data).split('\n')[0] || '';
        const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4) return _cachedCpuPct;

        const idle = parts[3] + (parts[4] || 0);
        const total = parts.reduce((acc, v) => acc + (isNaN(v) ? 0 : v), 0);

        if (_lastCpuSample) {
            const dTotal = total - _lastCpuSample.total;
            const dIdle = idle - _lastCpuSample.idle;
            if (dTotal > 0) {
                _cachedCpuPct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
            }
        }
        _lastCpuSample = { total, idle };
    } catch (_) {}
    return _cachedCpuPct;
}

export function getMemoryUsage() {
    try {
        const [ok, data] = GLib.file_get_contents('/proc/meminfo');
        if (!ok) return null;
        const text = new TextDecoder().decode(data);
        const totalMatch = text.match(/^MemTotal:\s+(\d+)\s+kB/m);
        const availMatch = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
        if (!totalMatch || !availMatch) return null;

        const totalKb = parseInt(totalMatch[1], 10);
        const availKb = parseInt(availMatch[1], 10);
        const usedKb = Math.max(0, totalKb - availKb);
        const totalGb = totalKb / (1024 * 1024);
        const usedGb = usedKb / (1024 * 1024);
        const pct = totalKb > 0 ? (usedKb / totalKb) * 100 : 0;
        return { usedGb, totalGb, pct };
    } catch (_) {
        return null;
    }
}

export function getCpuTemp() {
    try {
        const thermalDir = Gio.File.new_for_path('/sys/class/thermal');
        if (!thermalDir.query_exists(null)) return null;
        const iter = thermalDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let fallbackTemp = null;
        let info;
        while ((info = iter.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.startsWith('thermal_zone')) continue;
            const typePath = `/sys/class/thermal/${name}/type`;
            const tempPath = `/sys/class/thermal/${name}/temp`;
            try {
                const [okType, typeBytes] = GLib.file_get_contents(typePath);
                const [okTemp, tempBytes] = GLib.file_get_contents(tempPath);
                if (!okTemp) continue;
                const tempC = parseInt(new TextDecoder().decode(tempBytes).trim(), 10) / 1000;
                if (isNaN(tempC)) continue;
                const zoneType = okType ? new TextDecoder().decode(typeBytes).trim() : '';
                if (zoneType === 'x86_pkg_temp' || zoneType === 'k10temp' || zoneType === 'cpu-thermal') {
                    return Math.round(tempC);
                }
                if (fallbackTemp === null) fallbackTemp = Math.round(tempC);
            } catch (_) {}
        }
        return fallbackTemp;
    } catch (_) {
        return null;
    }
}

export function getDiskUsage() {
    try {
        const root = Gio.File.new_for_path('/');
        const info = root.query_filesystem_info('filesystem::size,filesystem::free', null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        if (!size) return null;
        const used = Math.max(0, size - free);
        const gib = 1024 * 1024 * 1024;
        return {
            usedGb: used / gib,
            totalGb: size / gib,
            freeGb: free / gib,
            pct: (used / size) * 100,
        };
    } catch (_) {
        return null;
    }
}

export function getPowerProfile() {
    // 1. Check powerprofilesctl if available
    if (GLib.find_program_in_path('powerprofilesctl')) {
        try {
            const [ok, stdout] = GLib.spawn_command_line_sync('powerprofilesctl get');
            if (ok && stdout) {
                const mode = new TextDecoder().decode(stdout).trim();
                if (mode) return mode;
            }
        } catch (_) {}
    }

    // 2. Fallback to Intel/AMD pstate energy_performance_preference
    try {
        const [ok, data] = GLib.file_get_contents('/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference');
        if (ok) {
            const epp = new TextDecoder().decode(data).trim();
            if (epp === 'power' || epp === 'balance_power') return 'power-saver';
            if (epp === 'performance') return 'performance';
            return 'balanced';
        }
    } catch (_) {}

    // 3. Fallback to scaling_governor
    try {
        const [ok, data] = GLib.file_get_contents('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor');
        if (ok) {
            const gov = new TextDecoder().decode(data).trim();
            if (gov === 'performance') return 'performance';
            if (gov === 'powersave') return 'power-saver';
        }
    } catch (_) {}

    return 'balanced';
}

export function setPowerProfile(profile, onDone = null) {
    if (GLib.find_program_in_path('powerprofilesctl')) {
        try {
            const proc = Gio.Subprocess.new(['powerprofilesctl', 'set', profile], Gio.SubprocessFlags.NONE);
            proc.wait_async(null, () => {
                if (onDone) onDone(getPowerProfile());
            });
            return;
        } catch (_) {}
    }

    const eppMap = {
        'power-saver': 'power',
        'balanced': 'balance_performance',
        'performance': 'performance',
    };
    const epp = eppMap[profile] || 'balance_performance';
    const cmd = `for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do echo ${epp} > "$f"; done`;
    try {
        const proc = Gio.Subprocess.new(['pkexec', 'sh', '-c', cmd], Gio.SubprocessFlags.NONE);
        proc.wait_async(null, () => {
            if (onDone) onDone(getPowerProfile());
        });
    } catch (_) {
        if (onDone) onDone(getPowerProfile());
    }
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
        sampleCpuUsage();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            sampleNetworkThroughput();
            sampleCpuUsage();
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
