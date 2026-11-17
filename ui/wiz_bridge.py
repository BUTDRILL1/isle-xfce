#!/usr/bin/env python3
"""Self-contained stdin/stdout JSON bridge for WiZ bulb discovery, Static, Music Sync, and Screen Shading."""

import atexit
import collections
import colorsys
import ctypes
import json
import os
import random
import select
import signal
import socket
import subprocess
import sys
import threading
import time

WIZ_PORT = 38899
BUFFER_SIZE = 512
SAMPLE_RATE = 48000
FRAME_BYTES = BUFFER_SIZE * 4  # float32 mono

MUSIC_THEMES = {
    "rainbow": {"mode": "cycle"},
    "club": {
        "mode": "bass_strobe",
        "palette": [
            (255, 0, 40), (255, 0, 130), (150, 0, 255), (0, 100, 255),
            (0, 220, 255), (0, 255, 100), (255, 200, 0), (255, 255, 255),
        ],
    },
    "fire": {"mode": "flicker", "palette": [(255, 60, 0), (255, 150, 0), (255, 220, 80)]},
    "ocean": {"mode": "wave", "palette": [(0, 80, 180), (0, 200, 200), (220, 255, 255)]},
    "sesh": {
        "mode": "flow",
        "palette": [
            (110, 20, 220), (20, 70, 240), (0, 210, 210),
            (20, 190, 80), (245, 140, 30), (230, 40, 90),
        ],
    },
}


class XImage(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
        ("format", ctypes.c_int), ("data", ctypes.POINTER(ctypes.c_ubyte)),
        ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int),
        ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int),
        ("bits_per_pixel", ctypes.c_int), ("red_mask", ctypes.c_ulong), ("green_mask", ctypes.c_ulong),
        ("blue_mask", ctypes.c_ulong), ("obdata", ctypes.c_void_p),
    ]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def udp_rpc(ip, method, params=None, timeout=0.8, broadcast=False):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if broadcast:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(timeout)
    payload = json.dumps({"method": method, "params": params or {}}).encode("utf-8")
    try:
        sock.sendto(payload, (ip, WIZ_PORT))
        results = []
        while True:
            try:
                data, addr = sock.recvfrom(4096)
                parsed = json.loads(data.decode("utf-8"))
                results.append((addr[0], parsed.get("result") or {}))
                if not broadcast:
                    break
            except socket.timeout:
                break
        return results
    finally:
        sock.close()


