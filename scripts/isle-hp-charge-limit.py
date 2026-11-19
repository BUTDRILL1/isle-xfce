#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
"""Root daemon enforcing HP EC battery charge limits via /proc/acpi/call."""

import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time

ACPI_CALL_PATH = "/proc/acpi/call"
STATE_PATH = "/run/isle-charge-limit.json"
ACAD_ONLINE_PATH = "/sys/class/power_supply/ACAD/online"
BAT_CAPACITY_PATH = "/sys/class/power_supply/BAT0/capacity"
BAT_STATUS_PATH = "/sys/class/power_supply/BAT0/status"

ACPI_GBCO_QUERY = r"\_SB.WMID.GBCO"
ACPI_SBCO_INHIBIT = r"\_SB.WMID.SBCO 0 5 0 0"
ACPI_SBCO_NORMAL = r"\_SB.WMID.SBCO 0 0 0 0"

DEFAULT_ENABLED = True
DEFAULT_LIMIT = 70
MIN_LIMIT = 40
MAX_LIMIT = 95
HYSTERESIS = 5
POLL_INTERVAL_SEC = 1.5
MIN_WRITE_COOLDOWN_SEC = 10.0
RESUME_WALL_JUMP_SEC = 10.0
MAX_CONFIG_BYTES = 32768
GBCO_INHIBITED_CODE = 0x04

_GBCO_RE = re.compile(r"\{0x([0-9a-fA-F]+)")
_ALLOWED_CALLS = frozenset((ACPI_GBCO_QUERY, ACPI_SBCO_INHIBIT, ACPI_SBCO_NORMAL))


def parse_gbco_code(raw):
    """Return the first status byte from a GBCO ACPI output string, or None."""
    if not raw:
        return None
    m = _GBCO_RE.search(raw)
    if not m:
        return None
    try:
        return int(m.group(1), 16)
    except ValueError:
        return None


