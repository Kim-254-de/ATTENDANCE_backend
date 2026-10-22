-- An internal audit: a QA officer's scheduled review of one department or
-- one faculty, against one checklist template. Exactly one of
-- target_department_id/target_faculty_id is set — an audit targets a single
-- org unit, never both and never neither.
--
-- audit_type is deliberately CHECK'd to 'INTERNAL' only for now: Phase 1
-- EQA reviewers get no account and run no audits of their own inside this
-- system (report-only access to what IQA exports). The column exists so a
-- later phase can widen the CHECK to add 'EQA' without a schema change.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS qa_audits (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                  VARCHAR(200) NOT NULL,
  audit_type             VARCHAR(16) NOT NULL DEFAULT 'INTERNAL' CHECK (audit_type IN ('INTERNAL')),
  target_department_id   UUID REFERENCES departments(id),
  target_faculty_id      UUID REFERENCES faculties(id),
  checklist_template_id  UUID NOT NULL REFERENCES qa_checklist_templates(id),
  lead_auditor_user_id   UUID NOT NULL REFERENCES users(id),
  scheduled_date         DATE NOT NULL,
  status                 VARCHAR(16) NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED')),
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  notes                  TEXT,
  created_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(target_department_id, target_faculty_id) = 1)
);
CREATE INDEX IF NOT EXISTS qa_audits_target_department_idx ON qa_audits (target_department_id);
CREATE INDEX IF NOT EXISTS qa_audits_target_faculty_idx ON qa_audits (target_faculty_id);
CREATE INDEX IF NOT EXISTS qa_audits_lead_auditor_idx ON qa_audits (lead_auditor_user_id);
CREATE INDEX IF NOT EXISTS qa_audits_status_idx ON qa_audits (status);
CREATE INDEX IF NOT EXISTS qa_audits_scheduled_date_idx ON qa_audits (scheduled_date);

DROP TRIGGER IF EXISTS qa_audits_updated ON qa_audits;
CREATE TRIGGER qa_audits_updated BEFORE UPDATE ON qa_audits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
