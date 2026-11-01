-- Add-ons a manager has switched on or off. A missing row means the add-on's default.
CREATE TABLE course_add_ons (
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  key        text NOT NULL,
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, key)
);
