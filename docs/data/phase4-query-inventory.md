# Phase 4 · query inventory (generated)

Regenerate: `node scripts/query-audit.mjs --write docs/data/phase4-query-inventory.md`.

Machine-extracted from the tree, comments stripped, so a docblock that mentions a query is not
counted. `unbounded` = a read with no `limit`/`range`/`single`; `whole-row` = `select('*')` or an embedded
join of whole rows that is *not* a single-row lookup — `select('*').eq('id', auth.uid()).single()` is
fine and is not counted, `select('*')` over `players` is. Neither is banned outright: they are
problems at scale, which is exactly what a scale that has not arrived yet cannot argue with.

| total sites | reads | writes | rpc | `select('*')` | unbounded | files | tables | pollers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 211 | 119 | 92 | 8 | 32 | 39 | 32 | 22 | 2 |

## By table

| table | reads | writes | unbounded reads | whole-row reads (not single-row) |
| --- | --- | --- | --- | --- |
| `matches` | 31 | 31 | 7 | 7 |
| `teams` | 18 | 10 | 8 | 0 |
| `players` | 16 | 5 | 6 | 7 |
| `match_events` | 8 | 10 | 6 | 6 |
| `match_commentary` | 9 | 7 | 5 | 5 |
| `media` | 10 | 4 | 2 | 2 |
| `competitions` | 9 | 4 | 2 | 2 |
| `match_statistics` | 6 | 3 | 0 | 0 |
| `profiles` | 5 | 2 | 1 | 0 |
| `seasons` | 2 | 4 | 1 | 1 |
| `team_news` | 2 | 2 | 1 | 1 |
| `activity_logs` | 2 | 1 | 0 | 1 |
| `notifications` | 0 | 1 | 0 | 0 |
| `rpc:update_player_stats` | 0 | 1 | 0 | 0 |
| `access_requests` | 1 | 0 | 0 | 0 |
| `rpc:kicklive_set_user_role` | 0 | 1 | 0 | 0 |
| `rpc:kicklive_request_access` | 0 | 1 | 0 | 0 |
| `rpc:kicklive_decide_access_request` | 0 | 1 | 0 | 0 |
| `rpc:kicklive_cancel_access_request` | 0 | 1 | 0 | 0 |
| `rpc:kicklive_competition_standings` | 0 | 1 | 0 | 0 |
| `rpc:kicklive_squad_sizes` | 0 | 1 | 0 | 0 |
| `rpc:kicklive_record_media_view` | 0 | 1 | 0 | 0 |

## By file

