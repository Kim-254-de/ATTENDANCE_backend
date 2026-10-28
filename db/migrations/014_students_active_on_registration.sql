-- Students no longer confirm their email either: a student whose registration
-- number the directory verifies is ACTIVE on registration (auth.service.ts
-- registerStudent) and signs in straight away, the same as lecturers (013).
--
-- Students registered before this change are stuck waiting for a confirmation
-- email, so they are activated here. Suspended and deactivated accounts are
-- left alone: those are deliberate decisions, not pending steps.
-- Apply with `npm run db:migrate` (Render runs it on every start).

UPDATE users
   SET status = 'ACTIVE',
       updated_at = NOW()
 WHERE role = 'STUDENT'
   AND status IN ('PENDING_VERIFICATION', 'PENDING_APPROVAL');

-- Their unused confirmation links are no longer needed.
UPDATE email_verification_tokens t
   SET consumed_at = NOW()
  FROM users u
 WHERE u.id = t.user_id
   AND u.role = 'STUDENT'
   AND t.consumed_at IS NULL;

-- Put the newly active students on the rosters that already list them, as
-- registerStudent does for new accounts.
-- (Same guard as unit.repository.ts linkAllocationsToStudent.)
UPDATE unit_allocations a
   SET student_user_id = p.user_id,
       updated_at = NOW()
  FROM student_profiles p
 WHERE a.registration_number = p.registration_number
   AND a.student_user_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM unit_allocations b WHERE b.unit_id = a.unit_id AND b.student_user_id = p.user_id
   );
