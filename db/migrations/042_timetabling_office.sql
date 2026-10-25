-- The timetabling office: the Directorate of Examinations and Timetabling,
-- who use the Timetable Generator. An administrator invites them here like any
-- other officer; they choose a password from the invitation and sign in at
-- the Generator, which checks it with attendance
-- (POST /integrations/generator/authenticate). University-wide, so the role
-- needs no profile row. They have no portal in attendance itself.
--
-- Apply with `npm run db:migrate`.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('LECTURER','STUDENT','ADMIN','DEPARTMENT','MANAGEMENT','QA','TIMETABLING'));
