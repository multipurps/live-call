#!/usr/bin/env bash
# Builds the MadelineProto PHP bridge (real Telegram P2P calling). Run from
# postinstall, same pattern as server/tgcalls_bridge/build.sh. Never hard-
# fails: if PHP/composer/MadelineProto can't be set up here, the rest of
# the app (WhatsApp, Telegram status/contacts, everything else already
# working) must still deploy. server.mjs's spawn function checks for
# vendor/autoload.php before attempting to launch this bridge, rather than
# crashing if it's missing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "[madeline_bridge] Checking for PHP..."

if ! command -v php >/dev/null 2>&1; then
  echo "[madeline_bridge] PHP not found - installing via apt..."
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
  $SUDO apt-get update -y
  $SUDO apt-get install -y php-cli php-curl php-mbstring php-xml
  if ! command -v php >/dev/null 2>&1; then
    echo "[madeline_bridge] WARNING: could not install PHP - skipping real Telegram P2P calling."
    exit 0
  fi
fi

echo "[madeline_bridge] PHP found: $(php --version | head -1)"

if ! command -v composer >/dev/null 2>&1; then
  echo "[madeline_bridge] Composer not found - installing locally..."
  php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
  php composer-setup.php --quiet
  rm -f composer-setup.php
  COMPOSER_BIN="php composer.phar"
else
  COMPOSER_BIN="composer"
fi

echo "[madeline_bridge] Running composer install..."
$COMPOSER_BIN install --no-dev --optimize-autoloader --no-interaction
if [ $? -ne 0 ] || [ ! -f "vendor/autoload.php" ]; then
  echo "[madeline_bridge] WARNING: composer install failed - skipping real Telegram P2P calling. See the log above for the actual error."
  exit 0
fi

echo "[madeline_bridge] Build succeeded: vendor/autoload.php present"
