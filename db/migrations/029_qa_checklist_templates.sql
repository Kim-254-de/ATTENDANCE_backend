-- Reusable checklist templates an audit is run against. A template is just a
-- named, ordered list of items, each tied to one standard (028) so an
-- audit's findings roll up cleanly by standard/category.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS qa_checklist_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(160) NOT NULL,
  description         TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qa_checklist_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  UUID NOT NULL REFERENCES qa_checklist_templates(id) ON DELETE CASCADE,
  standard_id  UUID NOT NULL REFERENCES qa_standards(id),
  prompt       TEXT NOT NULL,
  guidance     TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS qa_checklist_items_template_idx ON qa_checklist_items (template_id);
CREATE INDEX IF NOT EXISTS qa_checklist_items_standard_idx ON qa_checklist_items (standard_id);

DROP TRIGGER IF EXISTS qa_checklist_templates_updated ON qa_checklist_templates;
CREATE TRIGGER qa_checklist_templates_updated BEFORE UPDATE ON qa_checklist_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS qa_checklist_items_updated ON qa_checklist_items;
CREATE TRIGGER qa_checklist_items_updated BEFORE UPDATE ON qa_checklist_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
