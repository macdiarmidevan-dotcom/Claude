-- Each employee and manager signs in as themselves, instead of sharing a device key.
CREATE TABLE staff_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name           text NOT NULL,
  email          text NOT NULL,
  role           text NOT NULL CHECK (role IN ('staff', 'manager')),
  -- scrypt$<salt>$<hash>, never the password itself.
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
CREATE UNIQUE INDEX staff_users_email_idx ON staff_users (course_id, lower(email));

CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

-- Who did what: check-ins, payments, cancellations, imports, setting changes.
CREATE TABLE activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Kept as written at the time, so the log still reads right if someone is renamed.
  actor       text NOT NULL,
  action      text NOT NULL,
  booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_course_idx ON activity_log (course_id, created_at DESC);
