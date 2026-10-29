-- Employee types: the job someone does (Pro Shop, Ranger/Starter, Cart Attendant, ...). This is
-- separate from their role (staff or manager), which decides what they're allowed to change.
-- Each course starts with a standard list and managers add their own.

CREATE TABLE employee_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id),
  name        text NOT NULL,
  position    int  NOT NULL DEFAULT 0,
  -- Removed types stay attached to the people who had them but aren't offered any more.
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX employee_types_name ON employee_types (course_id, lower(name)) WHERE active;

ALTER TABLE staff_users ADD COLUMN employee_type_id uuid REFERENCES employee_types(id);

INSERT INTO employee_types (course_id, name, position)
SELECT c.id, t.name, t.position
  FROM courses c
 CROSS JOIN (VALUES ('Pro Shop', 1), ('Ranger/Starter', 2), ('Cart Attendant', 3), ('Bartender', 4),
                    ('Food & Beverage', 5), ('Grounds Crew', 6)) AS t(name, position);