class MusicSyncEngine:
    """Self-contained PipeWire audio-reactive WiZ sync engine with strict silence gating."""

    def __init__(self, bulb_ip, theme="rainbow", source="system", brightness=80, fps=20):
        self.bulb_ip = bulb_ip
        self.theme = theme if theme in MUSIC_THEMES else "rainbow"
        self.source = source if source in ("system", "mic") else "system"
        self.brightness = max(10, min(100, int(brightness)))
        self.interval = 1.0 / max(1, fps)
        self.running = False
        self.thread = None
        self.sock = None

        self.hue = 0.0
        self.bass_smooth = 0.0
        self.mid_smooth = 0.0
        self.high_smooth = 0.0
        self.current_volume = 0.0
        self.beat_history = collections.deque(maxlen=43)
        self.last_beat_time = 0.0
        self.club_idx = 0
        self.fire_last = 0.0
        self.fire_rgb = (255, 100, 0)
        self.sesh_idx = 0
        self.wave_phase = 0.0
        self.last_rgb = (255, 160, 80)
        self.last_sent = None

    def start(self):
        if self.running:
            return
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.2)
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

    def set_theme(self, theme):
        if theme in MUSIC_THEMES:
            self.theme = theme
            self.last_sent = None

    def set_brightness(self, brightness):
        self.brightness = max(10, min(100, int(brightness)))

    def set_interval(self, interval):
        self.interval = max(0.015, min(0.5, float(interval)))

    def _send_rgb(self, r, g, b, dimming):
        pkt = (int(r), int(g), int(b), max(10, min(100, int(dimming))))
        if pkt == self.last_sent:
            return
        self.last_sent = pkt
        payload = json.dumps({
            "method": "setPilot",
            "params": {"r": pkt[0], "g": pkt[1], "b": pkt[2], "dimming": pkt[3]},
        }).encode("utf-8")
        try:
            self.sock.sendto(payload, (self.bulb_ip, WIZ_PORT))
        except Exception:
            pass

    def _compute_bands(self, np, samples):
        if samples.size == 0 or float(np.max(np.abs(samples))) < 1e-5:
            return 0.0, 0.0, 0.0
        fft_mag = np.abs(np.fft.rfft(samples))
        freqs = np.fft.rfftfreq(len(samples), 1.0 / SAMPLE_RATE)
        bass = float(fft_mag[(freqs >= 20) & (freqs < 250)].mean()) if fft_mag.size else 0.0
        mid = float(fft_mag[(freqs >= 250) & (freqs < 2000)].mean()) if fft_mag.size else 0.0
        high = float(fft_mag[(freqs >= 2000) & (freqs < 8000)].mean()) if fft_mag.size else 0.0
        total = bass + mid + high + 1e-9
        return bass / total, mid / total, high / total

    def _detect_beat(self, bass, rms):
        if len(self.beat_history) < 10:
            self.beat_history.append(bass)
            return False
        avg = sum(self.beat_history) / len(self.beat_history)
        var = sum((x - avg) ** 2 for x in self.beat_history) / len(self.beat_history)
        thresh = -0.0025714 * var + 1.5142857
        self.beat_history.append(bass)
        if rms < 0.012:
            return False
        now = time.perf_counter()
        if bass > avg * thresh and (now - self.last_beat_time) > 0.15:
            self.last_beat_time = now
            return True
        return False

    def _render_frame(self, is_beat):
        cfg = MUSIC_THEMES.get(self.theme, MUSIC_THEMES["rainbow"])
        mode = cfg["mode"]
        palette = cfg.get("palette")
        min_b = max(10, int(self.brightness * 0.25))
        max_b = self.brightness

        if mode == "cycle":
            self.hue = (self.hue + 0.012 + self.high_smooth * 0.05) % 1.0
            r, g, b = [int(c * 255) for c in colorsys.hsv_to_rgb(self.hue, 1.0, 1.0)]
            dim = min_b + self.current_volume * (max_b - min_b)
        elif mode == "bass_strobe":
            if is_beat:
                self.club_idx = (self.club_idx + 1) % len(palette)
            r, g, b = palette[self.club_idx]
            dim = min_b + self.bass_smooth * (max_b - min_b)
            if is_beat:
                dim = min(max_b, dim * 1.25)
        elif mode == "flicker":
            now = time.perf_counter()
            if now - self.fire_last > 0.09:
                base = random.choice(palette)
                f = random.uniform(0.65, 1.0)
                self.fire_rgb = tuple(int(c * f) for c in base)
                self.fire_last = now
            r, g, b = self.fire_rgb
            dim = min_b + (0.45 + self.bass_smooth * 0.55) * (max_b - min_b)
        elif mode == "wave":
            self.wave_phase = (self.wave_phase + 0.02 + self.mid_smooth * 0.05) % 1.0
            i0 = int(self.wave_phase * len(palette)) % len(palette)
            i1 = (i0 + 1) % len(palette)
            frac = (self.wave_phase * len(palette)) % 1.0
            r = int(palette[i0][0] * (1 - frac) + palette[i1][0] * frac)
            g = int(palette[i0][1] * (1 - frac) + palette[i1][1] * frac)
            b = int(palette[i0][2] * (1 - frac) + palette[i1][2] * frac)
            dim = min_b + (0.3 + self.current_volume * 0.7) * (max_b - min_b)
        else:
            if is_beat:
                self.sesh_idx = (self.sesh_idx + 1) % len(palette)
            r, g, b = palette[self.sesh_idx]
            dim = min_b + self.current_volume * (max_b - min_b)

        self.last_rgb = (r, g, b)
        self._send_rgb(r, g, b, dim)

    def _resolve_device(self):
        if self.source == "mic":
            return "@DEFAULT_SOURCE@"
        try:
            sink = subprocess.check_output(["pactl", "get-default-sink"], text=True, timeout=0.8).strip()
            if sink:
                return f"{sink}.monitor"
        except Exception:
            pass
        return "@DEFAULT_MONITOR@"

    def _spawn_parec(self, device):
        return subprocess.Popen(
            [
                "parec",
                "--latency-msec=12",
                f"--format=float32le",
                f"--rate={SAMPLE_RATE}",
                "--channels=1",
                "-d",
                device,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def _terminate_proc(self, proc):
        if proc is None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=0.4)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def _run(self):
        import numpy as np  # Lazy import to save RAM when idle/static

        device = self._resolve_device()
        proc = None
        last_device_check = time.perf_counter()
        last_send = 0.0
        silent_frames = 0
        held_silence = False
        buf = bytearray()

        try:
            proc = self._spawn_parec(device)
            while self.running and proc.poll() is None:
                # Poll stdout with short timeout so stop() responds immediately
                rlist, _, _ = select.select([proc.stdout.fileno()], [], [], 0.1)
                if not rlist:
                    now = time.perf_counter()
                    if now - last_device_check >= 2.0 and self.source == "system":
                        last_device_check = now
                        new_dev = self._resolve_device()
                        if new_dev != device:
                            self._terminate_proc(proc)
                            device = new_dev
                            buf.clear()
                            proc = self._spawn_parec(device)
                    continue

                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                buf.extend(chunk)

                # Keep only the most recent frames to prevent pipe queue backlog
                if len(buf) > FRAME_BYTES * 3:
                    del buf[: len(buf) - FRAME_BYTES]

                while len(buf) >= FRAME_BYTES and self.running:
                    raw = bytes(buf[:FRAME_BYTES])
                    del buf[:FRAME_BYTES]

                    samples = np.frombuffer(raw, dtype=np.float32)
                    rms = float(np.sqrt(np.mean(samples ** 2)))
                    now = time.perf_counter()

                    if rms < 0.006:
                        silent_frames += 1
                        self.current_volume *= 0.82
                        self.bass_smooth *= 0.8
                        self.mid_smooth *= 0.8
                        self.high_smooth *= 0.8
                        if silent_frames > 15:
                            if not held_silence:
                                held_silence = True
                                min_b = max(10, int(self.brightness * 0.25))
                                self._send_rgb(self.last_rgb[0], self.last_rgb[1], self.last_rgb[2], min_b)
                            continue
                    else:
                        silent_frames = 0
                        held_silence = False

                    bass, mid, high = self._compute_bands(np, samples)
                    self.bass_smooth += 0.5 * (bass - self.bass_smooth)
                    self.mid_smooth += 0.35 * (mid - self.mid_smooth)
                    self.high_smooth += 0.45 * (high - self.high_smooth)
                    is_beat = self._detect_beat(bass, rms)
                    target_vol = min(1.0, rms * 9.0)
                    self.current_volume += 0.5 * (target_vol - self.current_volume)

                    due = (now - last_send) >= self.interval
                    beat_due = is_beat and (now - last_send) >= max(0.016, self.interval * 0.5)
                    if due or beat_due:
                        self._render_frame(is_beat)
                        last_send = now

                now = time.perf_counter()
                if now - last_device_check >= 2.0 and self.source == "system":
                    last_device_check = now
                    new_dev = self._resolve_device()
                    if new_dev != device:
                        self._terminate_proc(proc)
                        device = new_dev
                        buf.clear()
                        proc = self._spawn_parec(device)
        except Exception as exc:
            emit({"type": "error", "message": f"Music sync error: {exc}"})
        finally:
            self._terminate_proc(proc)


class ScreenSyncEngine:
    """Self-contained X11 XGetImage screen shading WiZ sync engine."""

    def __init__(self, bulb_ip, region="full_screen", brightness=80, fps=20):
        self.bulb_ip = bulb_ip
        self.region = region
        self.brightness = max(10, min(100, int(brightness)))
        self.interval = 1.0 / max(1, fps)
        self.running = False
        self.thread = None
        self.sock = None
        self.smooth_rgb = None
        self.last_sent = None

    def start(self):
        if self.running:
            return
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.0)
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

    def set_region(self, region):
        self.region = region
        self.smooth_rgb = None

    def set_brightness(self, brightness):
        self.brightness = max(10, min(100, int(brightness)))

    def set_interval(self, interval):
        self.interval = max(0.015, min(0.5, float(interval)))

    def _region_rect(self, sw, sh):
        if self.region == "top_center":
            return sw // 4, 0, sw // 2, sh // 3
        if self.region == "mid_left":
            return 0, sh // 4, sw // 3, sh // 2
        if self.region == "mid_right":
            return (sw * 2) // 3, sh // 4, sw // 3, sh // 2
        return 0, 0, sw, sh

    def _run(self):
        import numpy as np  # Lazy import to save RAM when idle/static

        x11 = ctypes.CDLL("libX11.so.6")
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XGetImage.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
            ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int,
        ]
        x11.XGetImage.restype = ctypes.POINTER(XImage)
        x11.XDestroyImage.argtypes = [ctypes.POINTER(XImage)]

        dpy = x11.XOpenDisplay(None)
        if not dpy:
            emit({"type": "error", "message": "Cannot open X11 display"})
            return
        try:
            root = x11.XDefaultRootWindow(dpy)
            sw = x11.XDisplayWidth(dpy, 0)
            sh = x11.XDisplayHeight(dpy, 0)
            while self.running:
                t0 = time.perf_counter()
                rx, ry, rw, rh = self._region_rect(sw, sh)
                img = x11.XGetImage(dpy, root, rx, ry, rw, rh, 0xFFFFFFFF, 2)
                if img:
                    try:
                        arr = np.ctypeslib.as_array(img.contents.data, shape=(rh, rw, 4))
                        bgr = arr[::8, ::8, :3].mean(axis=(0, 1))
                        r, g, b = float(bgr[2]) / 255.0, float(bgr[1]) / 255.0, float(bgr[0]) / 255.0
                    finally:
                        x11.XDestroyImage(img)

                    h, s, v = colorsys.rgb_to_hsv(r, g, b)
                    s = min(1.0, s * 1.45)
                    v = max(0.15, v)
                    nr, ng, nb = [int(c * 255) for c in colorsys.hsv_to_rgb(h, s, v)]
                    if self.smooth_rgb is None:
                        self.smooth_rgb = (nr, ng, nb)
                    else:
                        a = 0.45
                        self.smooth_rgb = (
                            int(self.smooth_rgb[0] + a * (nr - self.smooth_rgb[0])),
                            int(self.smooth_rgb[1] + a * (ng - self.smooth_rgb[1])),
                            int(self.smooth_rgb[2] + a * (nb - self.smooth_rgb[2])),
                        )
                    pkt = (self.smooth_rgb[0], self.smooth_rgb[1], self.smooth_rgb[2], self.brightness)
                    if pkt != self.last_sent:
                        self.last_sent = pkt
                        payload = json.dumps({
                            "method": "setPilot",
                            "params": {"r": pkt[0], "g": pkt[1], "b": pkt[2], "dimming": pkt[3]},
                        }).encode("utf-8")
                        try:
                            self.sock.sendto(payload, (self.bulb_ip, WIZ_PORT))
                        except Exception:
                            pass

                elapsed = time.perf_counter() - t0
                time.sleep(max(0.005, self.interval - elapsed))
        finally:
            x11.XCloseDisplay(dpy)


