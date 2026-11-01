-- What each person is paid, for the labor cost report. Managers see and set it.
-- Hourly: cents per hour. Salary: cents per year, spread evenly over every day.
ALTER TABLE staff_users ADD COLUMN pay_type text CHECK (pay_type IN ('hourly', 'salary'));
ALTER TABLE staff_users ADD COLUMN pay_cents int CHECK (pay_cents >= 0);
ALTER TABLE staff_users ADD CONSTRAINT staff_users_pay CHECK ((pay_type IS NULL) = (pay_cents IS NULL));
