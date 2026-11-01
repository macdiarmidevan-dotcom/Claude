-- Requests staff send from the help center's Email support form. Each one is emailed to the
-- support inbox; the row keeps a copy and a reference number to quote in replies.
CREATE SEQUENCE support_request_number;

CREATE TABLE support_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        bigint NOT NULL DEFAULT nextval('support_request_number') UNIQUE,
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  topic         text NOT NULL CHECK (topic IN ('question', 'problem', 'billing', 'idea')),
  subject       text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  reply_to      text NOT NULL,
  -- The part of the app they were on when they wrote in.
  page          text,
  status        text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_requests_course_idx ON support_requests (course_id, created_at DESC);
