-- A lecturer-added unit is not live until an administrator verifies it against
-- the institution's rigid timetable and lecturer allocation records (README
-- section: "unit module"). The default favours units that will eventually be
-- imported straight from the ERP, which land VERIFIED already; unit.repository.ts
-- sets PENDING_VERIFICATION explicitly on every lecturer-created unit.
-- Apply with `npm run db:migrate`.

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'VERIFIED'
    CHECK (status IN ('PENDING_VERIFICATION', 'VERIFIED'));
