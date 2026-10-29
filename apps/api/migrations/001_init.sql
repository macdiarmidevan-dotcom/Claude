-- Core v1 schema: courses, tee sheet, rates, customers, bookings, API keys.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  time_zone        text NOT NULL,
  holes            int  NOT NULL CHECK (holes IN (9, 18)),
  address          text,
  phone            text,
  -- How far ahead golfers can book online.
  booking_window_days int NOT NULL DEFAULT 14,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tee_sheet_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  weekdays          int[] NOT NULL,
  first_tee         text NOT NULL,
  last_tee          text NOT NULL,
  interval_minutes  int  NOT NULL CHECK (interval_minutes > 0),
  max_players       int  NOT NULL CHECK (max_players BETWEEN 1 AND 8),
  position          int  NOT NULL DEFAULT 0
);

CREATE TABLE course_holidays (
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date       date NOT NULL,
  name       text,
  PRIMARY KEY (course_id, date)
);

-- Tee times are created per day from the templates the first time that day is opened.
CREATE TABLE tee_times (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  starts_at    timestamptz NOT NULL,
  max_players  int NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'blocked')),
  note         text,
  UNIQUE (course_id, starts_at)
);

CREATE TABLE rate_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  price_cents  int  NOT NULL CHECK (price_cents >= 0),
  days         int[] NOT NULL,
  start_time   text,
  end_time     text,
  residency    text CHECK (residency IN ('resident', 'nonresident')),
  age_groups   text[],
  is_replay    boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (course_id, code)
);

CREATE TABLE add_ons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  price_cents  int  NOT NULL CHECK (price_cents >= 0),
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (course_id, code)
);

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  email            text NOT NULL,
  phone            text,
  -- Staff confirm residency; until then golfers pay nonresident rates.
  residency_verified boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id),
  tee_time_id   uuid NOT NULL REFERENCES tee_times(id),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  players       int  NOT NULL CHECK (players > 0),
  holes         int  NOT NULL,
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'checked_in', 'cancelled', 'no_show')),
  source        text NOT NULL CHECK (source IN ('web', 'widget', 'api', 'staff', 'golfnow')),
  total_cents   int  NOT NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz
);
CREATE INDEX bookings_tee_time_idx ON bookings (tee_time_id) WHERE status <> 'cancelled';

CREATE TABLE booking_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('green_fee', 'add_on')),
  code         text NOT NULL,
  description  text NOT NULL,
  quantity     int  NOT NULL DEFAULT 1,
  unit_cents   int  NOT NULL,
  total_cents  int  NOT NULL
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('public', 'secret')),
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
