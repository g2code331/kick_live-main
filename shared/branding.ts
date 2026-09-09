/**
 * Single source of truth for KickLive branding.
 *
 * `scripts/branding.mjs` derives every *branded surface* (packaging/linux/kicklive.desktop,
 * public/site.webmanifest, index.html title/meta, package.json name/productName) from this file
 * and `check` mode fails if any of them drifted. Keep this file dependency-free: it is imported
 * by the browser bundle, the Electron main process and plain `node --test` files.
 */

export type BrandColors = {
  readonly bg: string;
  readonly surface: string;
  readonly green: string;
  readonly blue: string;
  readonly red: string;
  readonly purple: string;
  readonly orange: string;
};

export type IconSpec = {
  /** file name, relative to the icon output directory */
  readonly file: string;
  readonly size: number;
  readonly purpose: "any" | "maskable" | "any maskable";
};

export const BRAND = {
  /** lowercase identifier: npm package name, deb package name, bin name, X11 instance name */
  id: "kicklive",
  /** human product name, used by the window manager, the .desktop file and electron-builder */
  productName: "KickLive",
  /** what a user reads in a title bar / store listing */
  displayName: "KickLive",
  tagline: "Premium football live scores & tournament manager",
  /**
   * WM_CLASS *and* the .desktop StartupWMClass. Both are lowercase by design: electron-builder
   * derives StartupWMClass from `desktopName` in package.json (minus the suffix), and Electron
   * derives app_id from the same field, so all three must be `kicklive` for the DE to link a
   * running window to the installed launcher.
   */
  wmClass: "kicklive",
  /** where the deb unpacks to: electron-builder's installPrefix + sanitizedProductName */
  installDir: "/opt/KickLive",
  desktopFile: "kicklive.desktop",
  /** freedesktop desktop entry `Name=` (localised marketing name) */
  desktopEntryName: "KickLive",
  appUserModelId: "com.kicklive.desktop",
  reverseDomain: "com.kicklive",
  maintainer: "KickLive <packaging@kicklive.example>",
  homepage: "https://github.com/g2code331/kick_live-main",
  bugReports: "https://github.com/g2code331/kick_live-main/issues",
  license: "UNLICENSED",
  copyright: "Copyright 2026 KickLive",
  /** PWA start_url: the app uses HashRouter, so "/" is enough */
  startUrl: "/",
  scope: "/",
  /** Icons that must exist both in public/ (PWA) and packaging/icons/ (Linux). */
  iconSizes: [16, 24, 32, 48, 64, 96, 128, 256, 512] as const,
  masterIcon: "public/kicklive-icon.png",
  logo: "public/kicklive-logo.png",
  linuxCategories: "Network;Sports;Game;",
  linuxCategory: "Network;Sports;Game;",
  linuxDescription: "KickLive - premium football live scores, standings, predictions and tournament management.",
  linuxKeywords: "football,soccer,live scores,tournament,predictions;",
  colors: {
    bg: "#0B0E13",
    surface: "#161B22",
    green: "#39FF14",
    blue: "#00D4FF",
    red: "#FF0055",
    purple: "#FF00D4",
    orange: "#FF8C00",
  } satisfies BrandColors,
  /** Names that must never appear in a branded surface (scaffolding leftovers / wrong casing). */
  forbiddenNames: ["react-vite-tailwind", "Vite + React + TS", "My App", "KICK live", "kLIVE"] as readonly string[],
  /** Files that the branding check treats as branded surfaces (tight on purpose). */
  brandedSurfaces: ["package.json", "index.html", "public/site.webmanifest", "packaging/linux/kicklive.desktop", "electron-builder.yml", "desktop/src/main.ts"] as readonly string[],
  /** Hosts the renderer legitimately talks to; used to build the CSP. */
  csp: {
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "blob:", "https:"],
    connectSrc: ["'self'", "https:", "wss:", "ws:"],
    manifestSrc: ["'self'"],
    workerSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
  },
} as const;

export type Brand = typeof BRAND;

/** `#39FF14` style → used by the CSP/theme-color helpers. */
export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function pwaIconSpecs(): IconSpec[] {
  return [
    { file: "web-app-manifest-192x192.png", size: 192, purpose: "any" },
    { file: "web-app-manifest-192x192-any.png", size: 192, purpose: "any" },
    { file: "web-app-manifest-512x512.png", size: 512, purpose: "any" },
    { file: "web-app-manifest-512x512-any.png", size: 512, purpose: "any" },
  ];
}

