-- Card terminals. Each course picks how cards are taken: on a standalone terminal the register
-- only records (what every course starts on), or through a connected processor (Stripe, Square,
-- or the built-in simulator for training), where the register sends the amount to a card reader
-- and waits for the golfer to tap, dip or swipe.

CREATE TABLE payment_settings (
  course_id    uuid PRIMARY KEY REFERENCES courses(id),
  provider     text NOT NULL DEFAULT 'standalone',
  -- Settings that aren't secret, e.g. the processor's location id or sandbox/production.
  account      jsonb NOT NULL DEFAULT '{}',
  -- API keys and webhook secrets, encrypted by the server. Never sent back to the app.
  credentials_enc text,
  currency     text NOT NULL DEFAULT 'usd',
  -- Ask for a tip on the reader (bar and food sales, mostly).
  tipping      boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The card readers at the course: one at the pro shop counter, one at the bar, one at the turn.
CREATE TABLE card_terminals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id),
  name        text NOT NULL,
  provider    text NOT NULL,
  -- The processor's id for the reader.
  reader_id   text NOT NULL,
  location    text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, provider, reader_id)
);

-- Every amount sent to a reader, whether the card went through or not.
CREATE TABLE card_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id            uuid NOT NULL REFERENCES courses(id),
  terminal_id          uuid NOT NULL REFERENCES card_terminals(id),
  provider             text NOT NULL,
  provider_payment_id  text,
  -- The processor's charge or payment id, which refunds go against.
  provider_charge_id   text,
  amount_cents         int  NOT NULL CHECK (amount_cents > 0),
  tip_cents            int  NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  currency             text NOT NULL,
  description          text,
  status               text NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed', 'cancelled')),
  failure_message      text,
  card_brand           text,
  card_last4           text,
  refunded_cents       int  NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  -- What the payment paid for, once the check-in or sale using it went through.
  booking_id           uuid REFERENCES bookings(id),
  sale_id              uuid REFERENCES sales(id),
  created_by           uuid REFERENCES staff_users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX card_payments_course_time ON card_payments (course_id, created_at);

ALTER TABLE booking_payments ADD COLUMN card_payment_id uuid REFERENCES card_payments(id);
ALTER TABLE sales ADD COLUMN card_payment_id uuid REFERENCES card_payments(id);
