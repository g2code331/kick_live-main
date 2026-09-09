#!/bin/bash
# KickLive post-upgrade hook (dpkg `after-upgrade`, wired through fpm's --after-upgrade).
#
# The only real upgrade hazard for this app is the sandbox helper's mode changing between
# releases, plus a stale update-staging directory. Both are cheap to fix and both are logged with
# the "kicklive:" prefix so an operator can grep one string across install/upgrade/remove.
set -u

APP_DIR="/opt/${sanitizedProductName}"
BIN_NAME='${executable}'
SANDBOX_HELPER="$APP_DIR/chrome-sandbox"

if [ -e "$SANDBOX_HELPER" ]; then
  if [ -L /proc/self/ns/user ] && command -v unshare >/dev/null 2>&1 && unshare --user true >/dev/null 2>&1; then
    chmod 0755 "$SANDBOX_HELPER" || true
  else
    chmod 4755 "$SANDBOX_HELPER" || true
  fi
fi

# Drop staged-but-uninstalled update artifacts from the previous version.
if command -v dpkg-query >/dev/null 2>&1; then
  : # (per-user data lives in ~/.config; nothing global to sweep beyond the staged copies below)
fi
if [ -d "$APP_DIR/resources/app.asar.unpacked/renderer/dist/assets" ]; then
  # electron-builder replaced the whole tree; a leftover *.part from the desktop updater is stale.
  find "$APP_DIR" -maxdepth 1 -name '*.part' -delete 2>/dev/null || true
fi

if command -v update-desktop-database >/dev/null 2>&1 && [ -d /usr/share/applications ]; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

echo "kicklive: upgraded system integration for $BIN_NAME in $APP_DIR"
exit 0
