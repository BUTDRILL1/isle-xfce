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

export function isAcPluggedIn() {
    try {
        const psDir = Gio.File.new_for_path('/sys/class/power_supply');
        if (!psDir.query_exists(null)) return false;
        const iter = psDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.startsWith('AC') && !name.startsWith('ADP')) continue;
            try {
                const [ok, data] = GLib.file_get_contents(`/sys/class/power_supply/${name}/online`);
                if (ok && new TextDecoder().decode(data).trim() === '1') {
                    return true;
                }
            } catch (_) {}
        }
    } catch (_) {}
    return false;
}

export function isLightningActive() {
    try {
        const [okGov, govData] = GLib.file_get_contents('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor');
        const gov = okGov ? new TextDecoder().decode(govData).trim() : '';
        if (gov !== 'performance') return false;

        // Also check GPU DPM if present
        const drmDir = Gio.File.new_for_path('/sys/class/drm');
        if (drmDir.query_exists(null)) {
            const iter = drmDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null)) !== null) {
                const name = info.get_name();
                if (!/^card\d+$/.test(name)) continue;
                const dpmPath = `/sys/class/drm/${name}/device/power_dpm_force_performance_level`;
                try {
                    const [okDpm, dpmData] = GLib.file_get_contents(dpmPath);
                    if (okDpm && new TextDecoder().decode(dpmData).trim() === 'high') {
                        return true;
                    }
                } catch (_) {}
            }
        }
        return true;
    } catch (_) {
        return false;
    }
}

