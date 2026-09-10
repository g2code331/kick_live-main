import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handshake, Image as ImageIcon, Loader2, Plus, RefreshCw, Save, Search, ShieldCheck, Eye } from "lucide-react";
import { fieldErrors, isApiFailure, type ApiResult } from "../../../lib/api/index.ts";
import {
  admin,
  invalidateSponsorship,
  SPONSOR_TARGET_KINDS,
  type PackageRow,
  type SponsorBandEntry,
  type SponsorRow,
  type SponsorshipRow,
  type SponsorTargetKind,
} from "../../../lib/data/sponsorship.ts";
import { uploadSponsorBranding, isMediaUploadError } from "../../../lib/media/upload.ts";
import SponsorBadge from "../../../components/SponsorBadge.tsx";

/**
 * The sponsorship desk (Phase 8).
 *
 * Three lists and one form each — sponsors, packages, assignments — because that is the whole model: *who*,
 * *what they bought*, *where and when*. The form does not attempt to be clever about any of it:
 *
 *  - **Status is a separate action from saving, always.** `kicklive_sponsor_save` refuses a `status` key and
 *    `kicklive_sponsor_set_status` stamps who did it, so this screen has no way to "helpfully" approve a
 *    sponsor inside an edit. The buttons a sponsor row shows are read from `GET /sponsorship/admin/transitions`
 *    — the same table the database consulted — rather than being duplicated here as a list of ifs.
 *  - **The preview is the server's answer, not the form's.** The card on the right renders `SponsorBadge` from
 *    the live band read, so what an operator sees is what a fan would get, including "nothing" when the window
 *    is closed or the sponsor is not approved. A preview built out of the form state would be a lie with a
 *    nicer font.
 *  - **The audit trail is the database's.** This screen does not write to `activity_logs`: `sponsors` carries
 *    `created_by`/`approved_by`/`approved_at` and `sponsorships` carries `activated_by`/`activated_at` plus the
 *    refusal in `activation_error`, all stamped from the caller's own JWT inside SQL. A client-side log line
 *    that could be skipped is not an audit trail.
 *
 * Contact details and money are shown here because the desk has to phone and invoice; the same screen never
 * renders them into a public component, and `SponsorBadge`'s props cannot accept them (its type is the public
 * projection).
 */
type DeskTab = "sponsors" | "packages" | "assignments";

const inputClass = "w-full rounded-xl bg-white/[0.04] border border-white/10 px-3 py-2 text-sm outline-none focus:border-brand-green/60";
const labelClass = "block text-[10px] font-black uppercase tracking-[0.18em] text-white/40 mb-1";
const btn = "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black uppercase tracking-widest transition";
const btnPrimary = `${btn} bg-[#39FF14] text-black hover:bg-[#39FF14]/85 disabled:opacity-40`;
const btnGhost = `${btn} border border-white/10 text-white/70 hover:text-white hover:bg-white/5`;

interface Notice {
  tone: "ok" | "bad";
  text: string;
  fields?: Record<string, string>;
}

/** `POST` refusals are field errors, so surface them on the field rather than as prose — the alternative is
 *  an admin reading a sentence and guessing which box to fix. */
function noticeFrom(result: ApiResult<unknown>, okText: string): Notice {
  if (isApiFailure(result)) {
    return { tone: "bad", text: result.message, fields: fieldErrors(result) };
  }
  return { tone: "ok", text: okText };
}

