# Phase 4 · query inventory (generated)

Regenerate: `node scripts/query-audit.mjs --write docs/data/phase4-query-inventory.md`.

Machine-extracted from the tree, comments stripped, so a docblock that mentions a query is not
counted. `unbounded` = a read with no `limit`/`range`/`single`; `star` = `select('*')` or an
embedded join of whole rows. Both are only problems at scale, which is why they are counted and
not simply banned: `select('*').eq('id', auth.uid()).single()` is fine, `select('*')` over
`players` is not.

| total sites | reads | writes | rpc | `select('*')` | unbounded | files | tables | pollers |
| ----------- | ----- | ------ | --- | ------------- | --------- | ----- | ------ | ------- |
| 217         | 127   | 90     | 6   | 45            | 52        | 43    | 20     | 6       |

## By table

| table                                | reads | writes | unbounded reads | whole-row selects |
| ------------------------------------ | ----- | ------ | --------------- | ----------------- |
| `matches`                            | 34    | 31     | 11              | 8                 |
| `teams`                              | 21    | 10     | 12              | 2                 |
| `players`                            | 18    | 5      | 10              | 7                 |
| `match_events`                       | 8     | 10     | 6               | 7                 |
| `match_commentary`                   | 9     | 7      | 5               | 8                 |
| `media`                              | 10    | 4      | 2               | 2                 |
| `competitions`                       | 9     | 4      | 3               | 2                 |
| `match_statistics`                   | 6     | 3      | 0               | 5                 |
| `profiles`                           | 5     | 2      | 1               | 1                 |
| `seasons`                            | 2     | 4      | 1               | 1                 |
| `team_news`                          | 2     | 2      | 1               | 1                 |
| `activity_logs`                      | 2     | 1      | 0               | 1                 |
| `notifications`                      | 0     | 1      | 0               | 0                 |
| `rpc:update_player_stats`            | 0     | 1      | 0               | 0                 |
| `access_requests`                    | 1     | 0      | 0               | 0                 |
| `rpc:kicklive_set_user_role`         | 0     | 1      | 0               | 0                 |
| `rpc:kicklive_request_access`        | 0     | 1      | 0               | 0                 |
| `rpc:kicklive_decide_access_request` | 0     | 1      | 0               | 0                 |
| `rpc:kicklive_cancel_access_request` | 0     | 1      | 0               | 0                 |
| `rpc:kicklive_record_media_view`     | 0     | 1      | 0               | 0                 |

## By file

