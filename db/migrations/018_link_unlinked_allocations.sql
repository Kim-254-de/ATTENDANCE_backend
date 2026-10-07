-- Roster rows synced after a student registered were never attached to their
-- account (only registration ran linkAllocationsToStudent), so those students
-- were refused at check-in as "not registered" for units they are on.
-- syncRosterAllocations now links them on every sync; this attaches the rows
-- already stuck. Apply with `npm run db:migrate`.

UPDATE unit_allocations a
   SET student_user_id = p.user_id, updated_at = NOW()
  FROM student_profiles p
 WHERE a.student_user_id IS NULL
   AND p.registration_number = a.registration_number
   AND NOT EXISTS (
     SELECT 1 FROM unit_allocations b WHERE b.unit_id = a.unit_id AND b.student_user_id = p.user_id
   );
