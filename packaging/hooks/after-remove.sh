#!/bin/bash
# KickLive post-removal hook (dpkg `postrm`). Mirrors after-install: every alternative-created
# artifact must be cleaned up even when the package manager already removed /opt/KickLive.
set -u

APP_DIR="/opt/${sanitizedProductName}"
BIN_NAME='${executable}'

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove "$BIN_NAME" "$APP_DIR/$BIN_NAME" >/dev/null 2>&1 || true
fi
# Belt and braces: a plain symlink install (no update-alternatives) leaves /usr/bin/<exe> behind.
if [ -L "/usr/bin/$BIN_NAME" ]; then
  rm -f "/usr/bin/$BIN_NAME"
fi

if command -v update-desktop-database >/dev/null 2>&1 && [ -d /usr/share/applications ]; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

# User data (~/.config/kicklive) is intentionally NOT deleted: purge semantics belong to
# `dpkg -P`, and silently deleting a user's settings on upgrade-then-remove is how data gets lost.
echo "kicklive: removed system integration for $BIN_NAME (user data in ~/.config/${BIN_NAME} kept)"
exit 0
