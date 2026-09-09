#!/bin/bash
# KickLive post-install hook (packaged into the .deb as the maintainer script).
#
# This file is fed through electron-builder's bash template pass, so ${executable} and
# ${sanitizedProductName} are substituted at build time. Anything that has to survive being run
# as the root user inside a chroot/CI image stays POSIX-simple and failure-tolerant: a broken
# desktop-database update must not fail an install.
set -u

APP_DIR="/opt/${sanitizedProductName}"
BIN_NAME='${executable}'
DESKTOP_FILE="/usr/share/applications/${BIN_NAME}.desktop"
SANDBOX_HELPER="$APP_DIR/chrome-sandbox"

fail_soft() {
  # $1 = description, rest = command
  local what="$1"; shift
  if ! "$@" >/dev/null 2>&1; then
    echo "kicklive: $what failed (continuing)" >&2
  fi
}

# 1) /usr/bin/<exe> shim. Prefer update-alternatives so multiple installs can coexist.
if command -v update-alternatives >/dev/null 2>&1; then
  if [ -L "/usr/bin/$BIN_NAME" ] && [ ! -e "/etc/alternatives/$BIN_NAME" ]; then
    rm -f "/usr/bin/$BIN_NAME"
  fi
  fail_soft "update-alternatives install" \
    update-alternatives --install "/usr/bin/$BIN_NAME" "$BIN_NAME" "$APP_DIR/$BIN_NAME" 100
else
  ln -sf "$APP_DIR/$BIN_NAME" "/usr/bin/$BIN_NAME" || echo "kicklive: symlink failed (continuing)" >&2
fi

# 2) chrome-sandbox needs the setuid bit only when unprivileged user namespaces are unavailable.
if [ -e "$SANDBOX_HELPER" ]; then
  if [ -L /proc/self/ns/user ] && command -v unshare >/dev/null 2>&1 && unshare --user true >/dev/null 2>&1; then
    chmod 0755 "$SANDBOX_HELPER" || true
  else
    chmod 4755 "$SANDBOX_HELPER" || true
  fi
fi

# 3) Make the window manager / app menu find us.
if command -v update-desktop-database >/dev/null 2>&1 && [ -d /usr/share/applications ]; then
  fail_soft "update-desktop-database" update-desktop-database /usr/share/applications
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d /usr/share/icons/hicolor ]; then
  fail_soft "icon cache" gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor
fi
if command -v update-mime-database >/dev/null 2>&1 && [ -d /usr/share/mime ]; then
  fail_soft "mime database" update-mime-database /usr/share/mime
fi

# 4) Sanity check that the payload really landed; this is the line the packaging gate greps for.
if [ -x "$APP_DIR/$BIN_NAME" ] && [ -f "$APP_DIR/resources/app.asar" ]; then
  echo "kicklive: installed $BIN_NAME into $APP_DIR (desktop entry: $DESKTOP_FILE)"
else
  echo "kicklive: WARNING incomplete install (binary=$APP_DIR/$BIN_NAME asar=$APP_DIR/resources/app.asar)" >&2
  exit 1
fi

exit 0
