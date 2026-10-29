-- Punch cards, season passes and loyalty points, kept on the golfer's account.

-- What the course sells: a punch card is a number of rounds; a season pass is unlimited rounds
-- for the holder until it expires.
CREATE TABLE pass_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('punch_card', 'season_pass')),
  price_cents  int  NOT NULL CHECK (price_cents >= 0),
  rounds       int  CHECK (rounds BETWEEN 1 AND 500),
  -- How long it's good for after it's sold. Empty means it doesn't expire.
  valid_days   int  CHECK (valid_days BETWEEN 1 AND 3660),
  -- Whether a round on it includes the cart, or the golfer pays for the cart separately.
  covers_cart  boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'punch_card') = (rounds IS NOT NULL))
);

-- A pass a golfer bought. The name and terms are copied at sale, so changing the pass type later
-- doesn't change what the golfer already paid for.
CREATE TABLE golfer_passes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  pass_type_id  uuid REFERENCES pass_types(id),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('punch_card', 'season_pass')),
  rounds_total  int,
  rounds_used   int  NOT NULL DEFAULT 0 CHECK (rounds_used >= 0),
  covers_cart   boolean NOT NULL,
  expires_at    timestamptz,
  sale_id       uuid REFERENCES sales(id),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by    uuid REFERENCES staff_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (rounds_total IS NULL OR rounds_used <= rounds_total)
);
CREATE INDEX golfer_passes_customer ON golfer_passes (customer_id);

-- Each time a pass pays for rounds at check-in.
CREATE TABLE pass_uses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  golfer_pass_id  uuid NOT NULL REFERENCES golfer_passes(id),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  rounds          int  NOT NULL CHECK (rounds > 0),
  covered_cents   int  NOT NULL CHECK (covered_cents >= 0),
  created_by      uuid REFERENCES staff_users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Loyalty: points earned per dollar spent (0 turns loyalty off), and what a reward is worth.
ALTER TABLE courses ADD COLUMN loyalty_points_per_dollar int NOT NULL DEFAULT 0 CHECK (loyalty_points_per_dollar BETWEEN 0 AND 100);
ALTER TABLE courses ADD COLUMN loyalty_reward_points int NOT NULL DEFAULT 100 CHECK (loyalty_reward_points > 0);
ALTER TABLE courses ADD COLUMN loyalty_reward_cents int NOT NULL DEFAULT 500 CHECK (loyalty_reward_cents >= 0);

ALTER TABLE customers ADD COLUMN loyalty_points int NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0);

-- Every change to a golfer's points, so the balance can always be explained.
CREATE TABLE loyalty_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid NOT NULL REFERENCES courses(id),
  customer_id    uuid NOT NULL REFERENCES customers(id),
  change         int  NOT NULL,
  balance_after  int  NOT NULL,
  reason         text NOT NULL CHECK (reason IN ('round', 'sale', 'redeem', 'adjust', 'refund')),
  booking_id     uuid REFERENCES bookings(id),
  sale_id        uuid REFERENCES sales(id),
  note           text,
  staff_user_id  uuid REFERENCES staff_users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_ledger_customer ON loyalty_ledger (customer_id, created_at);

ALTER TABLE booking_payments DROP CONSTRAINT booking_payments_method_check;
ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_method_check
  CHECK (method IN ('card', 'cash', 'prepaid', 'punch_card', 'season_pass', 'loyalty', 'gift_card', 'comp'));
ALTER TABLE booking_payments ADD COLUMN golfer_pass_id uuid REFERENCES golfer_passes(id);
