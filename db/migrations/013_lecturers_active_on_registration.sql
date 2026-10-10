-- Lecturers no longer confirm their email or wait for an administrator: a
-- lecturer whose staff number the ERP verifies is ACTIVE on registration
-- (auth.service.ts registerLecturer) and signs in straight away.
--
-- Accounts registered before this change are stuck in the old steps (the
-- confirmation email was never delivered in production, and there is no
-- approval screen), so they are activated here. Suspended and deactivated
-- accounts are left alone: those are deliberate decisions, not pending steps.
-- Students are not touched: they still confirm their email.
-- Apply with `npm run db:migrate` (Render runs it on every start).

UPDATE users
   SET status = 'ACTIVE',
       updated_at = NOW()
 WHERE role = 'LECTURER'
   AND status IN ('PENDING_VERIFICATION', 'PENDING_APPROVAL');

-- Their unused confirmation links are no longer needed.
UPDATE email_verification_tokens t
   SET consumed_at = NOW()
  FROM users u
 WHERE u.id = t.user_id
   AND u.role = 'LECTURER'
   AND t.consumed_at IS NULL;
