#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Installs and activates the Isle HP EC Battery Charge Limit root systemd daemon.
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run with sudo: sudo $0" >&2
    exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SRC_PY="$SCRIPT_DIR/isle-hp-charge-limit.py"
BIN_DEST="/usr/local/bin/isle-hp-charge-limit"
UNIT_PATH="/etc/systemd/system/isle-hp-charge-limit.service"
MODLOAD_PATH="/etc/modules-load.d/acpi_call.conf"

if [ ! -r "$SRC_PY" ]; then
    echo "Missing daemon script: $SRC_PY" >&2
    exit 1
fi

TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || true)}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
    echo "Could not determine non-root target user (invoke via sudo as your user)." >&2
    exit 1
fi

USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
    echo "Could not resolve home directory for user '$TARGET_USER'." >&2
    exit 1
fi

CONFIG_PATH="$USER_HOME/.config/isle/settings.json"

install -Dm755 "$SRC_PY" "$BIN_DEST"
printf 'acpi_call\n' > "$MODLOAD_PATH"
chmod 644 "$MODLOAD_PATH"
modprobe acpi_call

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Isle HP Battery Charge Limit Daemon
After=local-fs.target systemd-modules-load.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 $BIN_DEST --config $CONFIG_PATH
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$UNIT_PATH"

systemctl daemon-reload
systemctl enable --now isle-hp-charge-limit.service
systemctl restart isle-hp-charge-limit.service

echo "Installed and started isle-hp-charge-limit.service (config: $CONFIG_PATH)"
systemctl --no-pager --lines=5 status isle-hp-charge-limit.service || true
