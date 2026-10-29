# Golf course platform

Tee sheet, online booking and course operations software for public golf courses. Our first course is River Bend Golf Club in Lisle, IL. The v1 spec is in the project's planning doc.

This repo holds the API foundation (phase 2a): the tee sheet, River Bend's rates, availability and bookings. The staff web tee sheet, the iPad app, the golfer booking page and widget, and Stripe payments come next and all use this API.

## Layout

| Path | What's in it |
| --- | --- |
| `packages/core` | Pure business logic with no database: tee sheet generation and the rate engine, plus River Bend's rates |
| `apps/api` | REST API (Fastify and PostgreSQL), migrations, seed data |

## Running locally

Needs Node 22, pnpm 10 and PostgreSQL 16.

```sh
pnpm install
cp .env.example .env        # then: export $(cat .env | xargs)
createdb golf && createdb golf_test
pnpm db:seed                # creates the schema and River Bend, and prints its API keys
pnpm dev:api                # http://localhost:3000
pnpm test
```

## API

Every `/v1` request needs `Authorization: Bearer <key>`. Each key belongs to one course.

- **Public keys (`pk_`)** are safe to put on a course's website. They can read the course and availability, get quotes, and create bookings.
- **Secret keys (`sk_`)** are for staff apps and servers. They can do everything, including the full tee sheet, blocking times, check-in and cancellation.

| Method and path | Key | What it does |
| --- | --- | --- |
| `GET /v1/courses/:slug` | public | Course details and add-ons (carts, rentals) |
| `GET /v1/courses/:slug/tee-times?date=YYYY-MM-DD&players=N` | public | Open future tee times with room for N players |
| `POST /v1/courses/:slug/quotes` | public | Price a group without booking |
| `POST /v1/courses/:slug/bookings` | public | Book a tee time |
| `GET /v1/courses/:slug/tee-sheet?date=YYYY-MM-DD` | secret | Every tee time for the day with its bookings |
| `PATCH /v1/courses/:slug/tee-times/:id` | secret | Block or reopen a time, or add a note (for example "Ladies league") |
| `GET /v1/courses/:slug/bookings/:id` | secret | One booking with its price lines |
| `POST /v1/courses/:slug/bookings/:id/check-in` | secret | Check the group in |
| `POST /v1/courses/:slug/bookings/:id/no-show` | secret | Mark a no-show |
| `POST /v1/courses/:slug/bookings/:id/cancel` | secret | Cancel and free the spots |

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
- **Residency.** Resident rates need proof. Online bookings pay nonresident rates until staff mark the customer as verified. Staff bookings use the residency given.
- **Booking window.** Online bookings must be in the future and within the course's window (14 days by default). Staff can book any time.
