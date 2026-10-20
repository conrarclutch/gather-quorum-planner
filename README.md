# Gather

A shared activity planner with attendance, rides, volunteer responsibilities, and source-aware event details. React, TypeScript, and Vite with a Supabase Edge Function and Postgres for private shared data.

## Development

Use Node22 or newer.

```sh
npm ci
npm run dev
npm test
npm run build
```

Without a configured backend, the app shows a setup screen and offers a clearly labelled design preview. Preview changes stay in that browser; they are not shared signups. A configured production build connects to the shared planner and does not offer preview mode. Private schedules are never bundled into the public website.

## Connect the shared planner

Follow backend/README.md to create the schema, deploy `gather-planner`, and initialize its data. You can use the service-key seed script or the hash-only SQL Editor bootstrap generator at scripts/bootstrap-sql.mjs. Google Drive extraction is a snapshot; the app does not silently sync subsequent Sheet edits.

Set these public build variables in the GitHub repository Settings > Secrets and variables > Actions > Variables:

- VITE_API_URL: the full Supabase function URL ending /functions/v1/gather-planner
- VITE_SUPABASE_PUBLISHABLE_KEY: the project publishable key

Run the Deploy Gather workflow after configuring them. Service-role keys, invite codes, owner codes, and schedule extracts must never be committed or set as VITE variables.

The standard Pages path is /gather-quorum-planner/. The workflow supplies BASE_PATH. For a custom domain, set BASE_PATH to / and configure the domain in GitHub Pages before publishing the DNS change.

## Access and responsibilities

Members join with an invitation code and their display name. The invite-sharing link places the code in a `#invite=...` URL fragment to prefill the join screen; share it only with the intended group. A separate owner code grants permission to edit logistics and create tasks. Members can RSVP and claim/release their own tasks. Shared saves wait for a successful backend response; task claims and event updates are concurrency protected.

The public app shell contains no private schedule records. The backend enforces group membership, isolates group data, and uses RLS with no direct public table access. The browser keeps the session locally; server sessions expire after 30 days. Review and retain invite codes within the intended group.

## Schedule provenance

The local research folder contains the two original source references and a fourteen-entry extraction. It is deliberately ignored by Git. Source years, date serials, and uncertainty remain attached to records in the private database. Suggested tasks are labelled; no attendance, drivers, or responsible names are fabricated.
