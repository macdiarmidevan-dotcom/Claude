-- Rain checks and refunds on rounds.

-- Credit for holes a group couldn't finish (weather, frost, course closed), redeemed on a later
-- round. Issuing one takes that much off the original round, so it isn't counted as revenue twice.
CREATE TABLE rain_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        uuid NOT NULL REFERENCES courses(id),
  code             text NOT NULL,
  booking_id       uuid NOT NULL REFERENCES bookings(id),
  -- The golfer's account when the round was linked to one; anyone holding the code can still use it.
  customer_id      uuid REFERENCES customers(id),
  name             text NOT NULL,
  players          int  NOT NULL CHECK (players > 0),
  holes_unplayed   int  NOT NULL CHECK (holes_unplayed > 0),
  amount_cents     int  NOT NULL CHECK (amount_cents > 0),
  remaining_cents  int  NOT NULL CHECK (remaining_cents >= 0),
  expires_at       timestamptz,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  note             text,
  issued_by        uuid REFERENCES staff_users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, code),
  CHECK (remaining_cents <= amount_cents)
);
CREATE INDEX rain_checks_customer ON rain_checks (customer_id);

ALTER TABLE courses ADD COLUMN rain_check_days int NOT NULL DEFAULT 365 CHECK (rain_check_days BETWEEN 1 AND 3660);

-- Refunds are negative payments on the day they're given, so money taken and the cash drawer net
-- them out; they carry the reason and who gave them.
ALTER TABLE booking_payments DROP CONSTRAINT booking_payments_amount_cents_check;
ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_amount_cents_check CHECK (amount_cents <> 0);
ALTER TABLE booking_payments DROP CONSTRAINT booking_payments_method_check;
ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_method_check
  CHECK (method IN ('card', 'cash', 'prepaid', 'punch_card', 'season_pass', 'loyalty', 'rain_check', 'gift_card', 'comp'));
ALTER TABLE booking_payments ADD COLUMN rain_check_id uuid REFERENCES rain_checks(id);
ALTER TABLE booking_payments ADD COLUMN note text;
ALTER TABLE booking_payments ADD COLUMN staff_user_id uuid REFERENCES staff_users(id);
