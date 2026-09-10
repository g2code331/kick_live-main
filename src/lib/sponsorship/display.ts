// The one display rule about sponsorships that is worth testing on its own lives here rather than inside a
// component, because `node --test` type-strips `.ts` and does not compile JSX. `SponsorBadge` imports it and
// re-exports it, so the app still has one place to ask the question.

/**
 * True when the sponsorship's window has closed.
 *
 * A sponsorship whose `ends_at` is in the past renders nothing even if its `status` is still `active`: the
 * status column is the desk's decision and `ends_at` is the promise made to a reader, and on the public side
 * the promise wins. That is also why the check is kept here rather than trusted to the server's cache — an
 * answer that is two minutes old can straddle midnight, and "expired sponsorships must not display as active"
 * is a sentence about what a fan sees, not about which cache it came from.
 *
 * A missing or unparseable `ends_at` means the agreement is open-ended, so it is not expired. The comparison
 * is deliberately local-day (`T23:59:59`) to match the SQL, which compares `current_date > ends_at`.
 */
export function isExpired(endsAt: string | null | undefined, today: Date = new Date()): boolean {
  if (!endsAt) return false;
  const end = new Date(`${endsAt}T23:59:59`);
  if (Number.isNaN(end.getTime())) return false;
  return end.getTime() < today.getTime();
}
