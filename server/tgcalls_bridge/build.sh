#!/usr/bin/env bash
# Builds tgcalls_bridge (real Telegram P2P calling). Run from postinstall,
# not Render's buildCommand, since that setting can't be changed via the
# available tooling for this service - this way the build stays entirely
# in the repo. Never hard-fails: if Rust/the native ntgcalls dependency
# can't build here, the rest of the app (WhatsApp, Telegram status/contacts,
# everything already working) must still deploy. server.mjs's
# startTgCallsBridge() already checks for the compiled binary and logs a
# warning + skips real P2P calling if it's missing, rather than crashing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "[tgcalls_bridge] Checking for a Rust toolchain..."

need_install=1
if command -v cargo >/dev/null 2>&1; then
  ver=$(rustc --version 2>/dev/null | awk '{print $2}')
  major=$(echo "$ver" | cut -d. -f1)
  minor=$(echo "$ver" | cut -d. -f2)
  # ntgcalls' dependency tree needs edition2024 (Rust 1.85+).
  if [ "${major:-0}" -gt 1 ] || { [ "${major:-0}" -eq 1 ] && [ "${minor:-0}" -ge 85 ]; }; then
    need_install=0
    echo "[tgcalls_bridge] Found usable Rust $ver already on PATH."
  else
    echo "[tgcalls_bridge] Found Rust $ver, but need 1.85+ (edition2024). Installing a newer toolchain via rustup."
  fi
fi

if [ "$need_install" -eq 1 ]; then
  export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  if [ $? -ne 0 ]; then
    echo "[tgcalls_bridge] WARNING: rustup install failed - skipping real Telegram P2P calling (PyTgCalls-only)."
    exit 0
  fi
  . "$CARGO_HOME/env"
fi

echo "[tgcalls_bridge] Building (release)..."
cargo build --release
if [ $? -ne 0 ]; then
  echo "[tgcalls_bridge] WARNING: build failed - skipping real Telegram P2P calling (PyTgCalls-only). See the build log above for the actual compiler error."
  exit 0
fi

echo "[tgcalls_bridge] Build succeeded: target/release/tgcalls_bridge"
