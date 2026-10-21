-- A corrective action plan (CAPA): raised against a NON_COMPLIANT or
-- PARTIAL finding (enforced in capa.service.ts, not here — a CHECK can't see
-- another table's row), assigned to an owner, and tracked to verified
-- closure.
--
-- The CHECK ties status to the verification pair: VERIFIED/CLOSED must carry
-- who verified it and when, OPEN/IN_PROGRESS must not — so a half-verified
-- row (a status without a verifier, or a verifier without the status) can
-- never be written, regardless of which caller is doing the writing.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS qa_corrective_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id           UUID NOT NULL REFERENCES qa_audit_findings(id) ON DELETE CASCADE,
  description          TEXT NOT NULL,
  owner_user_id        UUID NOT NULL REFERENCES users(id),
  due_date             DATE NOT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','VERIFIED','CLOSED')),
  verified_by_user_id  UUID REFERENCES users(id),
  verified_at          TIMESTAMPTZ,
  created_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status IN ('VERIFIED','CLOSED')) = (verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS qa_corrective_actions_finding_idx ON qa_corrective_actions (finding_id);
CREATE INDEX IF NOT EXISTS qa_corrective_actions_owner_idx ON qa_corrective_actions (owner_user_id);
CREATE INDEX IF NOT EXISTS qa_corrective_actions_status_idx ON qa_corrective_actions (status);
CREATE INDEX IF NOT EXISTS qa_corrective_actions_due_date_idx ON qa_corrective_actions (due_date);

DROP TRIGGER IF EXISTS qa_corrective_actions_updated ON qa_corrective_actions;
CREATE TRIGGER qa_corrective_actions_updated BEFORE UPDATE ON qa_corrective_actions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