| file                                                | reads | writes | unbounded | whole-row | tables                                                                                                                                                 |
| --------------------------------------------------- | ----- | ------ | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/pages/portals/TeamOwnerPortal.tsx`             | 13    | 9      | 10        | 5         | `matches` `players` `team_news` `teams`                                                                                                                |
| `src/pages/portals/admin/MatchControlFull.tsx`      | 4     | 13     | 0         | 0         | `match_commentary` `match_events` `match_statistics` `matches`                                                                                         |
| `src/pages/portals/admin/MatchControlPro.tsx`       | 5     | 9      | 2         | 5         | `match_commentary` `match_events` `match_statistics` `matches` `players`                                                                               |
| `src/pages/portals/AdminPortal.tsx`                 | 9     | 3      | 1         | 1         | `activity_logs` `competitions` `matches` `media` `profiles` `teams`                                                                                    |
| `src/pages/portals/admin/MatchControlDashboard.tsx` | 4     | 8      | 1         | 4         | `match_commentary` `match_events` `match_statistics` `matches`                                                                                         |
| `src/pages/portals/admin/TeamDashboard.tsx`         | 6     | 5      | 5         | 0         | `matches` `profiles` `teams`                                                                                                                           |
| `src/lib/DataLoader.ts`                             | 11    | 0      | 0         | 0         | `competitions` `matches` `media` `players` `profiles` `teams`                                                                                          |
| `src/lib/MatchAutomation.ts`                        | 8     | 2      | 4         | 8         | `match_commentary` `match_events` `match_statistics` `matches` `notifications` `rpc:update_player_stats`                                               |
| `src/pages/portals/admin/MatchDashboard.tsx`        | 5     | 4      | 2         | 5         | `match_commentary` `match_events` `match_statistics` `matches` `players`                                                                               |
| `src/pages/portals/admin/SeasonManagement.tsx`      | 2     | 6      | 1         | 1         | `competitions` `matches` `seasons`                                                                                                                     |
| `src/pages/portals/admin/MatchControlRoom.tsx`      | 3     | 3      | 3         | 3         | `match_commentary` `match_events` `matches` `players`                                                                                                  |
| `src/pages/TeamProfile.tsx`                         | 5     | 0      | 3         | 1         | `competitions` `matches` `players` `teams`                                                                                                             |
| `src/pages/portals/admin/FixturesViewer.tsx`        | 3     | 2      | 3         | 0         | `matches` `teams`                                                                                                                                      |
| `src/pages/portals/admin/MatchControlNew.tsx`       | 2     | 3      | 2         | 2         | `match_commentary` `match_events` `matches`                                                                                                            |
| `src/lib/access.ts`                                 | 1     | 4      | 0         | 0         | `access_requests` `rpc:kicklive_cancel_access_request` `rpc:kicklive_decide_access_request` `rpc:kicklive_request_access` `rpc:kicklive_set_user_role` |
| `src/pages/HomePage.tsx`                            | 4     | 0      | 0         | 0         | `matches` `media` `players`                                                                                                                            |
| `src/pages/MatchDetails.tsx`                        | 4     | 0      | 1         | 2         | `match_commentary` `match_statistics` `matches` `players`                                                                                              |
| `src/pages/portals/FanPortal.tsx`                   | 4     | 0      | 0         | 0         | `matches` `players` `team_news` `teams`                                                                                                                |
| `src/pages/portals/MediaPortal.tsx`                 | 1     | 3      | 0         | 0         | `media`                                                                                                                                                |
| `src/pages/portals/admin/MatchControl.tsx`          | 1     | 3      | 1         | 1         | `match_commentary` `match_events` `matches`                                                                                                            |
| `src/lib/db.ts`                                     | 3     | 1      | 0         | 0         | `matches` `media` `players` `rpc:kicklive_record_media_view`                                                                                           |
| `src/pages/StandingsPage.tsx`                       | 3     | 0      | 2         | 0         | `competitions` `matches` `teams`                                                                                                                       |
| `src/pages/portals/admin/CompetitionWizard.tsx`     | 1     | 2      | 0         | 0         | `competitions` `matches` `teams`                                                                                                                       |
| `src/pages/portals/admin/MatchCreator.tsx`          | 2     | 1      | 0         | 0         | `competitions` `matches` `teams`                                                                                                                       |
| `src/pages/portals/admin/TableStatistics.tsx`       | 3     | 0      | 2         | 1         | `competitions` `matches` `teams`                                                                                                                       |
| `src/pages/portals/shared/MediaPublisher.tsx`       | 2     | 1      | 2         | 2         | `media`                                                                                                                                                |
| `src/components/Header.tsx`                         | 3     | 0      | 0         | 0         | `matches` `teams`                                                                                                                                      |
| `src/pages/NewsPage.tsx`                            | 2     | 0      | 0         | 0         | `media`                                                                                                                                                |
| `src/pages/PlayerProfile.tsx`                       | 2     | 0      | 0         | 1         | `matches` `players`                                                                                                                                    |
| `src/pages/TeamsPage.tsx`                           | 2     | 0      | 2         | 0         | `players` `teams`                                                                                                                                      |
| `src/pages/portals/admin/MatchControlOrganized.tsx` | 2     | 0      | 2         | 2         | `competitions` `matches`                                                                                                                               |
| `src/pages/portals/admin/TeamSquadDashboard.tsx`    | 1     | 1      | 0         | 0         | `players`                                                                                                                                              |
| `src/pages/portals/shared/PlayerCreator.tsx`        | 1     | 1      | 1         | 0         | `players` `teams`                                                                                                                                      |
| `src/contexts/AuthContext.tsx`                      | 1     | 1      | 0         | 1         | `profiles`                                                                                                                                             |
| `src/pages/MatchesPage.tsx`                         | 1     | 0      | 1         | 0         | `matches`                                                                                                                                              |
| `src/pages/ProfilePage.tsx`                         | 0     | 1      | 0         | 0         | `profiles`                                                                                                                                             |
| `src/pages/portals/admin/CompetitionEditor.tsx`     | 0     | 1      | 0         | 0         | `competitions`                                                                                                                                         |
| `src/pages/portals/admin/MatchControlCenter.tsx`    | 1     | 0      | 1         | 0         | `players`                                                                                                                                              |
| `src/pages/portals/admin/MatchControlComplete.tsx`  | 0     | 1      | 0         | 0         | `matches`                                                                                                                                              |
| `src/pages/portals/admin/MatchControlSimple.tsx`    | 0     | 1      | 0         | 0         | `matches`                                                                                                                                              |
| `src/pages/portals/admin/MultiMatchQueue.tsx`       | 1     | 0      | 0         | 0         | `matches`                                                                                                                                              |
| `src/pages/portals/admin/TeamAdder.tsx`             | 0     | 1      | 0         | 0         | `teams`                                                                                                                                                |
| `src/pages/portals/admin/UserManagement.tsx`        | 1     | 0      | 0         | 0         | `profiles`                                                                                                                                             |

## Components that own their own polling

| file                                           | ln  | every | how it refetches                             |
| ---------------------------------------------- | --- | ----- | -------------------------------------------- |
| `src/pages/HomePage.tsx`                       | 51  | 30 s  | the interval body calls `.from()`            |
| `src/pages/MatchesPage.tsx`                    | 17  | 10 s  | the interval calls a loader in the same file |
| `src/pages/portals/FanPortal.tsx`              | 80  | 30 s  | the interval calls a loader in the same file |
| `src/pages/portals/admin/MatchControlFull.tsx` | 98  | 5 s   | the interval calls a loader in the same file |
| `src/pages/portals/admin/MultiMatchQueue.tsx`  | 16  | 5 s   | the interval calls a loader in the same file |
| `src/lib/DataLoader.ts`                        | 181 | 300 s | the interval calls a loader in the same file |

`src/lib/live/**` is excluded: its intervals are the live engine's heartbeat/resume ladder,
documented in `docs/PRODUCTION_ARCHITECTURE.md` §17, not page polling.

## Unbounded reads

- `src/pages/MatchDetails.tsx:68` — `players` — id, name, number, position, team_id
- `src/pages/MatchesPage.tsx:29` — `matches` — id, home_score, away_score, status, minute, start_time, competition_id, homeTeam:teams!hom
- `src/pages/StandingsPage.tsx:36` — `matches` — home_team_id, away_team_id, home_score, away_score, status
- `src/pages/StandingsPage.tsx:54` — `teams` — id, name, short_name, primary_color, secondary_color, status
- `src/pages/TeamProfile.tsx:30` — `players` — id, name, number, position, goals, assists, nationality, age, photo_url
- `src/pages/TeamProfile.tsx:51` — `competitions` — id, name, type, season, matches!inner(id, home_team_id, away_team_id)
- `src/pages/TeamProfile.tsx:60` — `matches` — home_team_id, away_team_id, home_score, away_score, status
- `src/pages/TeamsPage.tsx:19` — `teams` — id, name, short_name, city, coach, primary_color, secondary_color, status
- `src/pages/TeamsPage.tsx:28` — `players` — team_id
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
- `src/pages/portals/admin/FixturesViewer.tsx:30` — `teams` — id, name, short_name
- `src/pages/portals/admin/FixturesViewer.tsx:38` — `matches` — id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time
- `src/pages/portals/admin/FixturesViewer.tsx:56` — `teams` — id, name, short_name
- `src/pages/portals/admin/MatchControl.tsx:126` — `match_commentary` — *
- `src/pages/portals/admin/MatchControlCenter.tsx:119` — `players` — id, name, number, position, team_id
- `src/pages/portals/admin/MatchControlDashboard.tsx:111` — `match_events` — *, player:players(name), team:teams(short_name)
- `src/pages/portals/admin/MatchControlNew.tsx:112` — `match_events` — *
- `src/pages/portals/admin/MatchControlNew.tsx:120` — `match_commentary` — *
- `src/pages/portals/admin/MatchControlOrganized.tsx:41` — `competitions` — *
- `src/pages/portals/admin/MatchControlOrganized.tsx:60` — `matches` — _, homeTeam:teams!home_team_id(_), awayTeam:teams!away_team_id(*)
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
