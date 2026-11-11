#!/usr/bin/env bash
# Setup script for Isle on XFCE
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/isle"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"

NIM_KEY="${NVIDIA_API_KEY:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --nim-key)
            if [[ $# -ge 2 && -n "$2" ]]; then
                NIM_KEY="$2"
                shift 2
            else
                echo "Error: --nim-key requires an argument" >&2
                exit 1
            fi
            ;;
        --help|-h)
            echo "Usage: $0 [--nim-key <KEY>]"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: $0 [--nim-key <KEY>]" >&2
            exit 1
            ;;
    esac
done

# 1. Config directory
mkdir -p "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR"

if [[ -n "$NIM_KEY" ]]; then
    printf '%s' "$NIM_KEY" > "$CONFIG_DIR/nim_api_key"
    chmod 0600 "$CONFIG_DIR/nim_api_key"
    echo "Saved NVIDIA NIM API key to $CONFIG_DIR/nim_api_key (permissions: 0600)"
fi

# 2. Install binaries to ~/.local/bin
mkdir -p "$BIN_DIR"

ISLED_BIN=""
if [[ -f "$REPO_ROOT/target/release/isled" ]]; then
    ISLED_BIN="$REPO_ROOT/target/release/isled"
elif [[ -f "$REPO_ROOT/target/debug/isled" ]]; then
    ISLED_BIN="$REPO_ROOT/target/debug/isled"
fi

if [[ -n "$ISLED_BIN" ]]; then
    cp -f "$ISLED_BIN" "$BIN_DIR/isled"
    chmod 0755 "$BIN_DIR/isled"
    echo "Installed isled -> $BIN_DIR/isled"
else
    echo "Warning: isled binary not found in target/release or target/debug" >&2
fi

ISLE_UI_BIN=""
if [[ -f "$REPO_ROOT/target/release/isle-ui" ]]; then
    ISLE_UI_BIN="$REPO_ROOT/target/release/isle-ui"
elif [[ -f "$REPO_ROOT/target/debug/isle-ui" ]]; then
    ISLE_UI_BIN="$REPO_ROOT/target/debug/isle-ui"
fi

if [[ -n "$ISLE_UI_BIN" ]]; then
    cp -f "$ISLE_UI_BIN" "$BIN_DIR/isle-ui"
    chmod 0755 "$BIN_DIR/isle-ui"
    echo "Installed isle-ui -> $BIN_DIR/isle-ui"
else
    echo "Warning: isle-ui binary not found in target/release or target/debug" >&2
fi

# 3. Install systemd user units
mkdir -p "$SYSTEMD_USER_DIR"
if [[ -f "$REPO_ROOT/packaging/systemd/isled.service" ]]; then
    cp -f "$REPO_ROOT/packaging/systemd/isled.service" "$SYSTEMD_USER_DIR/isled.service"
    chmod 0644 "$SYSTEMD_USER_DIR/isled.service"
    echo "Installed isled.service -> $SYSTEMD_USER_DIR/isled.service"
fi

if [[ -f "$REPO_ROOT/packaging/systemd/isle-ui.service" ]]; then
    cp -f "$REPO_ROOT/packaging/systemd/isle-ui.service" "$SYSTEMD_USER_DIR/isle-ui.service"
    chmod 0644 "$SYSTEMD_USER_DIR/isle-ui.service"
    echo "Installed isle-ui.service -> $SYSTEMD_USER_DIR/isle-ui.service"
fi

if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload || true
fi

# 4. Install autostart desktop entry
mkdir -p "$AUTOSTART_DIR"
if [[ -f "$REPO_ROOT/packaging/isle-ui.desktop" ]]; then
    cp -f "$REPO_ROOT/packaging/isle-ui.desktop" "$AUTOSTART_DIR/isle-ui.desktop"
    chmod 0644 "$AUTOSTART_DIR/isle-ui.desktop"
    echo "Installed isle-ui.desktop -> $AUTOSTART_DIR/isle-ui.desktop"
fi

# 5. Bind <Super>i shortcut in XFCE
if command -v xfconf-query >/dev/null 2>&1; then
    xfconf-query -c xfce4-keyboard-shortcuts -p "/commands/custom/<Super>i" -n -t string -s "$HOME/.local/bin/isle-ui --toggle" || true
    echo "Configured <Super>i shortcut in XFCE"
else
    echo "xfconf-query not found; skipped keyboard shortcut binding"
fi

echo "Isle XFCE setup completed successfully."
