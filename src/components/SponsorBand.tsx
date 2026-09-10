import { useQuery } from "../lib/data/useResource.ts";
import { sponsorBand, type SponsorTargetKind } from "../lib/data/sponsorship.ts";
import SponsorBadge from "./SponsorBadge.tsx";

/**
 * `SponsorBand` — the reusable strip of who is sponsoring a thing.
 *
 * It takes a *target* (this match, this competition, this club) and nothing else: no names, no ordering, no
 * idea of what a "good" sponsor looks like. The order on screen is the order the database returned —
 * `priority`, then `display_order`, then the newer agreement — which is the desk's decision, made with a
 * form and a contract, not with a bid. There is no shuffle here and there never will be: a rotated band is
 * how a paid title placement becomes an accident.
 *
 * When there is nothing to show it renders *nothing at all*. Not a skeleton, not an empty bordered box, not
 * "No sponsors yet": a page in a competition nobody has sponsored yet should look exactly like a page that
 * has no sponsorship feature, because the feature is the exception and not the layout.
 */
export interface SponsorBandProps {
  kind: SponsorTargetKind;
  id: string | number;
  /** The most a screen will show. The server caps at 24 and orders; this only truncates. */
  max?: number;
  heading?: string | null;
  size?: "sm" | "md" | "lg";
  /** `row` for a match header, `wall` for a page whose subject *is* the partnership. */
  layout?: "row" | "wall";
  className?: string;
}

export default function SponsorBand({ kind, id, max = 6, heading = null, size = "md", layout = "row", className = "" }: SponsorBandProps) {
  const query = useQuery(sponsorBand, { kind, id }, { enabled: id !== undefined && id !== null && String(id).length > 0 });
  const all = query.data?.sponsors ?? [];
  if (all.length === 0) return null;
  const entries = all.slice(0, Math.max(1, Math.min(24, max)));

  if (layout === "wall") {
    return (
      <section className={`flex flex-col gap-3 ${className}`} aria-label={heading ?? "Sponsors"} data-sponsorship-count={entries.length}>
        {heading ? <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/50">{heading}</h2> : null}
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <li key={entry.sponsorshipId} className="flex">
              <SponsorBadge entry={entry} size={size} showLabel={false} className="w-full justify-center" />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className={`flex min-w-0 flex-wrap items-center gap-2 ${className}`} aria-label={heading ?? "Sponsors"} data-sponsorship-count={entries.length}>
      {heading ? <span className="mr-1 text-[10px] font-black uppercase tracking-[0.2em] text-white/40">{heading}</span> : null}
      {entries.map((entry) => (
        <SponsorBadge key={entry.sponsorshipId} entry={entry} size={size} />
      ))}
    </section>
  );
}
