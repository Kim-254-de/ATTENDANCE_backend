-- One department, many spellings.
--
-- SMARTTT and the ERP name a lecturer's department in free text, typed by
-- hand: "Computer Science", "Dept. of Computer Science", "Comp. Sci & IT". An
-- exact match (021_departments.sql, and sign-in until now) treats each as a
-- different department, so lecturers land unassigned and departments get
-- created twice. Three things unify the spelling:
--
--   1. department_key(): a canonical form of a department name, used on both
--      sides of every match, so spelling noise never matters.
--   2. department_aliases: spellings learned when an officer places an
--      unassigned lecturer, or recorded when two departments are merged, so
--      the next lecturer with that spelling is placed automatically.
--   3. merge_departments(): folds a duplicate department into the real one,
--      moving everything that points at it, and keeps its name as an alias.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

-- "Dept. of Comp. Sci & IT" -> "computer science and information technology".
-- Lower-cased; dotted initials joined ("I.T." -> "it"); other punctuation
-- dropped; "&" read as "and"; a leading "department of" / "dept of" / "the
-- department of" removed; common abbreviations expanded word by word; spaces
-- collapsed. IMMUTABLE so it can be indexed.
CREATE OR REPLACE FUNCTION department_key(name TEXT) RETURNS TEXT AS $$
  SELECT NULLIF(btrim(regexp_replace(
           string_agg(
             CASE w
               WHEN 'comp' THEN 'computer'   WHEN 'cs' THEN 'computer science'
               WHEN 'sci' THEN 'science'     WHEN 'scs' THEN 'sciences'
               WHEN 'it' THEN 'information technology'
               WHEN 'ict' THEN 'information and communication technology'
               WHEN 'info' THEN 'information' WHEN 'tech' THEN 'technology'
               WHEN 'eng' THEN 'engineering' WHEN 'engg' THEN 'engineering' WHEN 'engr' THEN 'engineering'
               WHEN 'mgt' THEN 'management'  WHEN 'mgmt' THEN 'management' WHEN 'mngt' THEN 'management'
               WHEN 'admin' THEN 'administration' WHEN 'bus' THEN 'business'
               WHEN 'econ' THEN 'economics'  WHEN 'educ' THEN 'education' WHEN 'edu' THEN 'education'
               WHEN 'math' THEN 'mathematics' WHEN 'maths' THEN 'mathematics'
               WHEN 'stat' THEN 'statistics' WHEN 'stats' THEN 'statistics'
               WHEN 'phys' THEN 'physics'    WHEN 'chem' THEN 'chemistry' WHEN 'bio' THEN 'biology'
               WHEN 'agric' THEN 'agriculture' WHEN 'agri' THEN 'agriculture'
               WHEN 'env' THEN 'environmental' WHEN 'nat' THEN 'natural' WHEN 'res' THEN 'resources'
               WHEN 'hum' THEN 'humanities' WHEN 'soc' THEN 'social'
               WHEN 'comm' THEN 'communication' WHEN 'dev' THEN 'development'
               ELSE w
             END, ' ' ORDER BY ord),
           '\s+', ' ', 'g')), '')
    FROM regexp_split_to_table(
           regexp_replace(
             regexp_replace(
               -- "I.T." -> "it": dotted initials join up before other punctuation becomes spaces.
               regexp_replace(
                 regexp_replace(lower(coalesce(name, '')), '&', ' and ', 'g'),
                 '\m([a-z])\.(?=[a-z](\.|\M))', '\1', 'g'),
               '[^a-z0-9 ]+', ' ', 'g'),
             '^\s*(the\s+)?(department|dept|dpt)\s+(of\s+)?', ''),
           '\s+') WITH ORDINALITY AS t(w, ord)
   WHERE w <> ''
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE INDEX IF NOT EXISTS departments_key_idx ON departments (department_key(name));

CREATE TABLE IF NOT EXISTS department_aliases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- department_key(alias): one spelling can mean only one department.
  alias_key           TEXT NOT NULL UNIQUE,
  -- The spelling as it was first seen, for showing to an administrator.
  alias               VARCHAR(160) NOT NULL,
  department_id       UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  -- PLACEMENT: learned when an officer placed a lecturer. MERGE: a merged department's old name.
  source              VARCHAR(16) NOT NULL CHECK (source IN ('PLACEMENT','MERGE')),
  created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS department_aliases_department_idx ON department_aliases (department_id);

-- The department a free-text name refers to: by canonical name first, then by
-- learned alias. NULL when neither matches. Every name match in the backend
-- goes through this, so sign-in, registration and department creation agree.
CREATE OR REPLACE FUNCTION department_for_name(name TEXT) RETURNS UUID AS $$
  SELECT id FROM (
    SELECT d.id, 0 AS rank, d.name FROM departments d WHERE department_key(d.name) = department_key($1)
    UNION ALL
    SELECT a.department_id, 1, a.alias FROM department_aliases a WHERE a.alias_key = department_key($1)
  ) m
  WHERE department_key($1) IS NOT NULL
  ORDER BY rank, name
  LIMIT 1
$$ LANGUAGE sql STABLE;

-- Folds department `dup` into `keep`: everything that pointed at `dup` points
-- at `keep`, `dup`'s name and aliases become `keep`'s aliases, and `dup` is
-- deleted. One transaction (the caller's), all or nothing.
CREATE OR REPLACE FUNCTION merge_departments(dup UUID, keep UUID, actor UUID) RETURNS VOID AS $$
BEGIN
  IF dup = keep THEN RAISE EXCEPTION 'cannot merge a department into itself'; END IF;
  UPDATE lecturer_profiles       SET department_id = keep WHERE department_id = dup;
  UPDATE department_profiles     SET department_id = keep WHERE department_id = dup;
  UPDATE course_offerings        SET department_id = keep WHERE department_id = dup;
  UPDATE units                   SET department_id = keep WHERE department_id = dup;
  UPDATE qa_audits               SET target_department_id = keep WHERE target_department_id = dup;
  UPDATE qa_evaluation_responses SET department_id = keep WHERE department_id = dup;
  UPDATE department_aliases      SET department_id = keep WHERE department_id = dup;
  INSERT INTO department_aliases (alias_key, alias, department_id, source, created_by_user_id)
  SELECT department_key(name), name, keep, 'MERGE', actor FROM departments
   WHERE id = dup AND department_key(name) IS NOT NULL
     AND department_key(name) IS DISTINCT FROM (SELECT department_key(name) FROM departments WHERE id = keep)
  ON CONFLICT (alias_key) DO UPDATE SET department_id = EXCLUDED.department_id;
  DELETE FROM departments WHERE id = dup;
END;
$$ LANGUAGE plpgsql;
