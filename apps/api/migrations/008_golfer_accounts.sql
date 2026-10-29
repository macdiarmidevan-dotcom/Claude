-- Golfer accounts. The pro shop creates one the first time a golfer is checked in, with the
-- golfer's own phone and email; after that staff find it by name. Customers without an account
-- are the placeholders that walk-ins and imported bookings start with.

ALTER TABLE customers
  ADD COLUMN account_created_at timestamptz,
  ADD COLUMN account_created_by uuid REFERENCES staff_users(id);

-- One account per phone number in an organization (digits only, so formatting doesn't matter).
CREATE UNIQUE INDEX customers_account_phone ON customers (organization_id, regexp_replace(phone, '\D', '', 'g'))
  WHERE account_created_at IS NOT NULL;

CREATE INDEX customers_account_name ON customers (organization_id, lower(name)) WHERE account_created_at IS NOT NULL;