export default function SponsorshipManager() {
  const [tab, setTab] = useState<DeskTab>("sponsors");
  return (
    <div className="space-y-6">
      <header className="glass rounded-[2rem] p-6 border border-white/10">
        <div className="flex flex-wrap items-center gap-3">
          <Handshake size={22} className="text-brand-green" />
          <h2 className="text-xl font-black uppercase">Sponsorship</h2>
          <span className="ml-auto text-[10px] font-black uppercase tracking-[0.2em] text-white/35">rights, not ad slots</span>
        </div>
        <p className="mt-2 text-sm text-white/55 max-w-3xl">
          Sponsors, packages and what has been sold against which competition, season, team, match, award or event. Advertising is a
          separate system on purpose; the only link is a nullable id on an assignment.
        </p>
        <nav className="mt-4 flex gap-1">
          {(["sponsors", "packages", "assignments"] as DeskTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`${btn} ${tab === t ? "bg-white/10 text-white" : "text-white/50 hover:text-white"}`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      {tab === "sponsors" ? <SponsorsDesk /> : null}
      {tab === "packages" ? <PackagesDesk /> : null}
      {tab === "assignments" ? <AssignmentsDesk /> : null}
    </div>
  );
}

// ── sponsors ─────────────────────────────────────────────────────────────────

function SponsorsDesk() {
  const [rows, setRows] = useState<SponsorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({ displayName: "", legalName: "", websiteUrl: "", contactName: "", contactEmail: "", contactPhone: "", brandColour: "", onDark: true });
  const [editing, setEditing] = useState<string | null>(null);
  const arcs = useTransitions("sponsor");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await admin.sponsors(q ? { q, limit: 50 } : { limit: 50 });
    setLoading(false);
    if (!isApiFailure(res)) setRows((res.data as { sponsors: SponsorRow[] }).sponsors ?? []);
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const body: Record<string, unknown> = { ...draft };
    if (editing) body.id = editing;
    for (const key of ["brandColour", "websiteUrl", "legalName", "contactName", "contactEmail", "contactPhone"]) {
      if (body[key] === "") delete body[key];
    }
    if (typeof body.defaultPriority === "string" && (body.defaultPriority as string) === "") delete body.defaultPriority;
    const res = await admin.saveSponsor(body);
    setNotice(noticeFrom(res, editing ? "Sponsor saved." : "Sponsor created as a draft — approve it on its row."));
    if (!isApiFailure(res)) {
      setEditing(null);
      setDraft({ displayName: "", legalName: "", websiteUrl: "", contactName: "", contactEmail: "", contactPhone: "", brandColour: "", onDark: true });
      void load();
      invalidateSponsorship();
    }
  };

  const setStatus = async (id: string, status: string) => {
    const reason = status === "suspended" || status === "archived" ? window.prompt("Why? This is stored with the transition.") ?? "" : "";
    const res = await admin.sponsorStatus(id, status, reason || null);
    setNotice(noticeFrom(res, `Marked ${status}.`));
    if (!isApiFailure(res)) void load();
    invalidateSponsorship();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <section className="glass rounded-[2rem] p-5 border border-white/10">
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <input className={`${inputClass} pl-8`} placeholder="Search sponsors" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button type="button" className={btnGhost} onClick={() => void load()}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <ul className="space-y-2 max-h-[520px] overflow-auto pr-1">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="text-left"
                  onClick={() => {
                    setEditing(row.id);
                    setDraft({
                      displayName: row.display_name ?? "",
                      legalName: row.legal_name ?? "",
                      websiteUrl: row.website_url ?? "",
                      contactName: row.contact_name ?? "",
                      contactEmail: row.contact_email ?? "",
                      contactPhone: row.contact_phone ?? "",
                      brandColour: row.brand_colour ?? "",
                      onDark: row.on_dark !== false,
                    });
                  }}
                >
                  <p className="font-bold text-sm">{row.display_name}</p>
                  <p className="text-[11px] text-white/40">/{row.slug} · {row.status}{row.contact_email ? ` · ${row.contact_email}` : ""}</p>
                </button>
                <div className="ml-auto flex flex-wrap gap-1">
                  {(arcs.get(row.status) ?? []).map((to) => (
                    <button key={to} type="button" className={`${btn} border border-white/10 text-white/60 hover:text-white`} onClick={() => void setStatus(row.id, to)}>
                      {to}
                    </button>
                  ))}
                </div>
              </div>
              <BrandingUpload sponsorId={row.id} logoUrl={row.logo_url} bannerUrl={row.banner_url} onDone={() => { void load(); invalidateSponsorship(); }} />
            </li>
          ))}
          {rows.length === 0 && !loading ? <li className="text-sm text-white/35 py-6 text-center">No sponsors yet.</li> : null}
        </ul>
      </section>

      <section className="glass rounded-[2rem] p-5 border border-white/10 space-y-3">
        <h3 className="text-sm font-black uppercase tracking-widest">{editing ? "Edit sponsor" : "New sponsor"}</h3>
        {(["displayName", "legalName", "websiteUrl", "contactName", "contactEmail", "contactPhone", "brandColour"] as const).map((key) => (
          <label key={key} className="block">
            <span className={labelClass}>{key.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
            <input className={inputClass} value={String(draft[key] ?? "")} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
            {notice?.fields?.[key] ? <span className="text-[11px] text-red-300">{notice.fields[key]}</span> : null}
          </label>
        ))}
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={draft.onDark === true} onChange={(e) => setDraft({ ...draft, onDark: e.target.checked })} />
          logo is cut for dark backgrounds
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            <Save size={14} /> {editing ? "save" : "create"}
          </button>
          {editing ? (
            <button type="button" className={btnGhost} onClick={() => { setEditing(null); setDraft({ displayName: "", legalName: "", websiteUrl: "", contactName: "", contactEmail: "", contactPhone: "", brandColour: "", onDark: true }); }}>
              cancel
            </button>
          ) : null}
          <span className="text-[10px] text-white/35 leading-tight">
            <ShieldCheck size={12} className="inline mr-1" />
            contacts and prices never leave this list
          </span>
        </div>
        {notice ? <p className={`text-xs ${notice.tone === "ok" ? "text-brand-green" : "text-red-300"}`}>{notice.text}</p> : null}
        <p className="text-[11px] text-white/35 leading-relaxed">
          The slug is derived from the display name on create and immutable afterwards, because it is a URL and a cache key. Approval lives on the row, not
          in this form.
        </p>
      </section>
    </div>
  );
}

