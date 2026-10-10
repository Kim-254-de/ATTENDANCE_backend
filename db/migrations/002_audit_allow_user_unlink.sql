-- audit_logs stays append-only, with ONE exception: when a user row is hard-deleted the FK
-- (ON DELETE SET NULL) must be able to clear user_id. Any other UPDATE, and any DELETE, is refused.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NULL
     AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END; $$ LANGUAGE plpgsql;
