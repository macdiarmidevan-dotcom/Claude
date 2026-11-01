-- Cart fleet, equipment and work orders.

-- Every cart and piece of equipment the course keeps running. Carts are counted in rounds between
-- services (from the cart numbers the starter assigns); equipment by its hour meter.
CREATE TABLE fleet_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id           uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('cart', 'equipment')),
  -- The number painted on a cart, or the unit name for equipment ("Greens mower 2").
  number              text NOT NULL,
  model               text,
  power               text CHECK (power IN ('gas', 'electric', 'diesel', 'other')),
  serial              text,
  status              text NOT NULL DEFAULT 'in_service' CHECK (status IN ('in_service', 'out_of_service', 'retired')),
  status_note         text,
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  -- Rounds for carts, hours for equipment. Null means no schedule.
  service_every       int CHECK (service_every > 0),
  hours               numeric(8, 1) CHECK (hours >= 0),
  last_service_at     timestamptz,
  last_service_hours  numeric(8, 1),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, kind, number)
);

CREATE TABLE work_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  -- Short number staff can say out loud ("work order 14"), counted per course.
  number        int  NOT NULL,
  title         text NOT NULL,
  details       text,
  area          text NOT NULL CHECK (area IN ('carts', 'equipment', 'course', 'clubhouse', 'other')),
  location      text,
  asset_id      uuid REFERENCES fleet_assets(id) ON DELETE SET NULL,
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'on_hold', 'done', 'cancelled')),
  assigned_to   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  reported_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  due_date      date,
  cost_cents    int NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, number)
);
CREATE INDEX work_orders_open ON work_orders (course_id, status);
CREATE INDEX work_orders_asset ON work_orders (asset_id);

-- The history on a work order: notes, and each change of status.
CREATE TABLE work_order_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id  uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  staff_user_id  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  note           text,
  status         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_order_notes_order ON work_order_notes (work_order_id, created_at);

-- Services and repairs done on a cart or piece of equipment.
CREATE TABLE fleet_service (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES fleet_assets(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('service', 'repair', 'inspection')),
  note           text,
  cost_cents     int NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  hours          numeric(8, 1),
  work_order_id  uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  staff_user_id  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_service_asset ON fleet_service (asset_id, created_at);

-- When the starter marks a group's carts back in. Carts also count as back six hours after tee off.
ALTER TABLE bookings ADD COLUMN carts_in_at timestamptz;
