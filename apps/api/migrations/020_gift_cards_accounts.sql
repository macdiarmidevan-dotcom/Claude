-- Gift cards with a balance, and house accounts: golfers (usually members) who charge rounds,
-- food and pro shop items to an account that's billed once a month.

CREATE TABLE gift_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       uuid NOT NULL REFERENCES courses(id),
  -- Printed on the card, e.g. GC-7K2M-9QXA.
  code            text NOT NULL,
  initial_cents   int  NOT NULL CHECK (initial_cents > 0),
  balance_cents   int  NOT NULL CHECK (balance_cents >= 0),
  -- Who it's for, if it was sold to someone's account or as a gift.
  customer_id     uuid REFERENCES customers(id),
  recipient_name  text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  issued_by       uuid REFERENCES staff_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, code)
);

-- Every change to a card's balance, so a disputed balance can be traced.
CREATE TABLE gift_card_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id     uuid NOT NULL REFERENCES gift_cards(id),
  change_cents     int  NOT NULL,
  balance_after    int  NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('sold', 'reload', 'redeem', 'adjust', 'void')),
  -- How a sold or reloaded card was paid for; money taken counts it under this method.
  method           text CHECK (method IN ('card', 'cash', 'check', 'comp')),
  card_payment_id  uuid REFERENCES card_payments(id),
  sale_id          uuid REFERENCES sales(id),
  booking_id       uuid REFERENCES bookings(id),
  note             text,
  staff_user_id    uuid REFERENCES staff_users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_card_entries_card ON gift_card_entries (gift_card_id, created_at);
CREATE INDEX gift_card_entries_time ON gift_card_entries (created_at);

CREATE TABLE house_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id           uuid NOT NULL REFERENCES courses(id),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  -- Empty for no limit.
  credit_limit_cents  int CHECK (credit_limit_cents >= 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  billing_email       text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, customer_id)
);

CREATE TABLE house_statements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  house_account_id  uuid NOT NULL REFERENCES house_accounts(id),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  opening_cents     int  NOT NULL,
  charges_cents     int  NOT NULL,
  payments_cents    int  NOT NULL,
  closing_cents     int  NOT NULL,
  due_on            date NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (house_account_id, period_start)
);

-- Charges are positive, payments and credits negative. A statement claims the entries in its month.
CREATE TABLE house_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  house_account_id  uuid NOT NULL REFERENCES house_accounts(id),
  amount_cents      int  NOT NULL CHECK (amount_cents <> 0),
  kind              text NOT NULL CHECK (kind IN ('charge', 'payment', 'adjustment')),
  description       text NOT NULL,
  -- How a payment on the account was made.
  method            text CHECK (method IN ('card', 'cash', 'check')),
  card_payment_id   uuid REFERENCES card_payments(id),
  sale_id           uuid REFERENCES sales(id),
  booking_id        uuid REFERENCES bookings(id),
  statement_id      uuid REFERENCES house_statements(id),
  staff_user_id     uuid REFERENCES staff_users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX house_entries_account ON house_entries (house_account_id, created_at);
CREATE INDEX house_entries_time ON house_entries (created_at);

-- Gift cards and house accounts as ways to pay.
ALTER TABLE sales DROP CONSTRAINT sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('card', 'cash', 'gift_card', 'house_account', 'comp'));
ALTER TABLE sales ADD COLUMN gift_card_id uuid REFERENCES gift_cards(id);
ALTER TABLE booking_payments DROP CONSTRAINT booking_payments_method_check;
ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_method_check
  CHECK (method IN ('card', 'cash', 'prepaid', 'punch_card', 'season_pass', 'loyalty', 'rain_check', 'gift_card', 'house_account', 'comp'));
ALTER TABLE booking_payments ADD COLUMN gift_card_id uuid REFERENCES gift_cards(id);
