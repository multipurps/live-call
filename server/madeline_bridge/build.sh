#!/usr/bin/env bash
# Builds the MadelineProto PHP bridge (real Telegram P2P calling). Run from
# postinstall, same pattern as the old server/tgcalls_bridge/build.sh.
#
# Does NOT use apt-get: Render's build container is non-root with a
# read-only /var/lib/apt/lists, confirmed directly from a real build log
# ("Unable to acquire the dpkg frontend lock", "Read-only file system").
# Instead downloads a static, self-contained PHP binary (no system
# packages, no root needed) from static-php-builds, which also bundles
# Composer - one download covers both.
#
# Never hard-fails: if this can't be set up here, the rest of the app
# (WhatsApp, Telegram status/contacts, everything else already working)
# must still deploy. server.mjs's spawn function checks for the actual
# php binary and vendor/autoload.php before attempting to launch this
# bridge, rather than crashing if either is missing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PHP_VERSION="8.3.33"
PHP_TARBALL="php-${PHP_VERSION}-linux-x86_64.tar.gz"
PHP_URL="https://github.com/nunomaduro/static-php-builds/releases/download/v${PHP_VERSION}/${PHP_TARBALL}"
PHP_DIR="$(pwd)/php-bin"
PHP_BIN="${PHP_DIR}/bin/php"

if [ ! -x "$PHP_BIN" ]; then
  echo "[madeline_bridge] Downloading static PHP ${PHP_VERSION} (no apt/root needed)..."
  mkdir -p "$PHP_DIR"
  curl -fsSL -o /tmp/php.tar.gz "$PHP_URL"
  if [ $? -ne 0 ]; then
    echo "[madeline_bridge] WARNING: PHP download failed - skipping real Telegram P2P calling."
    exit 0
  fi
  tar -xzf /tmp/php.tar.gz -C "$PHP_DIR"
  rm -f /tmp/php.tar.gz
  if [ ! -x "$PHP_BIN" ]; then
    echo "[madeline_bridge] WARNING: PHP binary not found after extracting - skipping real Telegram P2P calling."
    exit 0
  fi
fi

echo "[madeline_bridge] PHP ready: $($PHP_BIN --version | head -1)"

# Verified directly by extracting the tarball and inspecting it: Composer
# is bundled at libexec/composer.phar, with a ready-to-use bin/composer
# wrapper script that runs it with the bundled PHP.
COMPOSER_BIN="${PHP_DIR}/bin/composer"
if [ ! -x "$COMPOSER_BIN" ]; then
  echo "[madeline_bridge] WARNING: bundled composer wrapper not found - skipping real Telegram P2P calling."
  exit 0
fi

echo "[madeline_bridge] Running composer install..."
"$COMPOSER_BIN" install --no-dev --optimize-autoloader --no-interaction
if [ $? -ne 0 ] || [ ! -f "vendor/autoload.php" ]; then
  echo "[madeline_bridge] WARNING: composer install failed - skipping real Telegram P2P calling. See the log above for the actual error."
  exit 0
fi

echo "[madeline_bridge] Build succeeded: vendor/autoload.php present, php binary at $PHP_BIN"
