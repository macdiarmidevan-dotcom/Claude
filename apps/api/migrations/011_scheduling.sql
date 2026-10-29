-- Staff scheduling: shifts, a time clock, and shift swaps between coworkers.

-- Whether a swap the coworker accepted still needs a manager's OK. On unless a manager turns it off.
ALTER TABLE courses ADD COLUMN swaps_need_approval boolean NOT NULL DEFAULT true;

CREATE TABLE shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid NOT NULL REFERENCES courses(id),
  -- Empty for an open shift nobody has been given yet.
  staff_user_id     uuid REFERENCES staff_users(id),
  employee_type_id  uuid REFERENCES employee_types(id),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL CHECK (ends_at > starts_at),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shifts_course_time ON shifts (course_id, starts_at);
CREATE INDEX shifts_staff_time ON shifts (staff_user_id, starts_at);

CREATE TABLE time_punches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       uuid NOT NULL REFERENCES courses(id),
  staff_user_id   uuid NOT NULL REFERENCES staff_users(id),
  shift_id        uuid REFERENCES shifts(id) ON DELETE SET NULL,
  clock_in        timestamptz NOT NULL,
  clock_out       timestamptz CHECK (clock_out IS NULL OR clock_out > clock_in),
  -- Set when a manager corrects a punch, so timesheets show it was changed.
  edited_by       uuid REFERENCES staff_users(id),
  edited_at       timestamptz
);
-- Someone can only be clocked in once at a time.
CREATE UNIQUE INDEX time_punches_open ON time_punches (staff_user_id) WHERE clock_out IS NULL;
CREATE INDEX time_punches_course_time ON time_punches (course_id, clock_in);

CREATE TABLE shift_swaps (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id              uuid NOT NULL REFERENCES courses(id),
  -- The requester's shift. With a requested shift it's a swap; without, they're giving it away.
  offered_shift_id       uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  requested_shift_id     uuid REFERENCES shifts(id) ON DELETE CASCADE,
  from_user_id           uuid NOT NULL REFERENCES staff_users(id),
  to_user_id             uuid NOT NULL REFERENCES staff_users(id),
  message                text,
  status                 text NOT NULL DEFAULT 'awaiting_coworker'
                         CHECK (status IN ('awaiting_coworker', 'awaiting_manager', 'approved', 'declined', 'rejected', 'cancelled')),
  coworker_responded_at  timestamptz,
  manager_id             uuid REFERENCES staff_users(id),
  manager_responded_at   timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shift_swaps_course ON shift_swaps (course_id, status);
