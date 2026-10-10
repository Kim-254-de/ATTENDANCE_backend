-- Students and lecturers sign in with their SMARTTT account. Attendance keeps
-- its own row for each (attendance history, sessions, passkeys hang off it),
-- created or linked on first sign-in and keyed by SMARTTT's user id from then
-- on, so a changed email or admission number in SMARTTT still finds it.
-- Plan: docs/smarttt-accounts.md.
-- Apply with `npm run db:migrate`.

ALTER TABLE users ADD COLUMN IF NOT EXISTS smarttt_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_smarttt_user_id_key ON users (smarttt_user_id) WHERE smarttt_user_id IS NOT NULL;
