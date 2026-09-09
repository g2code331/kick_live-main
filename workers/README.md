# `workers/` — the API layer that is planned, not yet running

**Status: Phase 1 architecture only.** This directory defines boundaries, the route map, config
shape and the authorisation model. Every route returns `501 Not Implemented` with a pointer to the
phase that fills it in. Nothing in `src/` calls this Worker yet; the app still talks to Supabase
directly and that is still how production works today.

The point of writing it now is that the _contract_ gets reviewed before the endpoints do: what the
browser is allowed to send, what the Worker is allowed to trust, and where a decision is made.

## Where each responsibility lives

| Concern                                                                 | Lives in                                                                    | Explicitly not in                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| UI, routing, forms, optimistic state                                    | `src/` (Vite SPA → Cloudflare Pages; also the Electron renderer)            | —                                                                            |
| Auth _provider_                                                         | Supabase Auth (unchanged: same JWTs the SPA already holds)                  | a second user system, a session cookie store                                 |
| Authorisation (who may read/write which row)                            | **Postgres RLS**, then the Worker on top of it                              | the browser (`profile.role` is UX only), a client-side password map          |
| Writes that need a business rule (match control, approvals, publishing) | Worker route → Postgres, service-role client                                | direct `supabase.from(...).update(...)` from a browser                       |
| Live match state (per-match clock, event stream, multi-operator room)   | Durable Object, one instance per `match_id`, Phase 3                        | polling `setInterval` in every open tab (today's 19 call sites)              |
| Background jobs (standings recompute, notification fan-out, imports)    | Workers Queues consumer, Phase 4                                            | `src/lib/MatchAutomation.ts` running in a browser tab                        |
| Push                                                                    | FCM/APNs behind one Worker route, Phase 5                                   | — (not implemented; `notifications` rows are today's only channel)           |
| Media files, thumbnails, signed uploads                                 | R2 + signed URLs, Phase 4                                                   | Supabase Storage (not used at all today), the repo (`public/` is icons only) |
| Relational truth (all 15 business tables)                               | **Supabase Postgres**                                                       | **D1** — see below                                                           |
| Edge protection                                                         | WAF rules, Turnstile (signup + writes), Cloudflare cache rules, rate limits | CORS as a security control                                                   |

### Why there is no `[[d1_databases]]`

D1 is a second Postgres. Putting match/standings data in D1 "because the Worker has it nearby" would
give the product two sources of truth and a sync job nobody can debug, and every future bug report
starts with "which one did you read?". Supabase stays authoritative; D1 is only appropriate later for
Worker-owned ephemeral state (rate-limit counters, idempotency keys, job status), and that would be a
separate, reviewed decision — not a mirror of `matches`.

`wrangler.toml` therefore ships with the D1 block commented out and a note on what it would be for.

## Request flow, once Phase 2 turns this on

```
browser (Supabase JWT in Authorization header)
  │
  ├─ Cloudflare edge: TLS, WAF, cache rules, Turnstile challenge on /v1/auth + /v1/match-control
  │
  ├─ Worker fetch
  │     1. request id, security headers, CORS allow-list (env, never *)
  │     2. rate limit (KV) — key = userId + route class, then IP
  │     3. auth.verifyAccessToken() → { userId, role }   ← signature + exp + iss/aud
  │     4. capabilities.require(role, capability)         ← the table in src/lib/capabilities.ts
  │     5. Turnstile token for destructive/anonymous routes
  │     6. handler: validate body → PostgREST/RLS as service_role → audit row
  │
  └─ Postgres (RLS still applies for service_role? No: service_role bypasses RLS, which is
     exactly why steps 3–4 and the audit insert exist in the Worker, and why the RLS hardening in
     supabase/migrations was done *first* — the direct-from-browser path stays safe while the
     Worker is being built.)
```

Two rules that survive every phase:

1. **The Worker re-derives identity from the JWT, never from a body field or a cookie.** A request
   claiming `"role": "admin"` in JSON is a client bug or an attack, and both get the same answer.
2. **RLS stays on.** A Worker bug then fails closed instead of exposing the table.

## Route map

Implemented by the phase named in the right column; `routes/index.ts` is where each one gets wired.

| Route                                                                         | Capability                 | Purpose                                                                                 | Phase            |
| ----------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `GET /v1/health`                                                              | —                          | liveness + build version, cached at the edge 60 s                                       | 2 (kept working) |
| `POST /v1/auth/sign-up`                                                       | —                          | replaces `supabase.auth.signUp` from the browser; Turnstile; always fan                 | 2                |
| `POST /v1/auth/access-requests`                                               | fan                        | queue a manager/media request (moves the RPC call server-side)                          | 2                |
| `GET /v1/matches?from&to&competition`                                         | public                     | cacheable fixture/score list, ETag, one row shape for all public pages                  | 2                |
| `GET /v1/matches/:id/stream`                                                  | public                     | SSE/WebSocket handoff to the match's Durable Object (replaces 19 poll loops)            | 3                |
| `POST /v1/matches/:id/events`                                                 | match_control              | one match event: validated, idempotent (`client_event_id`), ordered, audited            | 2                |
| `PUT /v1/matches/:id/state`                                                   | match_control              | clock/status/score transition, rejected when `is_locked`                                | 2                |
| `POST /v1/matches/:id/finalize`                                               | match_control              | locks the row, enqueues standings + notifications                                       | 2                |
| `GET /v1/teams/mine`                                                          | team_manager               | the caller's own club, resolved in SQL by `owner_id`                                    | 2                |
| `PATCH /v1/teams/:id`                                                         | team_manager\|admin        | profile/lineup/gallery, owner-checked server-side                                       | 2                |
| `POST /v1/players`                                                            | team_manager\|admin        | squad add                                                                               | 2                |
| `POST /v1/media` `PATCH /v1/media/:id` `POST /v1/media/:id/publish`           | media\|admin               | publishing with author set server-side (today `author_id` is never set)                 | 2                |
| `GET /v1/media/feed`                                                          | public                     | the home/news feed, cacheable, replacing whole-table `media` reads                      | 2                |
| `POST /v1/uploads/sign`                                                       | media\|team_manager\|admin | R2 signed PUT, size/MIME bounds                                                         | 4                |
| `GET /v1/uploads/:key`                                                        | public                     | R2 read-through with image resizing                                                     | 4                |
| `POST /v1/notifications/subscriptions`                                        | authenticated              | device-token registration (FCM phase 5)                                                 | 5                |
| `GET /v1/admin/access-requests` `POST /v1/admin/access-requests/:id/decision` | admin                      | queue + approve/reject, i.e. the server half of User Control                            | 2                |
| `POST /v1/admin/users/:id/role`                                               | admin                      | audited role change (same RPC the UI calls today)                                       | 2                |
| `GET/POST /v1/advertising/*`                                                  | advertising                | advertisers, campaigns, placements, delivery events — separate tables, separate concept | 6                |
| `GET/POST /v1/sponsorship/*`                                                  | sponsorship                | sponsor packages and sponsorships (rights, renewals), _not_ ad delivery                 | 6                |
| `GET /v1/jobs/:id`                                                            | admin                      | queue job status for operators                                                          | 4                |

`advertising` and `sponsorship` stay apart on purpose: an advertiser buys scheduled placements with
impression events; a sponsor buys a package of rights over a season. They overlap only in "shows up
in the app", and merging them early is how you end up with one 30-column table.

## Running it (not needed until Phase 2)

```bash
npm i -D wrangler@latest
cp workers/.dev.vars.example workers/.dev.vars   # local only; never committed
npx wrangler dev --config workers/wrangler.toml  # http://localhost:8787
```

Type-check it any time with `npm run typecheck` (the `workers` project is part of it, so a skeleton
that stops compiling fails the same gate CI runs).

## Config

`workers/wrangler.toml` holds non-secret config and placeholders; secrets are `wrangler secret put`
(see the table in `../docs/PRODUCTION_ARCHITECTURE.md`, §Deployment). The names are documented in
`workers/.dev.vars.example` and `../.env.example`. Nothing here may contain a real key: the
`service_role` key in a git-tracked file would be the single worst outcome of this whole layer,
because it bypasses RLS for every table.