export function getPowerProfile() {
    if (isLightningActive()) {
        return 'lightning';
    }

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

function _runArgvPrivileged(argv, requirePrompt, onComplete) {
    if (!requirePrompt) {
        try {
            const proc = Gio.Subprocess.new(['sudo', '-n', ...argv], Gio.SubprocessFlags.NONE);
            proc.wait_check_async(null, (_p, res) => {
                try {
                    if (proc.wait_check_finish(res)) {
                        if (onComplete) onComplete(true);
                        return;
                    }
                } catch (_) {}
                _runArgvPrivileged(argv, true, onComplete);
            });
            return;
        } catch (_) {}
    }

    try {
        const proc = Gio.Subprocess.new(['pkexec', ...argv], Gio.SubprocessFlags.NONE);
        proc.wait_check_async(null, (_p, res) => {
            let ok = false;
            try { ok = proc.wait_check_finish(res); } catch (_) {}
            if (onComplete) onComplete(ok);
        });
    } catch (_) {
        if (onComplete) onComplete(false);
    }
}

function isSaverExtraActive() {
    try {
        const [ok, data] = GLib.file_get_contents('/sys/devices/system/cpu/cpufreq/boost');
        return ok && new TextDecoder().decode(data).trim() === '0';
    } catch (_) {
        return false;
    }
}

function _notifyPowerChanged(profile, onDone) {
    if (_serviceInstance) {
        _serviceInstance.emit('power-changed');
    }
    if (onDone) onDone(profile);
}

export function setPowerProfile(profile, onDone = null) {
    const helper = GLib.file_test('/usr/local/bin/isle-lightning', GLib.FileTest.IS_EXECUTABLE)
        ? '/usr/local/bin/isle-lightning'
        : null;

    if (profile === 'lightning') {
        if (GLib.find_program_in_path('powerprofilesctl')) {
            try {
                Gio.Subprocess.new(['powerprofilesctl', 'set', 'performance'], Gio.SubprocessFlags.NONE);
            } catch (_) {}
        }
        const argv = helper
            ? [helper, 'on']
            : ['sh', '-c', 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > "$f"; done; echo 1 > /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || true; for g in /sys/class/drm/card*/device/power_dpm_force_performance_level; do echo high > "$g" 2>/dev/null || true; done'];
        // Require auth when unplugged on battery; allow passwordless when plugged in
        const requirePrompt = !isAcPluggedIn();
        _runArgvPrivileged(argv, requirePrompt, () => {
            _notifyPowerChanged(getPowerProfile(), onDone);
        });
        return;
    }

    if (profile === 'power-saver') {
        const applySaver = () => {
            if (helper) {
                _runArgvPrivileged([helper, 'saver'], false, () => {
                    _notifyPowerChanged(getPowerProfile(), onDone);
                });
            } else {
                _notifyPowerChanged(getPowerProfile(), onDone);
            }
        };
        _applyStandardProfile('power-saver', applySaver);
        return;
    }

    // Leaving lightning or super-saver: restore governor=powersave, boost=1, GPU DPM=auto
    if (isLightningActive() || isSaverExtraActive()) {
        const argv = helper
            ? [helper, 'off']
            : ['sh', '-c', 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo powersave > "$f"; done; echo 1 > /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || true; for g in /sys/class/drm/card*/device/power_dpm_force_performance_level; do echo auto > "$g" 2>/dev/null || true; done'];
        _runArgvPrivileged(argv, false, () => {
            _applyStandardProfile(profile, p => _notifyPowerChanged(p, onDone));
        });
        return;
    }

    _applyStandardProfile(profile, p => _notifyPowerChanged(p, onDone));
}

function _applyStandardProfile(profile, onDone) {
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
    _runArgvPrivileged(['sh', '-c', cmd], true, () => {
        if (onDone) onDone(getPowerProfile());
    });
}

let _cachedVolume = { percent: -1, muted: false };

export function getCachedVolume() {
    return _cachedVolume.percent >= 0 ? _cachedVolume : { percent: 100, muted: false };
}

export function getWifiSignal() {
    try {
        const [ok, data] = GLib.file_get_contents('/proc/net/wireless');
        if (!ok) return { connected: false, quality: 0, bars: 0 };
        const lines = new TextDecoder().decode(data).split('\n');
        for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const idx = line.indexOf(':');
            if (idx === -1) continue;
            const parts = line.slice(idx + 1).trim().split(/\s+/);
            const rawLink = parseFloat(parts[1]);
            if (isNaN(rawLink)) continue;
            const quality = Math.max(0, Math.min(100, Math.round((rawLink / 70) * 100)));
            const bars = quality >= 65 ? 3 : quality >= 35 ? 2 : quality > 0 ? 1 : 0;
            return { connected: quality > 0, quality, bars };
        }
    } catch (_) {}
    return { connected: false, quality: 0, bars: 0 };
}

function _parseWpctlVolume(stdout) {
    if (!stdout) return null;
    const m = stdout.match(/Volume:\s*([0-9.]+)/);
    if (!m) return null;
    const percent = Math.max(0, Math.round(parseFloat(m[1]) * 100));
    const muted = /\[MUTED\]/i.test(stdout);
    return { percent, muted };
}

function _refreshAudioVolumeAsync(onUpdated) {
    try {
        const proc = Gio.Subprocess.new(
            ['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        proc.communicate_utf8_async(null, null, (_p, res) => {
            try {
                const [, stdout] = proc.communicate_utf8_finish(res);
                const parsed = _parseWpctlVolume(stdout);
                if (parsed && (parsed.percent !== _cachedVolume.percent || parsed.muted !== _cachedVolume.muted)) {
                    _cachedVolume = parsed;
                    if (onUpdated) onUpdated(parsed);
                } else if (parsed && onUpdated) {
                    _cachedVolume = parsed;
                }
            } catch (_) {}
        });
    } catch (_) {}
}

export const TelemetryMonitor = GObject.registerClass({
    GTypeName: 'IsleTelemetryMonitorService',
    Signals: {
        'updated': {},
        'power-changed': {},
        'volume-changed': {},
    },
}, class extends GObject.Object {
    _init() {
        super._init();
        sampleNetworkThroughput();
        sampleCpuUsage();
        this._lastAcPlugged = isAcPluggedIn();
        // If already plugged in at startup and currently balanced, switch to performance
        if (this._lastAcPlugged && getPowerProfile() === 'balanced') {
            setPowerProfile('performance', () => this.emit('power-changed'));
        }

        // Initial audio volume fetch and real-time pactl subscribe listener
        this._pactlActive = false;
        this._pactlProc = null;
        _refreshAudioVolumeAsync(() => this.emit('volume-changed'));
        this._startPactlSubscribe();

        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            sampleNetworkThroughput();
            sampleCpuUsage();
            if (!this._pactlActive) {
                _refreshAudioVolumeAsync(() => this.emit('volume-changed'));
            }
            const ac = isAcPluggedIn();
            if (ac !== this._lastAcPlugged) {
                this._lastAcPlugged = ac;
                setPowerProfile(ac ? 'performance' : 'balanced', () => {
                    this.emit('power-changed');
                });
            }
            this.emit('updated');
            return GLib.SOURCE_CONTINUE;
        });
    }

    _startPactlSubscribe() {
        if (!GLib.find_program_in_path('pactl')) return;
        try {
            const proc = Gio.Subprocess.new(
                ['pactl', 'subscribe'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            this._pactlProc = proc;
            this._pactlActive = true;
            const stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
            const readNext = () => {
                stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
                    try {
                        const [lineBytes] = stream.read_line_finish(res);
                        if (lineBytes === null) {
                            this._pactlActive = false;
                            return;
                        }
                        const line = new TextDecoder().decode(lineBytes);
                        if (line.includes('sink') || line.includes('server')) {
                            _refreshAudioVolumeAsync(() => this.emit('volume-changed'));
                        }
                        readNext();
                    } catch (_) {
                        this._pactlActive = false;
                    }
                });
            };
            readNext();
        } catch (_) {
            this._pactlActive = false;
        }
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._pactlProc) {
            try { this._pactlProc.force_exit(); } catch (_) {}
            this._pactlProc = null;
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
