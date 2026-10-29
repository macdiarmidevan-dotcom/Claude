-- Weather delays: frost, fog, lightning. Pushing the tee sheet back moves every tee time from a
-- point in the day later by the same amount, groups and all, and records it so the times made
-- from the course's templates and synced from the booking system land on the delayed sheet too.
CREATE TABLE tee_sheet_delays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date         date NOT NULL,
  -- The first tee time moved, as it was before the delay.
  from_at      timestamptz NOT NULL,
  minutes      int  NOT NULL CHECK (minutes BETWEEN 5 AND 300),
  reason       text NOT NULL CHECK (reason IN ('frost', 'fog', 'rain', 'lightning', 'heat', 'course', 'other')),
  note         text,
  tee_times    int  NOT NULL,
  groups       int  NOT NULL,
  campaign_id  uuid REFERENCES message_campaigns(id) ON DELETE SET NULL,
  staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  undone_at    timestamptz,
  undone_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL
);
CREATE INDEX tee_sheet_delays_day ON tee_sheet_delays (course_id, date);
