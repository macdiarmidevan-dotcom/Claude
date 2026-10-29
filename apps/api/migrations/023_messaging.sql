-- Golfer messaging by email and text. Until the course picks a provider every message goes through
-- the simulator: it's recorded as if sent, so staff can see exactly who would have got what.

ALTER TABLE customers ADD COLUMN email_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN sms_opt_out boolean NOT NULL DEFAULT false;

ALTER TABLE courses ADD COLUMN message_from_name text;
ALTER TABLE courses ADD COLUMN message_reply_to text;
ALTER TABLE courses ADD COLUMN message_signature text;

-- One send to a group of golfers: everyone booked on a day, a league, all golfers, and so on.
CREATE TABLE message_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  -- marketing respects opt-outs; operational (a change to their tee time) and statements don't.
  kind        text NOT NULL CHECK (kind IN ('marketing', 'operational', 'statement')),
  audience    jsonb NOT NULL,
  audience_label text NOT NULL,
  channels    text[] NOT NULL,
  subject     text,
  body        text NOT NULL,
  sent_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_campaigns_course ON message_campaigns (course_id, created_at DESC);

CREATE TABLE messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  campaign_id  uuid REFERENCES message_campaigns(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
  booking_id   uuid REFERENCES bookings(id) ON DELETE SET NULL,
  name         text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email', 'sms')),
  to_address   text,
  subject      text,
  body         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  -- Why it was skipped or failed.
  reason       text,
  provider     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_campaign ON messages (campaign_id);
CREATE INDEX messages_customer ON messages (customer_id, created_at DESC);
