-- Start of day: the pro shop counts the starting cash (float) into the drawer before taking money.
CREATE TABLE day_opens (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id            uuid NOT NULL REFERENCES courses(id),
  date                 date NOT NULL,
  starting_cash_cents  int  NOT NULL CHECK (starting_cash_cents >= 0),
  opened_by            uuid REFERENCES staff_users(id),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, date)
);

-- The close now counts the whole drawer, float included, so it keeps the float it was counted against.
-- Closes from before this kept the float out of the count, which a float of 0 reads the same way.
ALTER TABLE day_closes ADD COLUMN starting_cash_cents int NOT NULL DEFAULT 0;