| file | reads | writes | unbounded | whole-row | tables |
| --- | --- | --- | --- | --- | --- |
| `src/lib/data/queries.ts` | 27 | 2 | 0 | 6 | `competitions` `match_commentary` `match_statistics` `matches` `media` `players` `rpc:kicklive_competition_standings` `rpc:kicklive_squad_sizes` `team_news` `teams` |
| `src/pages/portals/TeamOwnerPortal.tsx` | 13 | 9 | 10 | 4 | `matches` `players` `team_news` `teams` |
| `src/pages/portals/admin/MatchControlFull.tsx` | 4 | 13 | 0 | 0 | `match_commentary` `match_events` `match_statistics` `matches` |
| `src/pages/portals/admin/MatchControlPro.tsx` | 5 | 9 | 2 | 2 | `match_commentary` `match_events` `match_statistics` `matches` `players` |
| `src/pages/portals/AdminPortal.tsx` | 9 | 3 | 1 | 1 | `activity_logs` `competitions` `matches` `media` `profiles` `teams` |
| `src/pages/portals/admin/MatchControlDashboard.tsx` | 4 | 8 | 1 | 1 | `match_commentary` `match_events` `match_statistics` `matches` |
| `src/pages/portals/admin/TeamDashboard.tsx` | 6 | 5 | 5 | 0 | `matches` `profiles` `teams` |
| `src/lib/DataLoader.ts` | 11 | 0 | 0 | 0 | `competitions` `matches` `media` `players` `profiles` `teams` |
| `src/lib/MatchAutomation.ts` | 8 | 2 | 4 | 4 | `match_commentary` `match_events` `match_statistics` `matches` `notifications` `rpc:update_player_stats` |
| `src/pages/portals/admin/MatchDashboard.tsx` | 5 | 4 | 2 | 2 | `match_commentary` `match_events` `match_statistics` `matches` `players` |
| `src/pages/portals/admin/SeasonManagement.tsx` | 2 | 6 | 1 | 1 | `competitions` `matches` `seasons` |
| `src/pages/portals/admin/MatchControlRoom.tsx` | 3 | 3 | 3 | 3 | `match_commentary` `match_events` `matches` `players` |
| `src/pages/portals/admin/MatchControlNew.tsx` | 2 | 3 | 2 | 2 | `match_commentary` `match_events` `matches` |
| `src/lib/access.ts` | 1 | 4 | 0 | 0 | `access_requests` `rpc:kicklive_cancel_access_request` `rpc:kicklive_decide_access_request` `rpc:kicklive_request_access` `rpc:kicklive_set_user_role` |
| `src/pages/portals/MediaPortal.tsx` | 1 | 3 | 0 | 0 | `media` |
| `src/pages/portals/admin/MatchControl.tsx` | 1 | 3 | 1 | 1 | `match_commentary` `match_events` `matches` |
| `src/lib/db.ts` | 3 | 1 | 0 | 0 | `matches` `media` `players` `rpc:kicklive_record_media_view` |
| `src/pages/portals/admin/CompetitionWizard.tsx` | 1 | 2 | 0 | 0 | `competitions` `matches` `teams` |
| `src/pages/portals/admin/MatchCreator.tsx` | 2 | 1 | 0 | 0 | `competitions` `matches` `teams` |
| `src/pages/portals/admin/TableStatistics.tsx` | 3 | 0 | 2 | 1 | `competitions` `matches` `teams` |
| `src/pages/portals/shared/MediaPublisher.tsx` | 2 | 1 | 2 | 2 | `media` |
| `src/pages/portals/admin/FixturesViewer.tsx` | 0 | 2 | 0 | 0 | `matches` |
| `src/pages/portals/admin/MatchControlOrganized.tsx` | 2 | 0 | 2 | 2 | `competitions` `matches` |
| `src/pages/portals/admin/TeamSquadDashboard.tsx` | 1 | 1 | 0 | 0 | `players` |
| `src/pages/portals/shared/PlayerCreator.tsx` | 1 | 1 | 1 | 0 | `players` `teams` |
| `src/contexts/AuthContext.tsx` | 1 | 1 | 0 | 0 | `profiles` |
| `src/pages/ProfilePage.tsx` | 0 | 1 | 0 | 0 | `profiles` |
| `src/pages/portals/admin/CompetitionEditor.tsx` | 0 | 1 | 0 | 0 | `competitions` |
| `src/pages/portals/admin/MatchControlComplete.tsx` | 0 | 1 | 0 | 0 | `matches` |
| `src/pages/portals/admin/MatchControlSimple.tsx` | 0 | 1 | 0 | 0 | `matches` |
| `src/pages/portals/admin/TeamAdder.tsx` | 0 | 1 | 0 | 0 | `teams` |
| `src/pages/portals/admin/UserManagement.tsx` | 1 | 0 | 0 | 0 | `profiles` |

## Components that own their own polling

| file | ln | every | how it refetches |
| --- | --- | --- | --- |
| `src/pages/portals/admin/MatchControlFull.tsx` | 98 | 5 s | the interval calls a loader in the same file |
| `src/lib/DataLoader.ts` | 193 | 300 s | the interval calls a loader in the same file |

`src/lib/live/**` is excluded: its intervals are the live engine's heartbeat/resume ladder,
documented in `docs/PRODUCTION_ARCHITECTURE.md` §17, not page polling.

## Unbounded reads

