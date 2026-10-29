-- Staff keys can belong to a manager, who can change course settings such as the cart waiver.
ALTER TABLE api_keys ADD COLUMN role text NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'manager'));
