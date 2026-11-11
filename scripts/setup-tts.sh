#!/usr/bin/env bash
set -euo pipefail

DEST_DIR="$HOME/.local/share/isle/piper"
VOICES_DIR="$DEST_DIR/voices"
VOICE_ONNX="$VOICES_DIR/en_GB-jenny_dioco-medium.onnx"
VOICE_JSON="$VOICES_DIR/en_GB-jenny_dioco-medium.onnx.json"
PIPER_BIN="$DEST_DIR/piper/piper"

mkdir -p "$VOICES_DIR"

if [[ ! -x "$PIPER_BIN" ]]; then
    echo "Downloading Piper binary..."
    TMP_TAR=$(mktemp --suffix=.tar.gz)
    curl -sSL -m 60 -o "$TMP_TAR" "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
    tar -xzf "$TMP_TAR" -C "$DEST_DIR"
    rm -f "$TMP_TAR"
fi

if [[ ! -s "$VOICE_ONNX" ]]; then
    echo "Downloading Jenny Dioco ONNX model..."
    curl -sSL -m 60 -o "$VOICE_ONNX" "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx"
fi

if [[ ! -s "$VOICE_JSON" ]]; then
    echo "Downloading Jenny Dioco model config..."
    curl -sSL -m 30 -o "$VOICE_JSON" "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx.json"
fi

echo "Verifying synthesis..."
if echo "Hello, Isle Assistant voice setup complete." | "$PIPER_BIN" --model "$VOICE_ONNX" --output-raw > /dev/null; then
    echo "Piper TTS with Jenny Dioco (Irish female) ready at $DEST_DIR"
else
    echo "Verification failed!" >&2
    exit 1
fi