class BridgeState:
    def __init__(self):
        self.ip = None
        self.brightness = 80
        self.fps = 20
        self.last_static = {"temp": 3500}
        self.music_engine = None
        self.screen_engine = None
        self.lock = threading.Lock()

    def stop_engines(self):
        if self.music_engine is not None:
            self.music_engine.stop()
            self.music_engine = None
        if self.screen_engine is not None:
            self.screen_engine.stop()
            self.screen_engine = None

    def scan(self):
        found = []
        for _ in range(3):
            found = udp_rpc("255.255.255.255", "getPilot", {}, timeout=0.6, broadcast=True)
            if found:
                break
        if not found:
            emit({"type": "scan", "connected": False, "ip": None})
            return
        ip, res = found[0]
        self.ip = ip
        if "dimming" in res and isinstance(res["dimming"], int):
            self.brightness = max(10, min(100, res["dimming"]))
        if "r" in res and "g" in res and "b" in res:
            self.last_static = {"r": res["r"], "g": res["g"], "b": res["b"]}
        elif "temp" in res:
            self.last_static = {"temp": res["temp"]}
        emit({
            "type": "scan",
            "connected": True,
            "ip": ip,
            "state": bool(res.get("state", False)),
            "dimming": res.get("dimming", self.brightness),
        })

    def send_pilot(self, params):
        if not self.ip:
            self.scan()
        if not self.ip:
            return
        udp_rpc(self.ip, "setPilot", params, timeout=0.6, broadcast=False)

    def handle(self, msg):
        cmd = msg.get("cmd")
        with self.lock:
            if cmd == "scan":
                self.scan()
            elif cmd == "power":
                on = bool(msg.get("on", True))
                if not on:
                    self.stop_engines()
                    self.send_pilot({"state": False})
                else:
                    self.send_pilot({"state": True, "dimming": self.brightness, **self.last_static})
                emit({"type": "power", "state": on})
            elif cmd == "static":
                self.stop_engines()
                if "r" in msg and "g" in msg and "b" in msg:
                    self.last_static = {"r": int(msg["r"]), "g": int(msg["g"]), "b": int(msg["b"])}
                elif "temp" in msg:
                    self.last_static = {"temp": int(msg["temp"])}
                self.send_pilot({"state": True, "dimming": self.brightness, **self.last_static})
            elif cmd == "music":
                if not self.ip:
                    self.scan()
                if not self.ip:
                    return
                if self.screen_engine is not None:
                    self.screen_engine.stop()
                    self.screen_engine = None
                theme = msg.get("theme", "rainbow")
                source = msg.get("source", "system")
                if self.music_engine is not None and self.music_engine.source != source:
                    self.music_engine.stop()
                    self.music_engine = None
                if self.music_engine is None:
                    self.music_engine = MusicSyncEngine(self.ip, theme=theme, source=source, brightness=self.brightness, fps=self.fps)
                    self.music_engine.start()
                else:
                    self.music_engine.set_theme(theme)
            elif cmd == "screen":
                if not self.ip:
                    self.scan()
                if not self.ip:
                    return
                if self.music_engine is not None:
                    self.music_engine.stop()
                    self.music_engine = None
                region = msg.get("region", "full_screen")
                if self.screen_engine is None:
                    self.screen_engine = ScreenSyncEngine(self.ip, region=region, brightness=self.brightness, fps=self.fps)
                    self.screen_engine.start()
                else:
                    self.screen_engine.set_region(region)
            elif cmd == "brightness":
                self.brightness = max(10, min(100, int(msg.get("value", 80))))
                if self.music_engine is not None:
                    self.music_engine.set_brightness(self.brightness)
                elif self.screen_engine is not None:
                    self.screen_engine.set_brightness(self.brightness)
                else:
                    self.send_pilot({"state": True, "dimming": self.brightness, **self.last_static})
            elif cmd == "fps":
                self.fps = max(5, min(60, int(msg.get("value", 20))))
                interval = 1.0 / self.fps
                if self.music_engine is not None:
                    self.music_engine.set_interval(interval)
                if self.screen_engine is not None:
                    self.screen_engine.set_interval(interval)
            elif cmd == "stop":
                self.stop_engines()


def _install_parent_death_signal():
    """Ensure kernel kills wiz_bridge cleanly if isle-ui exits or crashes."""
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG = 1
    except Exception:
        pass


def main():
    _install_parent_death_signal()
    bridge = BridgeState()
    atexit.register(bridge.stop_engines)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    bridge.scan()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            bridge.handle(json.loads(line))
        except Exception as exc:
            emit({"type": "error", "message": str(exc)})
    bridge.stop_engines()


if __name__ == "__main__":
    main()
