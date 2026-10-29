-- The daily summary sent to the bookkeeping system (QuickBooks or Xero): which account each kind
-- of money goes to, and a record of what was exported so a day isn't entered twice.

-- Account names (or codes, for Xero) by key; anything missing uses the default name.
ALTER TABLE courses ADD COLUMN accounting_accounts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE courses ADD COLUMN accounting_format text NOT NULL DEFAULT 'quickbooks' CHECK (accounting_format IN ('quickbooks', 'xero'));

CREATE TABLE accounting_exports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid NOT NULL REFERENCES courses(id),
  from_date      date NOT NULL,
  to_date        date NOT NULL,
  format         text NOT NULL,
  total_cents    int  NOT NULL,
  staff_user_id  uuid REFERENCES staff_users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_exports_course ON accounting_exports (course_id, created_at DESC);
