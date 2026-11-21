#!/usr/bin/env python3
"""Headless stdio JSON-lines bridge wrapping BUTLER's AgentRuntime for Isle XFCE integration."""

from __future__ import annotations

import ctypes
import json
import logging
import os
import queue
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any

# Keep stdout strictly reserved for JSON-lines protocol messages.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

# 1. Path Setup
BUTLER_SRC = os.environ.get("BUTLER_SRC", "/home/butarch/Desktop/BUTLER/src")
if BUTLER_SRC not in sys.path:
    sys.path.insert(0, BUTLER_SRC)

SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

# 2. Stub optional modules if missing
class StubObserver:
    def __init__(self, *args, **kwargs):
        pass
    def schedule(self, *args, **kwargs):
        pass
    def start(self):
        pass
    def stop(self):
        pass
    def join(self):
        pass

class StubFileSystemEventHandler:
    pass

import uuid

# Stub optional third-party modules only when absent (e.g. system python3 fallback).
try:
    import bs4  # noqa: F401
except Exception:
    bs4_mod = types.ModuleType("bs4")
    class _StubSoup:
        def __init__(self, *args, **kwargs):
            self._text = str(args[0]) if args else ""
        def get_text(self, *args, **kwargs):
            return self._text
        def __call__(self, *args, **kwargs):
            return []
        def find_all(self, *args, **kwargs):
            return []
        def find(self, *args, **kwargs):
            return None
    bs4_mod.BeautifulSoup = _StubSoup
    sys.modules["bs4"] = bs4_mod

try:
    import supabase  # noqa: F401
except Exception:
    sup_mod = types.ModuleType("supabase")
    sup_mod.create_client = lambda *a, **kw: None
    sup_mod.Client = object
    sys.modules["supabase"] = sup_mod

try:
    import watchdog.observers  # noqa: F401
    import watchdog.events  # noqa: F401
except Exception:
    wd = types.ModuleType("watchdog")
    wd.observers = types.ModuleType("watchdog.observers")
    wd.observers.Observer = StubObserver
    wd.events = types.ModuleType("watchdog.events")
    wd.events.FileSystemEventHandler = StubFileSystemEventHandler
    sys.modules["watchdog"] = wd
    sys.modules["watchdog.observers"] = wd.observers
    sys.modules["watchdog.events"] = wd.events

try:
    import ddgs  # noqa: F401
except Exception:
    ddgs_mod = types.ModuleType("ddgs")
    class _StubDDGS:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def text(self, *a, **kw): return []
        def news(self, *a, **kw): return []
    ddgs_mod.DDGS = _StubDDGS
    sys.modules["ddgs"] = ddgs_mod

# 3. Process Lifecycle Safety
try:
    libc = ctypes.CDLL("libc.so.6")
    PR_SET_PDEATHSIG = 1
    SIGTERM = 15
    libc.prctl(PR_SET_PDEATHSIG, SIGTERM)
except Exception:
    pass

# Thread-safe stdout writer
_stdout_lock = threading.Lock()
def emit(msg: dict[str, Any]) -> None:
    with _stdout_lock:
        try:
            print(json.dumps(msg, ensure_ascii=False), flush=True)
        except Exception:
            pass