def read_sysfs_text(path, default=""):
    """Read a trimmed sysfs attribute string, returning default on error."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return default


def read_sysfs_int(path, default=None):
    """Read an integer sysfs attribute, returning default on error."""
    raw = read_sysfs_text(path, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def read_config(path, fallback=(DEFAULT_ENABLED, DEFAULT_LIMIT)):
    """Safely read chargeLimitEnabled and chargeLimitPercent from settings.json.

    Rejects symlinks and oversized files. Falls back to previous valid values on error.
    Returns (enabled, limit, file_sig).
    """
    try:
        if os.path.islink(path):
            return fallback[0], fallback[1], None
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_CONFIG_BYTES:
                return fallback[0], fallback[1], None
            with os.fdopen(fd, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        if not isinstance(data, dict):
            return fallback[0], fallback[1], None
        enabled = bool(data.get("chargeLimitEnabled", DEFAULT_ENABLED))
        raw_limit = data.get("chargeLimitPercent", DEFAULT_LIMIT)
        try:
            limit_val = int(round(float(raw_limit)))
        except (TypeError, ValueError):
            limit_val = fallback[1]
        limit = max(MIN_LIMIT, min(MAX_LIMIT, limit_val))
        sig = (st.st_mtime_ns, st.st_ino, st.st_size)
        return enabled, limit, sig
    except FileNotFoundError:
        return fallback[0], fallback[1], None
    except Exception:
        return fallback[0], fallback[1], None


def ensure_acpi_call():
    """Load the acpi_call kernel module if /proc/acpi/call is not yet present."""
    if os.path.exists(ACPI_CALL_PATH):
        return True
    try:
        subprocess.run(
            ["modprobe", "acpi_call"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"[isle-hp-charge-limit] failed to load acpi_call: {exc}", file=sys.stderr)
        return False
    return os.path.exists(ACPI_CALL_PATH)


def write_state_atomic(state, path=STATE_PATH):
    """Atomically write public state JSON (0644) for diagnostics and UI queries."""
    tmp_path = f"{path}.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
            fh.write("\n")
        os.chmod(tmp_path, 0o644)
        os.replace(tmp_path, path)
    except OSError as exc:
        print(f"[isle-hp-charge-limit] warning: could not write {path}: {exc}", file=sys.stderr)
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


class AcpiHardware:
    """Thin hardware wrapper issuing only the three fixed WMID charge-control calls."""

    def call(self, method_str):
        if method_str not in _ALLOWED_CALLS:
            raise ValueError(f"Disallowed ACPI call: {method_str!r}")
        with open(ACPI_CALL_PATH, "w", encoding="utf-8") as fh:
            fh.write(method_str + "\n")
        with open(ACPI_CALL_PATH, "r", encoding="utf-8") as fh:
            return fh.read().replace("\x00", "").strip()

    def query_gbco(self):
        return parse_gbco_code(self.call(ACPI_GBCO_QUERY))

    def set_inhibit(self, enable):
        cmd = ACPI_SBCO_INHIBIT if enable else ACPI_SBCO_NORMAL
        self.call(cmd)
        if enable:
            return self.query_gbco() == GBCO_INHIBITED_CODE
        return False

    def read_power(self):
        ac = read_sysfs_int(ACAD_ONLINE_PATH, 0)
        cap = read_sysfs_int(BAT_CAPACITY_PATH, None)
        status = read_sysfs_text(BAT_STATUS_PATH, "")
        return ac, cap, status


class ChargeLimitController:
    """Stateful hysteresis controller deciding when to engage or release EC inhibit."""

    def __init__(self, hw):
        self.hw = hw
        self.inhibited = False
        self.prev_ac = None
        self.prev_limit = DEFAULT_LIMIT
        self.prev_enabled = None
        self.prev_sig = object()
        self._last_write_mono = -MIN_WRITE_COOLDOWN_SEC

    def _engage_inhibit(self, now_mono):
        if self.hw.query_gbco() == GBCO_INHIBITED_CODE:
            self.inhibited = True
            self._last_write_mono = now_mono
            return
        verified = self.hw.set_inhibit(True)
        self.inhibited = bool(verified)
        self._last_write_mono = now_mono
        print(f"[isle-hp-charge-limit] engaged inhibit -> verified={self.inhibited}", flush=True)

    def _release_inhibit(self, now_mono):
        if self.hw.query_gbco() != GBCO_INHIBITED_CODE:
            self.inhibited = False
            self._last_write_mono = now_mono
            return
        self.hw.set_inhibit(False)
        self.inhibited = False
        self._last_write_mono = now_mono
        print("[isle-hp-charge-limit] released inhibit", flush=True)

    def step(self, enabled, limit, cfg_sig, ac, capacity, bat_status, resumed=False, now_mono=None):
        """Evaluate one control cycle and update EC inhibit state if needed."""
        if now_mono is None:
            now_mono = time.monotonic()

        sig_changed = cfg_sig is not None and cfg_sig != self.prev_sig
        enabled_changed = self.prev_enabled is not None and enabled != self.prev_enabled
        limit_changed = limit != self.prev_limit
        limit_increased = limit > self.prev_limit
        config_changed = sig_changed or enabled_changed or limit_changed
        ac_plugged = self.prev_ac == 0 and ac == 1
        cooldown_ok = (now_mono - self._last_write_mono) >= MIN_WRITE_COOLDOWN_SEC

        if not enabled:
            if ac == 1:
                if (
                    self.inhibited
                    or enabled_changed
                    or resumed
                    or ac_plugged
                    or (cooldown_ok and bat_status == "Not charging")
                ):
                    self._release_inhibit(now_mono)
            else:
                self.inhibited = False
        elif ac == 0:
            # Never issue EC WMI writes while running on battery; EC resets on replug anyway.
            self.inhibited = False
        elif ac == 1 and capacity is not None:
            resume_floor = max(20, limit - HYSTERESIS)
            if capacity >= limit:
                if (
                    not self.inhibited
                    or resumed
                    or ac_plugged
                    or config_changed
                    or (cooldown_ok and bat_status == "Charging")
                ):
                    self._engage_inhibit(now_mono)
            elif capacity <= resume_floor or (limit_increased and capacity < limit):
                if (
                    self.inhibited
                    or limit_increased
                    or resumed
                    or ac_plugged
                    or (cooldown_ok and bat_status == "Not charging")
                ):
                    self._release_inhibit(now_mono)
            else:
                # Within the hysteresis band (limit - 5 < capacity < limit):
                # keep current inhibit state across normal ticks, re-apply on wake.
                if resumed and self.inhibited:
                    self._engage_inhibit(now_mono)

        self.prev_ac = ac
        self.prev_limit = limit
        self.prev_enabled = enabled
        if cfg_sig is not None:
            self.prev_sig = cfg_sig

        return {
            "enabled": enabled,
            "limitPercent": limit,
            "acOnline": bool(ac == 1),
            "capacity": capacity,
            "batteryStatus": bat_status,
            "inhibited": self.inhibited,
            "updatedAt": int(time.time()),
        }


def run_daemon(config_path):
    """Run the 1.5s polling loop until SIGTERM/SIGINT, restoring charging on exit."""
    if not ensure_acpi_call():
        return 1

    hw = AcpiHardware()
    ctrl = ChargeLimitController(hw)
    running = True

    def _stop(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    fallback = (DEFAULT_ENABLED, DEFAULT_LIMIT)
    last_wall = time.time()
    last_snapshot = None

    try:
        while running:
            wall_now = time.time()
            resumed = (wall_now - last_wall) > RESUME_WALL_JUMP_SEC
            last_wall = wall_now

            enabled, limit, cfg_sig = read_config(config_path, fallback=fallback)
            fallback = (enabled, limit)
            ac, capacity, bat_status = hw.read_power()

            state = ctrl.step(enabled, limit, cfg_sig, ac, capacity, bat_status, resumed=resumed)
            snapshot = (
                state["enabled"],
                state["limitPercent"],
                state["acOnline"],
                state["capacity"],
                state["batteryStatus"],
                state["inhibited"],
            )
            if snapshot != last_snapshot:
                write_state_atomic(state)
                last_snapshot = snapshot

            # Interruptible 1.5s wait
            deadline = time.monotonic() + POLL_INTERVAL_SEC
            while running and time.monotonic() < deadline:
                time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
    finally:
        try:
            ac, capacity, bat_status = hw.read_power()
            if (ac == 1 or ctrl.inhibited) and hw.query_gbco() == GBCO_INHIBITED_CODE:
                hw.set_inhibit(False)
            write_state_atomic({
                "enabled": False,
                "limitPercent": fallback[1],
                "acOnline": bool(ac == 1),
                "capacity": capacity,
                "batteryStatus": bat_status,
                "inhibited": False,
                "stopped": True,
                "updatedAt": int(time.time()),
            })
        except Exception as exc:
            print(f"[isle-hp-charge-limit] cleanup warning: {exc}", file=sys.stderr)

    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Isle HP Battery Charge Limit daemon")
    parser.add_argument("--config", help="Path to user Isle settings.json")
    parser.add_argument("--status", action="store_true", help="Print live status JSON and exit")
    args = parser.parse_args(argv)

    if args.status:
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as fh:
                sys.stdout.write(fh.read())
            return 0
        except OSError as exc:
            print(json.dumps({"running": False, "error": str(exc)}))
            return 1

    if not args.config:
        parser.error("--config is required in daemon mode")

    return run_daemon(args.config)


if __name__ == "__main__":
    sys.exit(main())
