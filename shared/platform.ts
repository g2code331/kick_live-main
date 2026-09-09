/**
 * Platform identity used by the update manifest lookup. Kept in shared/ so the desktop, the CI
 * manifest builder and the tests all derive the same key.
 */

import type { PlatformId } from "./update-manifest.ts";

export function platformIdFor(platform: string, arch: string): PlatformId | null {
  if (platform === "linux") {
    if (arch === "x64") return "linux_x64";
    if (arch === "arm64") return "linux_arm64";
    return null;
  }
  if (platform === "darwin") return arch === "arm64" || arch === "x64" ? "darwin_arm64" : null;
  if (platform === "win32") return arch === "x64" ? "win32_x64" : null;
  return null;
}

/** `linux_x64` -> `linux-x64`, the suffix electron-builder puts in artifact names. */
export function artifactArch(id: PlatformId): string {
  return id.replace("_", "-");
}

export function expectedArtifactName(id: PlatformId, version: string, product: string): string {
  switch (id) {
    case "linux_x64":
    case "linux_arm64":
      return `${product.toLowerCase()}_${version}_amd64.deb`;
    default:
      return `${product}-${version}-${artifactArch(id)}`;
  }
}