/** electron-builder expects `<size>x<size>.png` file names in the icon directory. */
export function linuxIconSpecs(): IconSpec[] {
  return BRAND.iconSizes.map((size) => ({
    file: `${String(size)}x${String(size)}.png`,
    size,
    purpose: "any" as const,
  }));
}

/** Where the .deb installs each icon (electron-builder maps the icon dir into hicolor). */
export function hicolorPath(size: number): string {
  return `usr/share/icons/hicolor/${String(size)}x${String(size)}/apps/${BRAND.id}.png`;
}

export function cspHeader(): string {
  const c = BRAND.csp;
  const parts = [
    `default-src 'self'`,
    `script-src ${c.scriptSrc.join(" ")}`,
    `style-src ${c.styleSrc.join(" ")}`,
    `font-src ${c.fontSrc.join(" ")}`,
    `img-src ${c.imgSrc.join(" ")}`,
    `connect-src ${c.connectSrc.join(" ")}`,
    `manifest-src ${c.manifestSrc.join(" ")}`,
    `worker-src ${c.workerSrc.join(" ")}`,
    `object-src ${c.objectSrc.join(" ")}`,
    `base-uri ${c.baseUri.join(" ")}`,
    `frame-ancestors ${c.frameAncestors.join(" ")}`,
  ];
  return parts.join("; ") + ";";
}

/**
 * The *expected* `[Desktop Entry]`, emitted in the same key order electron-builder uses
 * (base keys, then `linux.desktop.entry` extras, then Comment/MimeType/Categories) so
 * `scripts/verify-packaging.mjs` can compare it against the file actually installed in the .deb.
 * Keys the packager does not write (Version, GenericName, NoDisplay) are deliberately absent: a
 * subset comparison only works if the expectation contains nothing the packager cannot produce.
 */
export function renderDesktopFile(version: string): string {
  return [
    "[Desktop Entry]",
    `Name=${BRAND.desktopEntryName}`,
    `Exec=${BRAND.installDir}/${BRAND.id} %U`,
    "Terminal=false",
    "Type=Application",
    `Icon=${BRAND.id}`,
    `StartupWMClass=${BRAND.wmClass}`,
    "StartupNotify=true",
    `X-KickLive-Version=${version}`,
    `X-KickLive-Feed=${BRAND.homepage}/releases`,
    `Comment=${BRAND.linuxDescription}`,
    `MimeType=x-scheme-handler/${BRAND.id};`,
    `Categories=${BRAND.linuxCategories}`,
    "",
  ].join("\n");
}

export function renderWebManifest(version: string): string {
  const icons = [
    { size: 192, purpose: "any", file: "web-app-manifest-192x192.png" },
    { size: 512, purpose: "any", file: "web-app-manifest-512x512.png" },
    { size: 192, purpose: "maskable", file: "web-app-manifest-192x192-any.png" },
    { size: 512, purpose: "maskable", file: "web-app-manifest-512x512-any.png" },
    { size: 96, purpose: "any", file: "favicon-96x96.png" },
  ];
  const manifest = {
    id: BRAND.startUrl,
    name: BRAND.displayName,
    short_name: BRAND.id.charAt(0).toUpperCase() + BRAND.id.slice(1),
    description: BRAND.tagline,
    version,
    lang: "en",
    dir: "ltr",
    start_url: BRAND.startUrl,
    scope: BRAND.scope,
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "any",
    theme_color: BRAND.colors.bg,
    background_color: BRAND.colors.bg,
    categories: ["sports", "news", "entertainment"],
    shortcuts: [
      {
        name: "Matches",
        short_name: "Matches",
        url: "/#/matches",
        description: "Live and upcoming matches",
      },
      {
        name: "Tables",
        short_name: "Tables",
        url: "/#/tables",
        description: "Standings",
      },
    ],
    // 128x128 favicon is declared with its real dimensions; asserting declared == actual is one
    // of the things the branding check exists for.
    icons: icons.map((i) => ({
      src: `/${i.file}`,
      sizes: `${i.size}x${i.size}`,
      type: "image/png",
      purpose: i.purpose,
    })),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}
