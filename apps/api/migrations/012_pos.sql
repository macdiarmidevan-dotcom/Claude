-- Pro shop point of sale and inventory: products with stock counts, sales rung up at the
-- register, and a record of every stock change.

-- Sales tax on taxable items, in basis points (725 = 7.25%). Zero until a manager sets it.
ALTER TABLE courses ADD COLUMN sales_tax_bps int NOT NULL DEFAULT 0 CHECK (sales_tax_bps BETWEEN 0 AND 2000);
-- Receipt numbers count up per course.
ALTER TABLE courses ADD COLUMN next_sale_number int NOT NULL DEFAULT 1;

CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid NOT NULL REFERENCES courses(id),
  name           text NOT NULL,
  sku            text,
  category       text NOT NULL DEFAULT 'Other',
  price_cents    int  NOT NULL CHECK (price_cents >= 0),
  cost_cents     int  CHECK (cost_cents >= 0),
  taxable        boolean NOT NULL DEFAULT true,
  -- Things like range tokens or lessons don't have stock to count.
  track_stock    boolean NOT NULL DEFAULT true,
  -- Can go below zero when something is sold that the count missed; the next count fixes it.
  stock          int  NOT NULL DEFAULT 0,
  reorder_level  int  NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku ON products (course_id, lower(sku)) WHERE sku IS NOT NULL;
CREATE INDEX products_course ON products (course_id, lower(name));

CREATE TABLE sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       uuid NOT NULL REFERENCES courses(id),
  number          int  NOT NULL,
  staff_user_id   uuid REFERENCES staff_users(id),
  -- The golfer account the sale is for, if staff picked one.
  customer_id     uuid REFERENCES customers(id),
  subtotal_cents  int  NOT NULL,
  tax_cents       int  NOT NULL,
  total_cents     int  NOT NULL,
  payment_method  text NOT NULL CHECK (payment_method IN ('card', 'cash', 'gift_card', 'comp')),
  status          text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
  refunded_at     timestamptz,
  refunded_by     uuid REFERENCES staff_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, number)
);
CREATE INDEX sales_course_time ON sales (course_id, created_at);

CREATE TABLE sale_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  -- Empty for a one-off item typed in at the register.
  product_id   uuid REFERENCES products(id),
  description  text NOT NULL,
  category     text NOT NULL,
  quantity     int  NOT NULL CHECK (quantity > 0),
  unit_cents   int  NOT NULL CHECK (unit_cents >= 0),
  total_cents  int  NOT NULL,
  taxable      boolean NOT NULL
);

CREATE TABLE stock_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES products(id),
  change         int  NOT NULL,
  stock_after    int  NOT NULL,
  reason         text NOT NULL CHECK (reason IN ('sale', 'refund', 'receive', 'count', 'adjust')),
  sale_id        uuid REFERENCES sales(id),
  note           text,
  staff_user_id  uuid REFERENCES staff_users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product ON stock_movements (product_id, created_at DESC);
