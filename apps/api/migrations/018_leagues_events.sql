-- Leagues, outings and standing tee times.

-- A golfer's permanent weekly tee time, e.g. every Saturday at 7:02 for four. The tee sheet books
-- it for them each week, a few weeks ahead.
CREATE TABLE standing_times (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  weekday      int  NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  local_time   text NOT NULL CHECK (local_time ~ '^\d{2}:\d{2}$'),
  players      int  NOT NULL CHECK (players BETWEEN 1 AND 8),
  holes        int  NOT NULL,
  riding       boolean NOT NULL DEFAULT false,
  residency    text NOT NULL DEFAULT 'nonresident' CHECK (residency IN ('resident', 'nonresident')),
  starts_on    date NOT NULL,
  ends_on      date,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES staff_users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Each week a standing time was booked, or why it couldn't be (time blocked or full).
CREATE TABLE standing_runs (
  standing_time_id  uuid NOT NULL REFERENCES standing_times(id) ON DELETE CASCADE,
  date              date NOT NULL,
  booking_id        uuid REFERENCES bookings(id),
  problem           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (standing_time_id, date)
);

ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check
  CHECK (source IN ('staff', 'phone', 'teeitup', 'golfnow', 'import', 'standing'));

-- A league (weekly, through a season) or an outing (one day). It holds a block of tee times on each
-- of its dates, either one group per tee time or a shotgun start with a group on each hole.
CREATE TABLE events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id               uuid NOT NULL REFERENCES courses(id),
  name                    text NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('league', 'outing')),
  format                  text NOT NULL CHECK (format IN ('tee_times', 'shotgun')),
  holes                   int  NOT NULL,
  price_per_player_cents  int  NOT NULL CHECK (price_per_player_cents >= 0),
  includes_cart           boolean NOT NULL DEFAULT false,
  contact_name            text,
  contact_email           text,
  contact_phone           text,
  notes                   text,
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_dates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date        date NOT NULL,
  start_time  text NOT NULL CHECK (start_time ~ '^\d{2}:\d{2}$'),
  -- How many tee times in a row it holds.
  slots       int  NOT NULL CHECK (slots BETWEEN 1 AND 60),
  status      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  UNIQUE (event_id, date)
);

-- Tee times held for an event date show as blocked, with the event's name.
ALTER TABLE tee_times ADD COLUMN event_date_id uuid REFERENCES event_dates(id) ON DELETE SET NULL;

-- Who plays in it: a league's roster, or an outing's field.
CREATE TABLE event_players (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES customers(id),
  name         text NOT NULL,
  email        text,
  phone        text,
  handicap     numeric(4, 1),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Groups for one date: who plays together, where they start, and whether they've checked in.
CREATE TABLE event_pairings (
  event_date_id  uuid NOT NULL REFERENCES event_dates(id) ON DELETE CASCADE,
  player_id      uuid NOT NULL REFERENCES event_players(id) ON DELETE CASCADE,
  group_no       int  NOT NULL CHECK (group_no >= 1),
  checked_in_at  timestamptz,
  PRIMARY KEY (event_date_id, player_id)
);

-- Money paid for an event, usually one payment for the whole group (the league or the company
-- running the outing), by date or for the season.
CREATE TABLE event_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_date_id   uuid REFERENCES event_dates(id) ON DELETE SET NULL,
  amount_cents    int  NOT NULL CHECK (amount_cents <> 0),
  method          text NOT NULL CHECK (method IN ('card', 'cash', 'check', 'gift_card', 'comp')),
  card_payment_id uuid REFERENCES card_payments(id),
  note            text,
  staff_user_id   uuid REFERENCES staff_users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_payments_created ON event_payments (created_at);
