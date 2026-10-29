-- Two-step check-in: the pro shop checks golfers in (and takes payment), then the
-- starter sends them off the first tee.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('confirmed', 'checked_in', 'teed_off', 'cancelled', 'no_show'));
ALTER TABLE bookings ADD COLUMN checked_in_at timestamptz;
ALTER TABLE bookings ADD COLUMN teed_off_at timestamptz;

CREATE TABLE booking_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount_cents  int  NOT NULL CHECK (amount_cents > 0),
  -- 'prepaid' is money already taken by the booking provider (e.g. paid online on TeeItUp).
  method        text NOT NULL CHECK (method IN ('card', 'cash', 'prepaid', 'punch_card', 'gift_card', 'comp')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_payments_booking_idx ON booking_payments (booking_id);
