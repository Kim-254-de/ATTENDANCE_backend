-- Management: the faculty portal's replacement.
--
-- The FACULTY role now signs in to the management portal, which sees every
-- department in the university (src/modules/management), so a management
-- account no longer belongs to one faculty. Existing faculty officers keep
-- theirs; an administrator invites new ones without one (NULL).
--
-- Apply with `npm run db:migrate`.

ALTER TABLE faculty_profiles ALTER COLUMN faculty_id DROP NOT NULL;
