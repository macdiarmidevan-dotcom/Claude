-- Starters assign cart numbers at check-in.
ALTER TABLE bookings ADD COLUMN cart_numbers text[] NOT NULL DEFAULT '{}';

-- Golfers no longer book through our API; bookings come from staff or are imported
-- from the course's booking provider.
ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
UPDATE bookings SET source = 'staff' WHERE source IN ('web', 'widget', 'api');
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check
  CHECK (source IN ('staff', 'phone', 'teeitup', 'golfnow'));
