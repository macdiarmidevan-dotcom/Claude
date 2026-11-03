-- Monthly revenue budgets by department, set by managers, for the revenue dashboard's
-- "vs budget". A month with no row has no budget. month is the first day of the month.
CREATE TABLE revenue_budgets (
  course_id              uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  month                  date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  green_fees_cents       int NOT NULL DEFAULT 0 CHECK (green_fees_cents >= 0),
  carts_and_extras_cents int NOT NULL DEFAULT 0 CHECK (carts_and_extras_cents >= 0),
  pro_shop_cents         int NOT NULL DEFAULT 0 CHECK (pro_shop_cents >= 0),
  food_bev_cents         int NOT NULL DEFAULT 0 CHECK (food_bev_cents >= 0),
  events_cents           int NOT NULL DEFAULT 0 CHECK (events_cents >= 0),
  updated_by             uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, month)
);
