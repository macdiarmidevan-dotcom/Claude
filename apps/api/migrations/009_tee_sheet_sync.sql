-- Automatic tee sheet sync. Each course can have one connection that pulls its booking
-- provider's tee sheet on a schedule and runs it through the same import as an uploaded file.

CREATE TABLE sync_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid NOT NULL UNIQUE REFERENCES courses(id),
  source            text NOT NULL CHECK (source IN ('teeitup', 'golfnow', 'import')),
  -- report_url: a link to a tee sheet export the provider publishes. provider_api: the
  -- provider's own API, which needs partner access from them.
  method            text NOT NULL CHECK (method IN ('report_url', 'provider_api')),
  report_url        text,
  -- Provider sign-in details, encrypted with SYNC_SECRET. Never sent back to the app.
  credentials_enc   text,
  enabled           boolean NOT NULL DEFAULT true,
  interval_minutes  int NOT NULL DEFAULT 10 CHECK (interval_minutes BETWEEN 5 AND 1440),
  last_run_at       timestamptz,
  last_status       text CHECK (last_status IN ('ok', 'error', 'waiting')),
  last_message      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Whether an import came from someone uploading a file or from the automatic sync.
ALTER TABLE import_runs ADD COLUMN via text NOT NULL DEFAULT 'upload' CHECK (via IN ('upload', 'sync'));
