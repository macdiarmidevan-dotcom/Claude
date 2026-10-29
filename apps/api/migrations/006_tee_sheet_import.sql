-- Bookings imported from the course's booking provider keep that system's id, so a
-- re-import updates them instead of adding duplicates.
ALTER TABLE bookings ADD COLUMN external_id text;
CREATE UNIQUE INDEX bookings_external_idx ON bookings (course_id, source, external_id) WHERE external_id IS NOT NULL;

-- 'import' is a file from anywhere else, such as a spreadsheet.
ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check
  CHECK (source IN ('staff', 'phone', 'teeitup', 'golfnow', 'import'));

CREATE TABLE import_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source      text NOT NULL,
  file_name   text,
  dates       text[] NOT NULL,
  created     int NOT NULL,
  updated     int NOT NULL,
  cancelled   int NOT NULL,
  unchanged   int NOT NULL,
  problems    jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_runs_course_idx ON import_runs (course_id, created_at DESC);
