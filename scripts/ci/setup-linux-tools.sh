#!/bin/bash
# CI tooling for the Linux desktop jobs. Everything here is what electron-builder + dpkg + xvfb
# smoke need at *runtime*; the npm packages come from `npm ci`.
#
# Safe to re-run (idempotent) and refuses to pretend success if apt is unavailable but the tools are
# missing, because a desktop job that silently skips the .deb checks is worse than a red job.
set -uo pipefail

# Hard requirements: without these the job cannot prove anything. The desktop-cache tools are
# optional polish (verify-packaging WARNs when they are absent), so they are installed but not fatal.
need=(xvfb-run dpkg-deb mksquashfs)
optional=(gtk-update-icon-cache update-desktop-database desktop-file-validate)
missing=()
for tool in "${need[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done

if [ "${#missing[@]}" -eq 0 ]; then
  echo "setup-linux-tools: all required tools present ($(printf '%s ' "${need[@]}"))"
else
  echo "setup-linux-tools: missing ${missing[*]} — installing via apt"
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "setup-linux-tools: apt-get is not available on this runner; cannot install ${missing[*]}" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  SUDO=""
  if [ "$(id -u)" != "0" ]; then
    command -v sudo >/dev/null 2>&1 || { echo "setup-linux-tools: need root or sudo" >&2; exit 1; }
    SUDO="sudo"
  fi
  $SUDO apt-get update -qq
  # Runtime libs electron needs under xvfb + the packaging tools for .deb/AppImage + desktop checks.
  $SUDO apt-get install -y -qq --no-install-recommends \
    xvfb \
    x11-utils \
    xauth \
    dbus-x11 \
    libnss3 \
    libnspr4 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libcups2t64 \
    libdrm2 \
    libgbm1 \
    libasound2t64 \
    libpango-1.0-0 \
    libcairo2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgtk-3-0t64 \
    libnotify4 \
    squashfs-tools \
    dpkg \
  libgtk-3-bin \
    desktop-file-utils \
    shared-mime-info \
    libfuse2t64
fi

for tool in "${need[@]}"; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "setup-linux-tools: $tool still missing after install" >&2
    exit 1
  fi
done
for tool in "${optional[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || echo "setup-linux-tools: note: $tool unavailable (desktop-entry checks will degrade to a warning)"
done
echo "setup-linux-tools: ready"
