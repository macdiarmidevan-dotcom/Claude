# Running a pilot at River Bend

What it takes to put this system in front of River Bend's staff for real days, and how to keep it safe. Prices are rough estimates to check before buying anything.

## 1. Host it

The `Dockerfile` builds one image that serves the API and the staff app on one address (`STAFF_WEB_DIR`). `docker-compose.yml` runs it with PostgreSQL.

```sh
cp .env.example .env     # set SYNC_SECRET (a long random string) and POSTGRES_PASSWORD
docker compose up -d
docker compose run --rm app pnpm db:seed    # first time only; prints the manager sign-in once, save it
```

Then open the server's address on the iPad, a laptop or a phone and sign in. The app finds the server on its own when it is served by the API.

- **Where to run it.** Any small cloud server that runs Docker: about 1 CPU, 2 GB of memory and 20 GB of disk is plenty for one course (roughly $10 to $25 a month on the usual providers). A managed database costs more but includes backups; the plain compose setup is the cheapest way to start.
- **HTTPS is required.** iPads and browsers won't keep a sign-in over plain http, and card readers need it. Put the server behind a host that gives free certificates (Caddy, or the platform's own load balancer) and set `PUBLIC_URL` to the https address.
- **Uptime check.** Point a free monitor (UptimeRobot or similar) at `/ready`. It fails when the database can't be reached.
- **Status.** The Dockerfile and compose file have not been run on a real server yet. Expect to fix small things on the first deploy.

## 2. Back up the database

`scripts/backup.sh` writes a dated, compressed copy of everything and deletes copies older than 30 days (`KEEP_DAYS`). `scripts/restore.sh` loads one back (it asks first, because it replaces what's there). Both were run against a real database for this guide and round-tripped.

```sh
# nightly at 2:00, from cron on the server
0 2 * * * cd /srv/golf && DATABASE_URL=postgres://golf:PASSWORD@localhost:5432/golf scripts/backup.sh /srv/golf-backups
```

A backup on the same disk doesn't survive that disk failing: copy the folder somewhere else every night (a cloud storage bucket, or another machine). Once a month, restore the latest copy into a scratch database and open it, so you know the backups work.

## 3. Go-live checklist

Sign in as a manager and open **Settings**. The checklist at the top ticks itself off:

1. Add the staff, with each person's own sign-in, then set everyone's pay (managers only).
2. Check the green fees in **Pricing** against River Bend's rate sheet.
3. Set the sales tax rate for the register.
4. Connect the booking system in **Sync tee sheet**. TeeItUp's API is only open to approved partners, so ask River Bend's TeeItUp contact whether they can publish or schedule a tee sheet export as a link (see the README's "Tee sheet sync and import"). Until then, a manager can upload the export file by hand.
5. Replace the sample cart waiver with wording River Bend's lawyer or the Lisle Park District approves. The sample text is not legal advice.
6. Add the carts to the fleet, and do one practice start-of-day with a starting cash amount.
7. Optional: enter pro shop stock, and connect a card reader (Stripe or Square) when ready to charge from the system.

On the server, set `SYNC_SECRET` (needed to store a provider's sign-in) and optionally `ANTHROPIC_API_KEY` (the help assistant then answers with Claude).

## 4. Run it beside the old way first

For the first week, keep River Bend's current process running and use this system in parallel on a few days: the starter checks groups in and assigns carts on the iPad, the pro shop takes payment, and a manager reads the end-of-day cash drawer and revenue report against what they get today. Write down every place the two disagree. That list is the pilot's real output.

## 5. What a pilot customer should get in writing

Not built into the product, but needed before charging: a short pilot agreement (what is free, how long, what happens to their data when it ends, who owns it), who to call when something breaks on a Saturday morning, and how they can export their data at any time.
