# KickLive

A premium football live scores and tournament manager app built with React, Vite, TypeScript, Tailwind CSS, and Supabase.

## Stack

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4
- **Build tool**: Vite 7 (with `vite-plugin-singlefile`)
- **Backend/DB**: Supabase (PostgreSQL + Auth)
- **Routing**: React Router v7

## Running the app

```bash
npm run dev
```

The dev server runs on port 5000. The workflow "Start application" handles this automatically.

## Environment variables

Set in Replit Secrets / shared env vars:

- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anonymous (public) key

## Project structure

- `src/pages/` — Route-level page components
- `src/components/` — Shared UI components
- `src/lib/` — Supabase client, DB helpers, competition/match logic
- `src/contexts/` — React context (Auth)
- `src/data/` — Mock/seed data

## User preferences

<!-- Add user preferences here as they are expressed -->
