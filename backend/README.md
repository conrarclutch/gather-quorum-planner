# Priests Planner backend

This backend stores the planner in Supabase and exposes one Edge Function named `backend`. Public schedules are never exposed: all table access is revoked from `anon` and `authenticated`. The service role receives schema usage and only SELECT/INSERT/UPDATE/DELETE on the six `qp_` tables, plus execute permission on the atomic claim RPC. Browser requests use opaque 30-day bearer sessions whose SHA-256 hashes are stored in `qp_sessions`.

## Set up Supabase

1. Create a Supabase project and run [`schema.sql`](./schema.sql) once in the SQL Editor.
2. Generate two different random codes, each at least 22 characters, for the group invite and owner access. For example, run `node -p "require('node:crypto').randomBytes(24).toString('base64url')"` twice. Put them directly into environment variables; the seeding script never prints either code. Share the invite code with members; keep the owner code with quorum leaders. The database stores only SHA-256 hashes of both codes.
3. Copy `backend/config.toml` to `supabase/config.toml` at the project root, and copy `backend/index.ts` to `supabase/functions/backend/index.ts`. Keep the function directory name `backend`.
4. Install/use the Supabase CLI, link the project, then deploy:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy backend
   ```

   `verify_jwt = false` is required because members authenticate with this function's opaque session token rather than a Supabase Auth JWT. The handler validates every bearer token itself.

5. Set `VITE_API_URL` in the frontend build environment to `https://YOUR_PROJECT_REF.supabase.co/functions/v1/backend` and `VITE_SUPABASE_PUBLISHABLE_KEY` to the project's public publishable key. The public key is safe to ship in a browser; it only passes the Supabase API gateway and grants no table access. The function allows localhost development origins and `https://conrarclutch.github.io`; add any other exact site origin in the function's `ALLOWED_ORIGINS` secret as a comma-separated list, then redeploy.

Supabase injects `SUPABASE_URL` and the project server key at runtime. The function reads `SUPABASE_SERVICE_ROLE_KEY` (legacy platform variable), `SERVICE_ROLE_KEY`, or the default entry in `SUPABASE_SECRET_KEYS`. Never put that key in frontend configuration.

## Seed the 14 researched events

Run the script once from the repository root after setting the environment variables below. It creates the planner group if needed, seeds all 14 rows from `research/schedules.json`, and adds unclaimed, clearly marked suggested task templates. Running it again skips existing schedule rows and task titles.

```powershell
$env:SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "YOUR_SERVER_ONLY_SERVICE_ROLE_KEY"
$env:SEED_INVITE_CODE = "YOUR_RANDOM_GROUP_INVITE_CODE"
$env:SEED_OWNER_CODE = "A_DIFFERENT_RANDOM_OWNER_CODE"
$env:SEED_GROUP_NAME = "Priests Quorum"
node scripts/seed-backend.mjs
```

The seeded date preserves the source's year and weekday caveats: month/day-only entries are interpreted as 2026 based on the planner title; numeric serial values and per-row date caveats are preserved as evidence, including the November 6 and 13 weekday conflicts. `sourceDate`, `originalDateSerial`, and `dateCaveat` are immutable source evidence; `eventDate` is the editable planning date. Leaders should confirm inferred dates and weekday conflicts before treating them as final. Source title, URL, tab, and row are also preserved. Activity ideas from the research were not treated as scheduled events.

## API contract

All endpoints live below `/functions/v1/backend`. JSON errors have the form `{ "error": "..." }`. Authenticated calls set `Authorization: Bearer <token>`; responses are `no-store` and use camelCase fields.

| Request | Body / response |
| --- | --- |
| `POST /join` | `{ inviteCode, displayName, ownerCode? }` → `{ token, expiresAt, member }` |
| `GET /state` | group-scoped `{ member, events, tasks, rsvps, members }`; member listing contains only `id`, `displayName`, and `role` |
| `POST /rsvp` | `{ eventId, status, count, rideNeeded, seatsOffered, notes }`; upserts only the signed-in member's RSVP |
| `POST /claim` | `{ taskId, claim }`; claims atomically if open or already claimed by this member, else returns `409` |
| `POST /event` | `{ eventId, expectedUpdatedAt, patch }`; owner-only planning-field patch, returns `409` when the event changed since load |
| `POST /task` | `{ eventId, title, quantity?, category? }`; owner-only; new task is unclaimed |
| `POST /delete-task` | `{ taskId }`; owner-only, only succeeds for an unclaimed task |

## Local run

Use the Supabase CLI local stack with the function copied to `supabase/functions/backend` and schema applied to the local database. For function serving, run `supabase functions serve backend --no-verify-jwt`. Set local function environment values in `supabase/functions/.env` as documented by Supabase; do not commit that file.