- `src/pages/portals/AdminPortal.tsx:54` — `teams` — id
- `src/pages/portals/TeamOwnerPortal.tsx:320` — `matches` — id, home_team_id, away_team_id, home_score, away_score, status, start_time, minute, homeTe
- `src/pages/portals/TeamOwnerPortal.tsx:541` — `players` — *
- `src/pages/portals/TeamOwnerPortal.tsx:714` — `matches` — id, home_team_id, away_team_id, home_score, away_score, status, start_time, minute, homeTe
- `src/pages/portals/TeamOwnerPortal.tsx:777` — `matches` — id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time, homeTe
- `src/pages/portals/TeamOwnerPortal.tsx:856` — `matches` — home_team_id, away_team_id, home_score, away_score, status
- `src/pages/portals/TeamOwnerPortal.tsx:857` — `teams` — id, name, short_name, primary_color
- `src/pages/portals/TeamOwnerPortal.tsx:941` — `players` — *
- `src/pages/portals/TeamOwnerPortal.tsx:942` — `matches` — home_team_id, away_team_id, home_score, away_score, status
- `src/pages/portals/TeamOwnerPortal.tsx:1069` — `players` — *
- `src/pages/portals/TeamOwnerPortal.tsx:1339` — `team_news` — *
- `src/pages/portals/admin/MatchControl.tsx:126` — `match_commentary` — *
- `src/pages/portals/admin/MatchControlDashboard.tsx:111` — `match_events` — *, player:players(name), team:teams(short_name)
- `src/pages/portals/admin/MatchControlNew.tsx:112` — `match_events` — *
- `src/pages/portals/admin/MatchControlNew.tsx:120` — `match_commentary` — *
- `src/pages/portals/admin/MatchControlOrganized.tsx:41` — `competitions` — *
- `src/pages/portals/admin/MatchControlOrganized.tsx:60` — `matches` — *, homeTeam:teams!home_team_id(*), awayTeam:teams!away_team_id(*)
- `src/pages/portals/admin/MatchControlPro.tsx:121` — `players` — *
- `src/pages/portals/admin/MatchControlPro.tsx:127` — `match_events` — *, player:players(name), team:teams(short_name)
- `src/pages/portals/admin/MatchControlRoom.tsx:144` — `match_events` — *
- `src/pages/portals/admin/MatchControlRoom.tsx:152` — `match_commentary` — *
- `src/pages/portals/admin/MatchControlRoom.tsx:161` — `players` — *
- `src/pages/portals/admin/MatchDashboard.tsx:145` — `players` — *
- `src/pages/portals/admin/MatchDashboard.tsx:168` — `match_commentary` — *
- `src/pages/portals/admin/SeasonManagement.tsx:30` — `seasons` — *
- `src/pages/portals/admin/TableStatistics.tsx:19` — `competitions` — *
- `src/pages/portals/admin/TableStatistics.tsx:144` — `teams` — id, name, short_name, primary_color, secondary_color
- `src/pages/portals/admin/TeamDashboard.tsx:61` — `teams` — id, name, short_name, city, venue, coach, primary_color, secondary_color, status, owner_id
- `src/pages/portals/admin/TeamDashboard.tsx:66` — `teams` — id, name, short_name, city, venue, coach, primary_color, secondary_color, status, owner_id
- `src/pages/portals/admin/TeamDashboard.tsx:71` — `teams` — id, name, short_name, city, venue, coach, primary_color, secondary_color, status, owner_id
- `src/pages/portals/admin/TeamDashboard.tsx:87` — `profiles` — id, username, email
- `src/pages/portals/admin/TeamDashboard.tsx:96` — `teams` — id, name, short_name, city, primary_color, secondary_color, created_at
- `src/pages/portals/shared/MediaPublisher.tsx:40` — `media`
- `src/pages/portals/shared/MediaPublisher.tsx:46` — `media`
- `src/pages/portals/shared/PlayerCreator.tsx:24` — `teams` — id, name
- `src/lib/MatchAutomation.ts:70` — `matches` — *
- `src/lib/MatchAutomation.ts:157` — `match_events` — *
- `src/lib/MatchAutomation.ts:256` — `match_events` — *
- `src/lib/MatchAutomation.ts:263` — `match_commentary` — *

