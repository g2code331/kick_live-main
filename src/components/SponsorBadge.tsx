import { assetUrl } from "../lib/media/assets.ts";
import { isExpired } from "../lib/sponsorship/display.ts";
import type { SponsorBandEntry } from "../lib/data/sponsorship.ts";

/**
 * `SponsorBadge` — one sponsor, rendered the same way on every screen.
 *
 * Three things this component is responsible for, and the rest belongs to the server:
 *
 *  - **It never decides visibility.** The band it renders came from `kicklive_sponsorship_for`, which already
 *    required an active status, an approved sponsor, an active package and today inside the window. The one
 *    check it does make is the expiry: a cached answer whose window has since closed is not rendered,
 *    because "expired sponsorships must not display as active" is a promise to a reader, and a promise you
 *    keep does not depend on whose cache it was.
 *  - **It has no sponsor names in it.** Not one. A brand is data (`sponsors.display_name`), and the moment a
 *    `case "betway"` appears in a component the sponsorship desk can no longer add a partner without a
 *    deploy. Every string here is read off the entry.
 *  - **It cannot render a private field by accident.** `SponsorBandEntry` is the public projection; the
 *    contact block and the money columns do not exist in its type, so there is nothing to accidentally
 *    interpolate. That is a type-level statement, and `tests/unit/phase8-sponsorship.test.ts` checks it
 *    against the SQL projection so the two cannot drift apart.
 */
export type SponsorBadgeSize = "sm" | "md" | "lg";

const SIZE: Record<SponsorBadgeSize, { box: string; logo: string; text: string; gap: string }> = {
  sm: { box: "h-10 px-2", logo: "h-6 max-w-[84px]", text: "text-[10px]", gap: "gap-1.5" },
  md: { box: "h-14 px-3", logo: "h-8 max-w-[132px]", text: "text-xs", gap: "gap-2" },
  lg: { box: "h-20 px-4", logo: "h-12 max-w-[190px]", text: "text-sm", gap: "gap-3" },
};

export interface SponsorBadgeProps {
  entry: SponsorBandEntry;
  size?: SponsorBadgeSize;
  /** "Sponsor" | "Partner" | nothing. A page that already says *Official Partner of the Cup* above the band
   *  should not repeat it sixty times; the label is the host's, and the attribution is the sponsor's. */
  showLabel?: boolean;
  className?: string;
}

/** A stored `/api/media/assets/...` path or a legacy absolute URL — `assetUrl()` is the only resolver the app
 *  uses, so a badge renders exactly like a club crest does. Empty string means "no artwork", which the
 *  component already has a fallback for; `assetUrl` answers `undefined` for a value it will not touch, and
 *  collapsing the two here keeps every call site a plain truthiness test. */
const resolve = (url: string | null | undefined): string => assetUrl((url ?? "").trim() || undefined) ?? "";

// The expiry rule lives in `src/lib/sponsorship/display.ts` so it can be unit-tested without compiling JSX,
// and so a second surface (an admin preview, an email) asks the same question the same way. It is re-exported
// here because this component is where a reader expects to find it.
export { isExpired } from "../lib/sponsorship/display.ts";

export default function SponsorBadge({ entry, size = "md", showLabel = true, className = "" }: SponsorBadgeProps) {
  if (isExpired(entry.endsAt)) return null;

  const s = SIZE[size];
  const logo = resolve(entry.logoUrl);
  const dark = entry.onDark !== true;
  const label = entry.attribution?.trim() || entry.packageLabel;
  const name = entry.name || entry.slug;

  const body = (
    <span className={`inline-flex items-center ${s.gap} rounded-md border ${dark ? "border-white/10 bg-white/[0.04]" : "border-black/10 bg-black/[0.03]"} ${s.box}`}>
      {logo ? (
        <img
          src={logo}
          alt={name}
          loading="lazy"
          decoding="async"
          className={`${s.logo} w-auto object-contain`}
          style={entry.brandColour ? { filter: `drop-shadow(0 0 0 ${entry.brandColour})` } : undefined}
        />
      ) : (
        // A sponsor with no uploaded artwork still holds the rights, and an empty box would read as a broken
        // image. The wordmark is the fallback: named by the sponsor, styled by the page.
        <span className={`${s.text} font-black uppercase tracking-[0.14em] ${dark ? "text-white/80" : "text-black/70"}`} style={entry.brandColour ? { color: entry.brandColour } : undefined}>
          {name}
        </span>
      )}
      {showLabel && logo ? (
        <span className={`${s.text} ${dark ? "text-white/55" : "text-black/50"} whitespace-nowrap`}>
          {label}
          {entry.namingOverride ? ` · ${entry.namingOverride}` : ""}
        </span>
      ) : null}
    </span>
  );

  // `href` is present only when the sponsor's link passed the same https rule the write path enforces, and it
  // is re-checked on read. `sponsored` rides along because a paid placement that is not marked as one is a
  // problem for the sponsor, not just for us.
  if (entry.href) {
    return (
      <a href={entry.href} rel={`${entry.rel || "noopener external"} sponsored`} target="_blank" className={`no-underline ${className}`} data-sponsor-slug={entry.slug}>
        {body}
      </a>
    );
  }
  return <span className={`inline-flex ${className}`} data-sponsor-slug={entry.slug}>{body}</span>;
}
