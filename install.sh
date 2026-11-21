#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Re-Tex Core - Portable Standalone Installer ==="
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "Error: python3 (3.11-3.13) is required."; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || echo "Warning: ffmpeg not found (needed for MP3 export/import)."

if [ ! -d ".venv" ]; then
  echo "[1/3] Creating .venv..."
  "$PY" -m venv .venv
fi

echo "[2/3] Installing Re-Tex Core dependencies..."
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

echo ""
read -r -p "[3/3] Install standalone AI stem separation (audio-separator + torch)? [y/N] " ans
if [[ "${ans:-n}" =~ ^[Yy]$ ]]; then
  .venv/bin/pip install torch torchaudio
  .venv/bin/pip install -r requirements-standalone.txt
fi

echo ""
echo "Installed! Launch with: .venv/bin/python -m retex_core"
