-- Feedback staff send from the account menu: what's confusing, broken or missing. Managers read it.
CREATE TABLE staff_feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- The part of the app they were on when they sent it.
  page          text,
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_feedback_course_idx ON staff_feedback (course_id, created_at DESC);
