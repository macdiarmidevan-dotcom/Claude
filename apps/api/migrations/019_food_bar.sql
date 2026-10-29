-- Food and bar: menu items are products that go to a prep screen (the kitchen or the bar),
-- open tabs that collect orders through a round, and the tickets the kitchen works from.

-- Where an item is made. Empty for things handed over the counter (retail, cans from the cooler).
ALTER TABLE products ADD COLUMN station text CHECK (station IN ('kitchen', 'bar'));
-- Kept on the sale line so reports can tell food and drink from the pro shop.
ALTER TABLE sale_lines ADD COLUMN station text CHECK (station IN ('kitchen', 'bar'));
ALTER TABLE sale_lines ADD COLUMN food_bev boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN food_bev boolean NOT NULL DEFAULT false;

CREATE TABLE tabs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid NOT NULL REFERENCES courses(id),
  -- What staff call it: a golfer's name, "Table 4", "Beverage cart".
  name           text NOT NULL,
  -- Where it was opened: grill, bar, turn, cart.
  location       text NOT NULL DEFAULT 'grill' CHECK (location IN ('grill', 'bar', 'turn', 'cart')),
  customer_id    uuid REFERENCES customers(id),
  -- A tab for a group on the tee sheet, e.g. food ordered at the turn.
  booking_id     uuid REFERENCES bookings(id),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'void')),
  sale_id        uuid REFERENCES sales(id),
  opened_by      uuid REFERENCES staff_users(id),
  closed_by      uuid REFERENCES staff_users(id),
  void_reason    text,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
CREATE INDEX tabs_open ON tabs (course_id, status, opened_at);

CREATE TABLE tab_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id         uuid NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  product_id     uuid REFERENCES products(id),
  description    text NOT NULL,
  category       text NOT NULL,
  quantity       int  NOT NULL CHECK (quantity > 0),
  -- The price when it was ordered, so a menu change mid-round doesn't change the bill.
  unit_cents     int  NOT NULL CHECK (unit_cents >= 0),
  taxable        boolean NOT NULL,
  food_bev       boolean NOT NULL,
  station        text CHECK (station IN ('kitchen', 'bar')),
  -- "No onions", "Medium well".
  note           text,
  -- sent: on the prep screen; ready: made, waiting to go out; served: handed over; void: taken off.
  status         text NOT NULL CHECK (status IN ('sent', 'ready', 'served', 'void')),
  added_by       uuid REFERENCES staff_users(id),
  added_at       timestamptz NOT NULL DEFAULT now(),
  ready_at       timestamptz,
  served_at      timestamptz
);
CREATE INDEX tab_items_tab ON tab_items (tab_id);
CREATE INDEX tab_items_station ON tab_items (station, status) WHERE status IN ('sent', 'ready');
