# Golf course management system

Software for running a public golf course: the starter's tee sheet, check-in and carts, and (coming next) POS, inventory, employee scheduling and accounting. Golfers keep booking with the course's existing provider (for River Bend Golf Club, our first course, that's TeeItUp and GolfNow), and those bookings are pulled into our tee sheet. The v1 spec is in the project's planning doc.

## Layout

| Path | What's in it |
| --- | --- |
| `packages/core` | Pure business logic with no database: tee sheet generation and the rate engine, plus River Bend's rates |
| `apps/api` | Staff REST API (Fastify and PostgreSQL), migrations, seed data |
| `apps/staff` | Staff tee sheet app (Expo / React Native): runs on iPad, phones and the web from one codebase |

## Running locally

Needs Node 22, pnpm 10 and PostgreSQL 16.

```sh
pnpm install
cp .env.example .env        # then: export $(cat .env | xargs)
createdb golf && createdb golf_test
pnpm db:seed                # creates the schema and River Bend, and prints its staff key
pnpm dev:api                # http://localhost:3000
pnpm dev:staff              # staff app in the browser; sign in with the staff key
pnpm test
```

## API

Every `/v1` request needs `Authorization: Bearer <key>` with a staff (`sk_`) key for the course. There is no public booking API: golfers book with the course's own booking provider.

| Method and path | What it does |
| --- | --- |
| `GET /v1/courses/:slug` | Course details and add-ons (carts, rentals) |
| `GET /v1/courses/:slug/tee-sheet?date=YYYY-MM-DD` | Every tee time for the day with its groups and cart numbers |
| `PATCH /v1/courses/:slug/tee-times/:id` | Block or reopen a time, or add a note (for example "Ladies league") |
| `POST /v1/courses/:slug/quotes` | Price a group without booking |
| `POST /v1/courses/:slug/bookings` | Add a walk-in or phone booking |
| `GET /v1/courses/:slug/bookings/:id` | One booking with its price lines |
| `POST /v1/courses/:slug/bookings/:id/check-in` | Check the group in, optionally with `{ "cartNumbers": ["12"] }` |
| `PUT /v1/courses/:slug/bookings/:id/carts` | Change cart numbers |
| `POST /v1/courses/:slug/bookings/:id/move` | Move the group to another tee time with room |
| `POST /v1/courses/:slug/bookings/:id/no-show` | Mark a no-show |
| `POST /v1/courses/:slug/bookings/:id/cancel` | Cancel and free the spots |

Example booking:

```json
POST /v1/courses/river-bend/bookings
{
  "teeTimeId": "…",
  "holes": 18,
  "customer": { "name": "Pat Golfer", "email": "pat@example.com" },
  "players": [{ "residency": "resident", "ageGroup": "adult" }, { "ageGroup": "senior" }],
  "addOns": [{ "code": "gas_cart", "quantity": 2 }]
}
```

### How it behaves

- **Tee sheet.** Each course has templates (first and last tee, interval, max players by weekday). A day's tee times are created the first time that day is opened, on the course's local clock, including across daylight saving changes.
- **No double-booking.** A booking locks its tee time row for the transaction, so simultaneous requests for the last spots can't overbook.
- **Rates.** The most specific matching rule wins (residency, age group, time window), and ties go to the lower price. Holidays use weekend rates. 18 holes on a 9-hole course is the 9-hole rate plus the replay rate.

## Staff app

The starter opens the day's tee sheet on an iPad. Each row shows the time, filled spots, and the groups with check-in status and cart numbers. Tapping a time opens a panel to check a group in and assign carts, mark no-shows, move a group to another time, cancel, add a walk-in, or block the time with a note. On an iPad in landscape or a desktop the panel sits beside the sheet; on a phone it slides up. The sheet refreshes every 5 seconds, so changes from the pro shop show up on the starter's iPad.

![Staff tee sheet on iPad](docs/screenshots/staff-ipad.png)
