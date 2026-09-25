#!/usr/bin/env bash
# Builds whatsapp_rust_bridge - the real WhatsApp calling backend.
#
# Called from `postinstall` (see package.json), NOT from a platform build
# command, so the whole build stays inside this repo. It never hard-fails:
# if the Rust toolchain or whatsapp-rust's dependency tree cannot be built
# here, everything else in Live Call (Green API WhatsApp calling, Telegram,
# the Anam AI call, the whole frontend) must still deploy. server.mjs's
# startWhatsAppRustBridge() already checks for the compiled binary and logs
# a warning instead of crashing when it is missing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# whatsapp-rust 0.7 declares `rust-version = "1.94"` and edition 2024, so an
# older toolchain fails on its dependency tree, not on our code.
REQUIRED_MAJOR=1
REQUIRED_MINOR=94

echo "[whatsapp_rust_bridge] Checking for a Rust toolchain..."

need_install=1
if command -v cargo >/dev/null 2>&1; then
  ver=$(rustc --version 2>/dev/null | awk '{print $2}')
  major=$(echo "$ver" | cut -d. -f1)
  minor=$(echo "$ver" | cut -d. -f2)
  if [ "${major:-0}" -gt "$REQUIRED_MAJOR" ] || { [ "${major:-0}" -eq "$REQUIRED_MAJOR" ] && [ "${minor:-0}" -ge "$REQUIRED_MINOR" ]; }; then
    need_install=0
    echo "[whatsapp_rust_bridge] Found usable Rust $ver already on PATH."
  else
    echo "[whatsapp_rust_bridge] Found Rust $ver, but whatsapp-rust needs ${REQUIRED_MAJOR}.${REQUIRED_MINOR}+. Installing a newer toolchain via rustup."
  fi
fi

if [ "$need_install" -eq 1 ]; then
  export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  if [ $? -ne 0 ]; then
    echo "[whatsapp_rust_bridge] WARNING: rustup install failed - real whatsapp-rust calling unavailable (Green API still works)."
    exit 0
  fi
  . "$CARGO_HOME/env"
fi

# ffmpeg is what turns the live avatar JPEG frames into the H.264 Annex-B
# access units WhatsApp calls carry. Only needed at RUNTIME (and only for
# video), so a missing ffmpeg is a warning here, not a build failure - audio
# calls and everything else still work without it.
if command -v ffmpeg >/dev/null 2>&1; then
  echo "[whatsapp_rust_bridge] ffmpeg found: $(ffmpeg -version 2>/dev/null | head -1)"
else
  echo "[whatsapp_rust_bridge] WARNING: ffmpeg not on PATH. Outgoing WhatsApp VIDEO needs it (the bridge will report the real error if you place a video call without it). Audio calls are unaffected."
fi

echo "[whatsapp_rust_bridge] Building (release)..."
cargo build --release
if [ $? -ne 0 ]; then
  echo "[whatsapp_rust_bridge] WARNING: build failed - real whatsapp-rust calling unavailable. See the compiler error above. Green API WhatsApp calling is untouched and still works."
  exit 0
fi

echo "[whatsapp_rust_bridge] Build succeeded: target/release/whatsapp_rust_bridge"