/** The two slots a sponsor has. Uploaded through the sponsorship route, which reserves the key in the
 *  sponsor's own prefix and then attaches it — never a URL pasted into a field. */
function BrandingUpload({ sponsorId, logoUrl, bannerUrl, onDone }: { sponsorId: string; logoUrl: string | null; bannerUrl: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refs = { logo: useRef<HTMLInputElement>(null), banner: useRef<HTMLInputElement>(null) };

  const pick = async (slot: "logo" | "banner") => {
    const file = refs[slot].current?.files?.[0];
    if (!file) return;
    setBusy(slot);
    setError(null);
    try {
      await uploadSponsorBranding({ sponsorId, slot, file, alt: null });
      onDone();
    } catch (err) {
      setError(isMediaUploadError(err) ? `${err.code}: ${err.reason ?? err.message}` : "The upload failed.");
    } finally {
      setBusy(null);
      refs[slot].current!.value = "";
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-white/45">
      {(["logo", "banner"] as const).map((slot) => (
        <label key={slot} className="inline-flex items-center gap-1 cursor-pointer hover:text-white">
          <ImageIcon size={12} />
          <span className="uppercase tracking-widest">{slot}</span>
          <input ref={refs[slot]} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={() => void pick(slot)} disabled={busy === slot} />
          {busy === slot ? <Loader2 size={12} className="animate-spin" /> : <span className={slot === "logo" && logoUrl ? "text-brand-green" : slot === "banner" && bannerUrl ? "text-brand-green" : "text-white/25"}>{slot === "logo" ? (logoUrl ? "set" : "none") : bannerUrl ? "set" : "none"}</span>}
        </label>
      ))}
      {error ? <span className="text-red-300">{error}</span> : null}
    </div>
  );
}

// ── packages ───────────────────────────────────────────────────────────────

function PackagesDesk() {
  const [rows, setRows] = useState<PackageRow[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [draft, setDraft] = useState<Record<string, string | boolean | number>>({ code: "", label: "", kind: "match", tier: 3, sortOrder: 100, description: "" });
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await admin.packages({ limit: 100 });
    if (!isApiFailure(res)) setRows((res.data as { packages: PackageRow[] }).packages ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const res = await admin.savePackage({ ...draft, id: editing ?? undefined });
    setNotice(noticeFrom(res, "Package saved."));
    if (!isApiFailure(res)) {
      setEditing(null);
      void load();
      invalidateSponsorship();
    }
  };

  const toggle = async (row: PackageRow) => {
    const res = await admin.savePackage({ id: row.id, isActive: !(row.isActive !== false) });
    setNotice(noticeFrom(res, row.isActive !== false ? "Package retired — new assignments will be refused." : "Package reactivated."));
    if (!isApiFailure(res)) void load();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
      <section className="glass rounded-[2rem] p-5 border border-white/10">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-black uppercase tracking-widest">Packages</h3>
          <span className="text-[10px] text-white/35">names are data — a new kind of deal is a row, not a migration</span>
          <button type="button" className={`${btnGhost} ml-auto`} onClick={() => void load()}>
            <RefreshCw size={13} />
          </button>
        </div>
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-black uppercase tracking-widest text-xs">{row.label}</span>
                <code className="text-[11px] text-white/40">{row.code}</code>
                <span className="text-[11px] text-white/30">tier {row.tier} · {row.exclusivity}</span>
                <span className="ml-auto text-[11px] text-white/40">{(row.allowedTargetKinds ?? []).join(", ")}</span>
                <button type="button" className={btnGhost} onClick={() => { setEditing(row.id); setDraft({ code: row.code, label: row.label, kind: row.kind, tier: row.tier, sortOrder: row.sortOrder, description: row.description ?? "", priceAmount: row.priceAmount ?? "", priceCurrency: row.priceCurrency ?? "", priceBasis: row.priceBasis ?? "" }); }}>
                  edit
                </button>
                <button type="button" className={btnGhost} onClick={() => void toggle(row)}>
                  {row.isActive !== false ? "retire" : "activate"}
                </button>
              </div>
              {row.description ? <p className="mt-1 text-[11px] text-white/40">{row.description}</p> : null}
              {row.priceAmount != null ? <p className="mt-1 text-[11px] text-white/30">desk price {String(row.priceAmount)} {row.priceCurrency ?? ""} {row.priceBasis ? `(${row.priceBasis})` : ""} — never in the public rate card</p> : null}
            </li>
          ))}
        </ul>
      </section>
      <section className="glass rounded-[2rem] p-5 border border-white/10 space-y-3">
        <h3 className="text-sm font-black uppercase tracking-widest">{editing ? "Edit package" : "New package"}</h3>
        {(["code", "label", "kind", "tier", "sortOrder"] as const).map((key) => (
          <label key={key} className="block">
            <span className={labelClass}>{key}</span>
            <input className={inputClass} value={String(draft[key] ?? "")} onChange={(e) => setDraft({ ...draft, [key]: key === "tier" || key === "sortOrder" ? Number(e.target.value) : e.target.value })} />
          </label>
        ))}
        <label className="block">
          <span className={labelClass}>description</span>
          <textarea className={`${inputClass} min-h-[72px]`} value={String(draft.description ?? "")} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
        {editing ? (
          <p className="text-[11px] text-white/35">The code is immutable once assignments point at it; retire the package and create a new one instead.</p>
        ) : null}
        <button type="button" className={btnPrimary} onClick={() => void save()}>
          <Save size={14} /> {editing ? "save" : "create"}
        </button>
        {notice ? <p className={`text-xs ${notice.tone === "ok" ? "text-brand-green" : "text-red-300"}`}>{notice.text}</p> : null}
      </section>
    </div>
  );
}