def main() -> None:
    from butler_local_db import LocalButlerDB
    from butler.config import ButlerConfig, ApiKeyConfig
    from butler.tools.registry import build_default_tool_registry
    from butler.agent.loop import AgentRuntime

    runtime: AgentRuntime | None = None
    command_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    cancel_event = threading.Event()
    confirm_events: dict[str, threading.Event] = {}
    confirm_results: dict[str, bool] = {}
    confirm_lock = threading.Lock()

    shutdown_flag = threading.Event()

    def stdin_reader() -> None:
        while not shutdown_flag.is_set():
            line = sys.stdin.readline()
            if not line:
                shutdown_flag.set()
                command_queue.put({"cmd": "shutdown"})
                break
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except Exception as e:
                emit({"type": "error", "message": f"Invalid JSON: {e}"})
                continue
            cmd_name = data.get("cmd")
            if cmd_name == "confirm_reply":
                req_id = data.get("id")
                allow = bool(data.get("allow", False))
                with confirm_lock:
                    ev = confirm_events.get(req_id)
                    if ev is not None:
                        confirm_results[req_id] = allow
                        ev.set()
            elif cmd_name == "cancel":
                cancel_event.set()
            elif cmd_name == "shutdown":
                shutdown_flag.set()
                cancel_event.set()
                command_queue.put(data)
                break
            else:
                command_queue.put(data)

    t_reader = threading.Thread(target=stdin_reader, daemon=True)
    t_reader.start()

    def handle_init(cmd_data: dict[str, Any]) -> None:
        nonlocal runtime
        provider = cmd_data.get("provider", "nvidia")
        model = cmd_data.get("model", "").strip()
        instructions = cmd_data.get("instructions", "").strip()
        resume = cmd_data.get("resume", "").strip()

        # Load environment from .env if present
        env_path = Path("/home/butarch/Desktop/BUTLER/.env")
        if env_path.exists():
            try:
                for line in env_path.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"\'')
                    if k and v and not os.environ.get(k):
                        os.environ[k] = v
            except Exception:
                pass

        # Load NIM API key
        nim_key_path = Path.home() / ".config" / "isle" / "nim_api_key"
        nvidia_keys = []
        if nim_key_path.exists():
            try:
                val = nim_key_path.read_text().strip()
                if val:
                    nvidia_keys.append(ApiKeyConfig(key=val, label="isle-nim"))
            except Exception:
                pass

        # Load auth.json vault (flat {"gemini": "...", "claude": "..."} from AuthStore or list/dict entries)
        auth_json_path = Path.home() / ".config" / "isle" / "auth.json"
        gemini_keys = []
        claude_keys = []
        if auth_json_path.exists():
            try:
                auth_data = json.loads(auth_json_path.read_text())
                items: list[tuple[str, str, str]] = []
                vault = auth_data.get("vault", auth_data) if isinstance(auth_data, dict) else auth_data
                if isinstance(vault, dict):
                    for k_name, v_val in vault.items():
                        if isinstance(v_val, str):
                            items.append((str(k_name), v_val, str(k_name)))
                        elif isinstance(v_val, dict):
                            p = str(v_val.get("provider", k_name))
                            sec = str(v_val.get("key", v_val.get("apiKey", v_val.get("token", v_val.get("secret", "")))))
                            lbl = str(v_val.get("label", k_name))
                            items.append((p, sec, lbl))
                elif isinstance(vault, list):
                    for entry in vault:
                        if isinstance(entry, dict):
                            p = str(entry.get("provider", entry.get("id", "")))
                            sec = str(entry.get("key", entry.get("apiKey", entry.get("token", entry.get("secret", "")))))
                            lbl = str(entry.get("label", "vault"))
                            items.append((p, sec, lbl))

                for p_raw, k_raw, lbl in items:
                    p = p_raw.lower()
                    k = k_raw.strip()
                    if not k:
                        continue
                    if "gemini" in p or "google" in p or "agy" in p:
                        gemini_keys.append(ApiKeyConfig(key=k, label=lbl))
                    elif "claude" in p or "anthropic" in p:
                        claude_keys.append(ApiKeyConfig(key=k, label=lbl))
                    elif "nvidia" in p or "nim" in p:
                        nvidia_keys.append(ApiKeyConfig(key=k, label=lbl))
            except Exception:
                pass

        config = ButlerConfig(provider=provider)
        if model:
            config.model = model
            config.chat_model = model
        elif provider == "nvidia":
            stale = (
                "",
                "mistral:7b-instruct",
                "gemma:2b",
                "meta/llama-4-maverick-17b-128e-instruct",
                "meta/llama-3.3-70b-instruct",
            )
            if config.model in stale or "llama-4-maverick" in config.model or "llama-3.3-70b" in config.model:
                config.model = "nvidia/nemotron-3.5-super-vl-120b-a12b"
            if config.chat_model in stale or "llama-4-maverick" in config.chat_model or "llama-3.3-70b" in config.chat_model:
                config.chat_model = "nvidia/nemotron-3.5-super-vl-120b-a12b"
            config.fallback_models = [
                m for m in config.fallback_models
                if "llama-4-maverick" not in m and "llama-3.3-70b" not in m
            ] or ["nvidia/nemotron-3.5-super-vl-120b-a12b"]

        if gemini_keys:
            config.gemini_api_keys = gemini_keys + config.gemini_api_keys
        if claude_keys:
            config.claude_api_keys = claude_keys + config.claude_api_keys
        if nvidia_keys:
            config.nvidia_api_keys = nvidia_keys + config.nvidia_api_keys

        db = LocalButlerDB.open()
        
        class DummyMemoryStore:
            def record(self, *args, **kwargs): pass
            def recall(self, *args, **kwargs): return []
            def search(self, *args, **kwargs): return []

        dummy_mem = DummyMemoryStore()

        tools = build_default_tool_registry(config, db, dummy_mem)

        base_persona = config.persona or ""
        desktop_prompt_addition = (
            "\n\n[Isle Desktop Action Instructions]\n"
            "You are integrated into Isle XFCE desktop environment. When the user requests desktop actions "
            "(such as opening apps, controlling volume, wifi, bluetooth, timers, alarms, power modes, windows), "
            "you can append a single trailing JSON object at the very end of your response like this:\n"
            '{"actions":[{"type":"open_app","name":"terminal"}]}\n'
            "Supported action types: open_app, volume, wifi, bluetooth, timer, alarm, power_mode, window. "
            "Use your built-in tools for web, weather, notes, files, github, and spotify."
        )
        if instructions:
            config.persona = base_persona + "\n\n" + instructions + desktop_prompt_addition
        else:
            config.persona = base_persona + desktop_prompt_addition

        runtime = AgentRuntime(
            config=config,
            db=db,
            tools=tools,
            memory=dummy_mem,
            conversation_id=resume if resume else None
        )

        cid = runtime.conversation_id
        emit({"type": "ready", "conversation_id": cid})

    while True:
        try:
            cmd = command_queue.get(timeout=0.1)
        except queue.Empty:
            continue

        c_type = cmd.get("cmd")
        if c_type == "shutdown":
            break
        elif c_type == "init":
            try:
                handle_init(cmd)
            except Exception as e:
                emit({"type": "error", "message": f"Init failed: {e}"})
        elif c_type == "new_chat":
            if runtime and runtime.db:
                try:
                    cid = runtime.db.new_conversation()
                    runtime.conversation_id = cid
                    emit({"type": "ready", "conversation_id": cid})
                except Exception as e:
                    emit({"type": "error", "message": f"New chat failed: {e}"})
            else:
                emit({"type": "error", "message": "Runtime not initialized"})
        elif c_type == "cancel":
            cancel_event.set()
        elif c_type == "confirm_reply":
            req_id = cmd.get("id")
            allow = bool(cmd.get("allow", False))
            with confirm_lock:
                if req_id in confirm_events:
                    confirm_results[req_id] = allow
                    confirm_events[req_id].set()
        elif c_type == "ask":
            if not runtime:
                emit({"type": "error", "message": "Runtime not initialized"})
                continue

            text = cmd.get("text", "")
            req_id = cmd.get("request_id", "req-1")
            cancel_event.clear()

            def on_status(status_text: str) -> None:
                emit({"type": "activity", "text": status_text})

            def confirm_tool_cb(tool_name: str, args: dict[str, Any]) -> bool:
                cid = str(uuid.uuid4())
                ev = threading.Event()
                with confirm_lock:
                    confirm_events[cid] = ev
                    confirm_results[cid] = False
                emit({"type": "confirm", "id": cid, "tool": tool_name, "args": args})
                signaled = ev.wait(timeout=60.0)
                with confirm_lock:
                    confirm_events.pop(cid, None)
                    res = confirm_results.pop(cid, False)
                return res if signaled else False

            def on_plan_review_cb(plan_summary: str) -> bool:
                emit({"type": "activity", "text": "Reviewing plan..."})
                return True

            runtime.on_status_update = on_status
            runtime.confirm_tool = confirm_tool_cb
            runtime.on_plan_review = on_plan_review_cb

            accumulated = ""
            last_emit_time = 0.0

            try:
                for token in runtime.chat_once_stream(text, auto_approve=False, cancel_event=cancel_event):
                    if cancel_event.is_set():
                        break
                    accumulated += token
                    now = time.time()
                    if now - last_emit_time > 0.06 or "\n" in token:
                        emit({"type": "draft", "text": accumulated})
                        last_emit_time = now

                emit({"type": "draft", "text": accumulated})

                say = accumulated
                actions = []
                
                import re
                json_match = re.search(r'(\{[\s\S]*"actions"[\s\S]*\})', accumulated)
                if json_match:
                    try:
                        parsed_json = json.loads(json_match.group(1))
                        if isinstance(parsed_json, dict) and "actions" in parsed_json:
                            actions = parsed_json["actions"]
                            say = accumulated.replace(json_match.group(1), "").strip()
                    except Exception:
                        pass

                emit({
                    "type": "answer",
                    "say": say,
                    "actions": actions,
                    "done": True,
                    "listen": False,
                    "conversation_id": runtime.conversation_id
                })
            except Exception as e:
                emit({"type": "error", "message": f"Ask failed: {e}"})

if __name__ == "__main__":
    main()
