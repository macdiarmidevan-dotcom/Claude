-- End-of-day close: the cash drawer counted against what the system says was taken in cash.
CREATE TABLE day_closes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id            uuid NOT NULL REFERENCES courses(id),
  date                 date NOT NULL,
  -- What the tee sheet and register had taken by each method when the day was closed.
  expected             jsonb NOT NULL,
  expected_cash_cents  int  NOT NULL,
  counted_cash_cents   int  NOT NULL CHECK (counted_cash_cents >= 0),
  note                 text,
  closed_by            uuid REFERENCES staff_users(id),
  closed_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, date)
);
