#!/usr/bin/env bash
# Installs w-okada/voice-changer (VCClient) - the realtime RVC voice
# conversion server Live Call streams call audio through.
#
# This is deliberately NOT wired into package.json's postinstall: the
# voice-changer stack is a multi-gigabyte PyTorch install plus a sizeable
# pretrain weight download on first boot, and a failure here must never
# take the rest of the deployment (calls, bridges, the web app) down with
# it. Run it explicitly on a host that should do voice conversion:
#
#   bash server/voicechanger/setup.sh
#
# Everything lands OUTSIDE the repo, under $VOICE_CHANGER_HOME, so nothing
# heavy is ever committed or shipped with the app.
#
# Tunables (env vars):
#   VOICE_CHANGER_HOME  where the checkout + venv live (default: $HOME/voice-changer)
#   VOICE_CHANGER_REF   git ref to check out (default: master)
#   VOICE_CHANGER_CPU   1 = force CPU-only wheels (default: auto-detect via nvidia-smi)
set -uo pipefail

VC_HOME="${VOICE_CHANGER_HOME:-$HOME/voice-changer}"
VC_REF="${VOICE_CHANGER_REF:-master}"
VC_REPO="https://github.com/w-okada/voice-changer.git"

echo "[voice-changer] Installing into: $VC_HOME (ref: $VC_REF)"

if ! command -v git >/dev/null 2>&1; then
  echo "[voice-changer] git not found - cannot install. Skipping."
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[voice-changer] python3 not found - cannot install. Skipping."
  exit 0
fi

# ---------------------------------------------------------------------------
# System audio libs. voice-changer imports `sounddevice` at startup (via
# Local/ServerDevice), which needs PortAudio present at runtime even though
# Live Call never uses server-side hardware audio (our audio arrives over the
# Socket.IO stream instead).
# ---------------------------------------------------------------------------
if ! ldconfig -p 2>/dev/null | grep -q libportaudio; then
  echo "[voice-changer] Installing PortAudio (best effort)..."
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y || true
    $SUDO apt-get install -y libportaudio2 libasound-dev || echo "[voice-changer] WARNING: could not install PortAudio - voice-changer may fail to start."
  else
    echo "[voice-changer] No apt-get here - if voice-changer fails to start, install PortAudio manually."
  fi
fi

# ---------------------------------------------------------------------------
# Checkout (shallow - the repo carries client builds and sample assets we
# never need).
# ---------------------------------------------------------------------------
if [ -d "$VC_HOME/.git" ]; then
  echo "[voice-changer] Existing checkout found - fetching updates..."
  git -C "$VC_HOME" fetch --depth 1 origin "$VC_REF" || true
  git -C "$VC_HOME" checkout "$VC_REF" || true
else
  mkdir -p "$(dirname "$VC_HOME")"
  if ! git clone --depth 1 --branch "$VC_REF" "$VC_REPO" "$VC_HOME"; then
    echo "[voice-changer] Clone of '$VC_REF' failed (tag name changed?). Trying master..."
    if ! git clone --depth 1 "$VC_REPO" "$VC_HOME"; then
      echo "[voice-changer] WARNING: clone failed - voice conversion will be unavailable. Skipping."
      exit 0
    fi
  fi
fi

if [ ! -f "$VC_HOME/server/MMVCServerSIO.py" ]; then
  echo "[voice-changer] WARNING: $VC_HOME/server/MMVCServerSIO.py not found after checkout. Skipping."
  exit 0
fi

# ---------------------------------------------------------------------------
# Python env. A venv keeps torch/onnxruntime pinned away from the app's own
# Python (this repo's requirements.txt is for the Telegram bridge).
# ---------------------------------------------------------------------------
PY="$VC_HOME/.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "[voice-changer] Creating virtualenv..."
  if ! python3 -m venv "$VC_HOME/.venv"; then
    echo "[voice-changer] venv creation failed - falling back to system python3."
    PY="$(command -v python3)"
  fi
fi

GPU=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then GPU=1; fi
if [ "${VOICE_CHANGER_CPU:-0}" = "1" ]; then GPU=0; fi

REQ="$VC_HOME/server/requirements.txt"
if [ "$GPU" -eq 0 ]; then
  echo "[voice-changer] No GPU detected (or VOICE_CHANGER_CPU=1) - installing CPU wheels."
  # onnxruntime-gpu aborts on import without a CUDA runtime, and the default
  # torch wheel pulls ~2GB of CUDA packages we cannot use here.
  sed -e 's/^onnxruntime-gpu==.*/onnxruntime==1.14.1/' -e '/^torch==/d' -e '/^torchaudio==/d' "$REQ" > "$VC_HOME/server/requirements.cpu.txt"
  "$PY" -m pip install --upgrade pip
  "$PY" -m pip install -r "$VC_HOME/server/requirements.cpu.txt"
  "$PY" -m pip install torch==2.0.1 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cpu
else
  echo "[voice-changer] GPU detected - installing the upstream (CUDA) requirements."
  "$PY" -m pip install --upgrade pip
  "$PY" -m pip install -r "$REQ"
fi

mkdir -p "$VC_HOME/model_dir"

echo ""
echo "[voice-changer] Installed."
echo "  checkout : $VC_HOME"
echo "  python   : $PY"
echo "  model dir: $VC_HOME/model_dir"
echo ""
echo "Next steps:"
echo "  1. Put an RVC model where this host can read it (.pth + optional .index)."
echo "  2. Load it into a slot (either is fine):"
echo "       - open the voice-changer WebUI (start.sh, then http://<host>:18888) and upload it there, or"
echo "       - use this app's API:  POST /api/social-call/voice/load-model  {\"slot\":0,\"pthPath\":\"...\",\"indexPath\":\"...\"}"
echo "  3. Set VOICE_CHANGER_MODEL_SLOT=<slot> on the Live Call backend (or pick the model in the call prep screen)."
echo "  4. Start it: bash server/voicechanger/start.sh   (or VOICE_CHANGER_AUTOSTART=1 to let server.mjs own it)"
echo ""
echo "NOTE: first launch downloads the pretrain weights (hubert/contentvec/rmvpe); that is normal and takes a few minutes."