// ── assignments ──────────────────────────────────────────────────────────────

function AssignmentsDesk() {
  const [rows, setRows] = useState<SponsorshipRow[]>([]);
  const [sponsors, setSponsors] = useState<SponsorRow[]>([]);
  const [packages, setPackages] = useState<PackageRow[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<{ kind: SponsorTargetKind; id: string } | null>(null);
  const [draft, setDraft] = useState({ sponsorId: "", packageId: "", targetKind: "match" as SponsorTargetKind, targetId: "", startsAt: "", endsAt: "", attribution: "", priority: "" });
  const arcs = useTransitions("sponsorship");

  const load = useCallback(async () => {
    const [list, sp, pk] = await Promise.all([admin.assignments({ limit: 100, includeExpired: true }), admin.sponsors({ limit: 200 }), admin.packages({ limit: 100 })]);
    if (!isApiFailure(list)) setRows((list.data as { sponsorships: SponsorshipRow[] }).sponsorships ?? []);
    if (!isApiFailure(sp)) setSponsors((sp.data as { sponsors: SponsorRow[] }).sponsors ?? []);
    if (!isApiFailure(pk)) setPackages((pk.data as { packages: PackageRow[] }).packages ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const body: Record<string, unknown> = {
      sponsorId: draft.sponsorId,
      packageId: draft.packageId,
      targetKind: draft.targetKind,
      targetId: draft.targetId,
      attribution: draft.attribution || undefined,
      // No `isActive`: a new assignment is saved as a draft and then activated, and "displayed" is the
      // switch on the row, which goes through the status door so the change has an author.
    };
    if (draft.startsAt) body.startsAt = draft.startsAt;
    if (draft.endsAt) body.endsAt = draft.endsAt;
    if (draft.priority) body.priority = Number(draft.priority);
    const res = await admin.saveAssignment(body);
    setNotice(noticeFrom(res, "Assignment saved as a draft. Activate it when the paperwork is signed."));
    if (!isApiFailure(res)) {
      void load();
      invalidateSponsorship({ kind: draft.targetKind, id: draft.targetId });
    }
  };

  const setStatus = async (row: SponsorshipRow, status: string) => {
    const res = await admin.assignmentStatus(row.id, status, { isActive: status === "active" ? true : status === "paused" ? false : undefined });
    setNotice(noticeFrom(res, `${row.sponsor?.display_name ?? "Sponsorship"} → ${status}`));
    if (!isApiFailure(res)) {
      void load();
      invalidateSponsorship({ kind: row.target_kind as SponsorTargetKind, id: row.target_id });
    }
  };

  const byId = useMemo(() => new Map(sponsors.map((s) => [s.id, s.display_name])), [sponsors]);
  const packageById = useMemo(() => new Map(packages.map((p) => [p.id, p.label])), [packages]);

  return (
    <div className="space-y-6">
      <section className="glass rounded-[2rem] p-5 border border-white/10">
        <h3 className="text-sm font-black uppercase tracking-widest mb-3">Assignments</h3>
        <ul className="space-y-2 max-h-[420px] overflow-auto pr-1">
          {rows.map((row) => {
            const expired = row.ends_at < new Date().toISOString().slice(0, 10);
            return (
              <li key={row.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 text-sm flex flex-wrap items-center gap-2">
                <span className="font-bold">{byId.get(row.sponsor_id) ?? row.sponsor_id}</span>
                <span className="text-[11px] text-white/45">{packageById.get(row.package_id) ?? "package"}</span>
                <code className="text-[11px] text-white/35">{row.target_kind}:{row.target_id}</code>
                <span className={`text-[11px] ${expired ? "text-amber-300" : "text-white/35"}`}>
                  {row.starts_at} → {row.ends_at}{expired ? " · window closed" : ""}
                </span>
                <span className="text-[11px] uppercase tracking-widest text-white/50">{row.status}{row.is_active ? "" : " · hidden"}</span>
                {row.activation_error ? <span className="text-[11px] text-red-300">{row.activation_error}</span> : null}
                <span className="ml-auto flex gap-1">
                  <button type="button" className={btnGhost} onClick={() => setPreview({ kind: row.target_kind as SponsorTargetKind, id: row.target_id })}>
                    <Eye size={12} /> preview
                  </button>
                  {(arcs.get(row.status) ?? []).map((to) => (
                    <button key={to} type="button" className={`${btn} border border-white/10 text-white/60 hover:text-white`} onClick={() => void setStatus(row, to)}>
                      {to}
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
          {rows.length === 0 ? <li className="text-sm text-white/35 py-6 text-center">Nothing sold yet.</li> : null}
        </ul>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="glass rounded-[2rem] p-5 border border-white/10 space-y-3">
          <h3 className="text-sm font-black uppercase tracking-widest">New assignment</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 block">
              <span className={labelClass}>sponsor</span>
              <select className={inputClass} value={draft.sponsorId} onChange={(e) => setDraft({ ...draft, sponsorId: e.target.value })}>
                <option value="">— choose —</option>
                {sponsors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name} ({s.status})
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 block">
              <span className={labelClass}>package</span>
              <select className={inputClass} value={draft.packageId} onChange={(e) => setDraft({ ...draft, packageId: e.target.value })}>
                <option value="">— choose —</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {p.allowedTargetKinds?.join("/") ?? ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>target kind</span>
              <select className={inputClass} value={draft.targetKind} onChange={(e) => setDraft({ ...draft, targetKind: e.target.value as SponsorTargetKind })}>
                {SPONSOR_TARGET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>target id</span>
              <input className={inputClass} value={draft.targetId} onChange={(e) => setDraft({ ...draft, targetId: e.target.value })} placeholder="12" />
            </label>
            <label className="block">
              <span className={labelClass}>starts</span>
              <input type="date" className={inputClass} value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />
            </label>
            <label className="block">
              <span className={labelClass}>ends</span>
              <input type="date" className={inputClass} value={draft.endsAt} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />
            </label>
            <label className="block">
              <span className={labelClass}>priority (lower leads)</span>
              <input type="number" min={1} max={9999} className={inputClass} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} />
            </label>
            <label className="block">
              <span className={labelClass}>attribution</span>
              <input className={inputClass} value={draft.attribution} onChange={(e) => setDraft({ ...draft, attribution: e.target.value })} placeholder="Presented by …" />
            </label>
          </div>
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            <Plus size={14} /> assign
          </button>
          {notice ? <p className={`text-xs ${notice.tone === "ok" ? "text-brand-green" : "text-red-300"}`}>{notice.text}</p> : null}
          <p className="text-[11px] text-white/35">
            Exclusivity, per-target limits and a duplicate window are refused by name by the database — the message above is that refusal, verbatim.
          </p>
        </section>

        <section className="glass rounded-[2rem] p-5 border border-white/10">
          <h3 className="text-sm font-black uppercase tracking-widest mb-3">What a fan sees on that target</h3>
          {preview ? (
            <div className="space-y-3">
              <p className="text-[11px] text-white/40">
                <code>{preview.kind}:{preview.id}</code> · read from the live public band, not from this form
              </p>
              <SponsorBandPreview kind={preview.kind} id={preview.id} />
            </div>
          ) : (
            <p className="text-sm text-white/35">Choose “preview” on a row to see the band exactly as the public read returns it.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/** The preview is the public component, fed by the public query. It is deliberately not a re-implementation:
 *  if the band and the preview ever disagree, the band is right, and this is where that would show. */
function SponsorBandPreview({ kind, id }: { kind: SponsorTargetKind; id: string }) {
  const [band, setBand] = useState<SponsorBandEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    void admin.preview([{ kind, id }]).then((res) => {
      if (!alive) return;
      if (isApiFailure(res)) {
        setFailed(true);
        return;
      }
      // `POST /sponsorship/admin/preview` answers one entry per target, each carrying the same `sponsors`
      // list the public read returns. Flattening here is a display choice, not a second source of truth.
      const results = (res.data as { results?: { sponsors?: SponsorBandEntry[] }[] }).results ?? [];
      setBand(results.flatMap((r) => r.sponsors ?? []));
    });
    return () => {
      alive = false;
    };
  }, [kind, id]);

  if (failed) return <p className="text-xs text-red-300">The preview could not be read.</p>;
  if (!band) return <p className="text-xs text-white/35">Loading…</p>;
  if (band.length === 0)
    return (
      <p className="text-xs text-white/40">
        Nothing is displaying on this target right now. The most common reasons are a window that has closed, a sponsor still in draft, or the row not being
        activated yet — and the row above shows which.
      </p>
    );
  return (
    <ul className="space-y-2">
      {band.map((entry) => (
        <li key={entry.sponsorshipId}>
          <SponsorBadge entry={entry} />
        </li>
      ))}
    </ul>
  );
}

/** The allowed next statuses, straight from `sponsorship_status_transitions`. A UI that hardcodes the flow is
 *  a UI that offers a button the database will refuse. */
function useTransitions(kind: "sponsor" | "sponsorship"): Map<string, string[]> {
  const [arcs, setArcs] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    let alive = true;
    void admin.transitions(kind).then((res) => {
      if (!alive || isApiFailure(res)) return;
      const rows = ((res.data as { transitions?: { from: string; to: string }[] }).transitions ?? []) as { from: string; to: string }[];
      const map = new Map<string, string[]>();
      for (const row of rows) map.set(row.from, [...(map.get(row.from) ?? []), row.to]);
      setArcs(map);
    });
    return () => {
      alive = false;
    };
  }, [kind]);
  return arcs;
}
