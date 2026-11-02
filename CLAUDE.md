# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A golf course management system (not a booking site). Golfers keep booking through the course's own provider (River Bend Golf Club uses TeeItUp); we pull those bookings into our tee sheet and add the rest of operations: check-in, carts, POS, food and bar, staff scheduling, gift cards and house accounts, leagues, accounting export and manager reports. First customer is River Bend, Lisle IL.

## Commands

pnpm 10 workspace, Node 22, PostgreSQL 16.

```sh
pnpm install
pnpm typecheck                 # all packages; CI runs this then pnpm test
pnpm test                      # api tests need Postgres running (service postgresql start)
pnpm db:seed                   # schema + River Bend, prints the staff key
pnpm dev:api                   # http://localhost:3000
pnpm dev:staff                 # staff app in the browser
```

Single API test file: `cd apps/api && npx vitest run test/labor.test.ts`. Tests share one database (`TEST_DATABASE_URL`, default `postgres://golf:golf@localhost:5432/golf_test`), drop and rebuild the schema in `beforeAll`, and run files one at a time. The staff app has no tests of its own; verify it with `cd apps/staff && npx tsc --noEmit -p .` and by building the demo.

Demo build (a single-file web build with fake data, no server): `cd apps/staff && EXPO_OFFLINE=1 pnpm export:demo`.

## Architecture

- `packages/core` is pure logic with no database: tee sheet generation, the rate engine (`rates.ts`), CSV import parsing, the add-on catalog (`addons.ts`) and the help center articles (`help.ts`). Both the API and the staff app import it.
- `apps/api` is Fastify + pg + zod. `src/app.ts` holds every route (with the zod bodies), delegating to one module per area (`reports.ts`, `analytics.ts`, `labor.ts`, `scheduling.ts`, `accounts.ts`, and so on). Migrations are numbered SQL files in `apps/api/migrations`; add the next number, never edit an old one. Money is integer cents everywhere. Times are stored as timestamptz and bucketed into days in the course's time zone with luxon.
- `apps/staff` is an Expo / React Native app (iPad, phones and web from one codebase), styled with `theme.ts`. `Workspace.tsx` is the shell: sign-in picks a station (pro shop or starter), the menu is built from sections, and screens are shown per role and per add-on switch.
- The staff app talks to the API through a `Client` interface in `api.ts`. There are two implementations: the real HTTP client, and `demo.ts`, an in-memory mirror used by the published demo. **Any new API method has to be added to both**, and `demo.ts` has to follow the server's rules (permissions, validation, how totals are computed). Days before today in the demo are generated, seeded by date, so charts have history.

## Rules that span files

- Manager-only screens and endpoints: reports, pricing, add-ons, staff accounts and pay. The starter station never sees resident/nonresident pricing. Server routes check roles (`managedCourseFor`); the app also hides the screens.
- Add-ons (`packages/core/src/addons.ts`) are per-course switches that only hide UI; the API does not enforce them.
- Features change the help center: keep the matching article in `packages/core/src/help.ts` accurate, because the in-app assistant answers only from those articles. Also update the README section and its screenshot in `docs/screenshots/`.
- A tee-sheet delay shifts times in our sheet only; synced provider times are mapped through the day's delays.
- Payments go through a processor-agnostic terminal layer (standalone, Stripe, Square or the simulator); email and SMS go through a simulator until a provider is chosen.

## Workflow

- One PR per request, squash-merged once CI is green. Commits and PR bodies end with the attribution lines the session specifies; do not put model ids in commits or PRs.
- Make multi-line edits with scripts that assert each match is unique, and do not run prettier on existing files (it reformats whole files).
