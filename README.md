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
| `POST /v1/courses/:slug/bookings/:id/payments` | Record a payment: `{ "amountCents": 2900, "method": "cash" }` |
| `POST /v1/courses/:slug/bookings/:id/check-in` | Pro shop check-in. The group must be paid; pass `{ "payment": { "method": "card" } }` to take the balance in the same step |
| `POST /v1/courses/:slug/bookings/:id/tee-off` | Starter check-in at the first tee, optionally with `{ "cartNumbers": ["12"] }`. Only after the pro shop has checked the group in |
| `GET /v1/courses/:slug/waiver` | The cart waiver drivers sign |
| `PUT /v1/courses/:slug/bookings/:id/carts` | Change cart numbers: `{ "cartNumbers": ["12"], "waivers": [{ "cartNumber": "12", "driverName": "…", "signature": "M10 100 L…" }] }` |
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

Each device is set to **Pro shop** or **Starter** (switchable in the top bar). Check-in has two steps: the pro shop takes payment and checks the group in, then the starter checks them in at the tee box and assigns carts. The starter can't send off a group the pro shop hasn't checked in.

Each row shows the time, filled spots, the groups (✓ checked in at the shop, ⛳ on the course, ✕ no-show), cart numbers, and whether the time is paid or what's owed. Tapping a time opens a panel to take payment and check in, send a group off with carts, mark no-shows, move a group to another time, cancel, add a walk-in, or block the time with a note. On an iPad in landscape or a desktop the panel sits beside the sheet; on a phone it slides up. The sheet refreshes every 5 seconds, so changes from the pro shop show up on the starter's iPad.

**Cart waivers.** When carts are assigned, the app pops up the course's cart waiver for each cart's driver in turn: they read it, enter their name, tick that they agree, and sign with a finger. A cart can't be assigned until its driver has signed (the API enforces this too, on every route that sets carts). Each signature is stored with the driver's name, the cart, the exact waiver version and the time. The seeded River Bend waiver is sample text: the course must supply its own reviewed wording.

![Staff tee sheet on iPad](docs/screenshots/staff-ipad.png)
