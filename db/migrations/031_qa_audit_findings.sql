-- One finding per (audit, checklist item): the rating a QA officer records
-- while working through an audit's checklist. The UNIQUE constraint is what
-- makes recording a finding a true upsert (INSERT ... ON CONFLICT
-- (audit_id, checklist_item_id) DO UPDATE) — the same load-bearing unique
-- index attendance_records uses for a check-in.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS qa_audit_findings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id            UUID NOT NULL REFERENCES qa_audits(id) ON DELETE CASCADE,
  checklist_item_id   UUID NOT NULL REFERENCES qa_checklist_items(id),
  rating              VARCHAR(16) NOT NULL CHECK (rating IN ('COMPLIANT','PARTIAL','NON_COMPLIANT','NOT_APPLICABLE')),
  score               NUMERIC(5,2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  evidence_notes      TEXT,
  recorded_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (audit_id, checklist_item_id)
);
CREATE INDEX IF NOT EXISTS qa_audit_findings_audit_idx ON qa_audit_findings (audit_id);
CREATE INDEX IF NOT EXISTS qa_audit_findings_rating_idx ON qa_audit_findings (rating);

DROP TRIGGER IF EXISTS qa_audit_findings_updated ON qa_audit_findings;
CREATE TRIGGER qa_audit_findings_updated BEFORE UPDATE ON qa_audit_findings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
