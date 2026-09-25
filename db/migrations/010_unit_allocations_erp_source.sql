-- A unit's roster is now synced from the ERP's enrollment records
-- (unit.repository.ts syncAllocationsFromErp) instead of a lecturer adding
-- students or a student self-enrolling — 'ERP' joins the existing sources.
-- 'LECTURER' and 'SELF_ENROLLED' are kept on the constraint for historical
-- rows written before this change; nothing writes them any more.
-- Apply with `npm run db:migrate`.

ALTER TABLE unit_allocations DROP CONSTRAINT IF EXISTS unit_allocations_source_check;
ALTER TABLE unit_allocations
  ADD CONSTRAINT unit_allocations_source_check CHECK (source IN ('LECTURER', 'SELF_ENROLLED', 'ERP'));
