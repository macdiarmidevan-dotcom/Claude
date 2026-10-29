-- Each cart's driver signs the course's liability waiver before the cart is assigned.

CREATE TABLE course_waivers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, version)
);
-- Only one waiver is shown to drivers at a time.
CREATE UNIQUE INDEX course_waivers_one_active ON course_waivers (course_id) WHERE active;

CREATE TABLE cart_waivers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- The exact waiver version signed, kept even after the course updates its wording.
  waiver_id    uuid NOT NULL REFERENCES course_waivers(id),
  cart_number  text NOT NULL,
  driver_name  text NOT NULL,
  -- SVG path data of the drawn signature, in a 600 x 200 box.
  signature    text NOT NULL,
  signed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, cart_number)
);
