#!/usr/bin/env bash
# Starts w-okada/voice-changer's realtime server (MMVCServerSIO.py) - the
# RVC voice conversion engine Live Call's backend streams call audio through
# (see server/voice_changer.mjs).
#
# Run it directly, or let server.mjs own the process with
# VOICE_CHANGER_AUTOSTART=1.
#
# Tunables (env vars):
#   VOICE_CHANGER_HOME  checkout created by setup.sh   (default: $HOME/voice-changer)
#   VOICE_CHANGER_PORT  port to listen on             (default: 18888)
#   VOICE_CHANGER_MODEL_DIR  model slot directory     (default: $VOICE_CHANGER_HOME/model_dir)
#   VOICE_CHANGER_HOST  bind address                  (default: 127.0.0.1)
#   VOICE_CHANGER_PYTHON  interpreter                 (default: the venv setup.sh created)
set -uo pipefail

VC_HOME="${VOICE_CHANGER_HOME:-$HOME/voice-changer}"
VC_PORT="${VOICE_CHANGER_PORT:-18888}"
VC_HOST="${VOICE_CHANGER_HOST:-127.0.0.1}"
VC_MODEL_DIR="${VOICE_CHANGER_MODEL_DIR:-$VC_HOME/model_dir}"
VC_PY="${VOICE_CHANGER_PYTHON:-$VC_HOME/.venv/bin/python}"

if [ ! -f "$VC_HOME/server/MMVCServerSIO.py" ]; then
  echo "[voice-changer] $VC_HOME/server/MMVCServerSIO.py not found - run bash server/voicechanger/setup.sh first."
  exit 1
fi
if [ ! -x "$VC_PY" ] && ! command -v "$VC_PY" >/dev/null 2>&1; then
  echo "[voice-changer] Python interpreter '$VC_PY' not found - run bash server/voicechanger/setup.sh first."
  exit 1
fi

mkdir -p "$VC_MODEL_DIR"

# voice-changer resolves every pretrain path relative to its own server/
# directory, so it MUST be launched from there.
cd "$VC_HOME/server" || exit 1

echo "[voice-changer] Starting on http://$VC_HOST:$VC_PORT (model_dir: $VC_MODEL_DIR)"
# --https false: this is a loopback/intranet service fronted by server.mjs,
#                so TLS only costs latency here.
# The remaining flags are upstream defaults; they are listed explicitly so a
# deployment can point them at shared/pre-downloaded weights.
exec "$VC_PY" MMVCServerSIO.py \
  --logLevel error \
  -p "$VC_PORT" \
  --https false \
  --host "$VC_HOST" \
  --model_dir "$VC_MODEL_DIR" \
  --content_vec_500 pretrain/checkpoint_best_legacy_500.pt \
  --content_vec_500_onnx pretrain/content_vec_500.onnx \
  --content_vec_500_onnx_on true \
  --hubert_base pretrain/hubert_base.pt \
  --hubert_base_jp pretrain/rinna_hubert_base_jp.pt \
  --hubert_soft pretrain/hubert/hubert-soft-0d54a1f4.pt \
  --nsf_hifigan pretrain/nsf_hifigan/model \
  --crepe_onnx_full pretrain/crepe_onnx_full.onnx \
  --crepe_onnx_tiny pretrain/crepe_onnx_tiny.onnx \
  --rmvpe pretrain/rmvpe.pt \
  --rmvpe_onnx pretrain/rmvpe.onnx
