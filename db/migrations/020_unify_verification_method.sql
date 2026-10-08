-- One column for how each check-in was made, and QR + face by default.
--
-- Two branches each added a column for this: 019_face_recognition.sql added
-- attendance_records.method (QR / FACE) and 019_card_verification.sql added
-- attendance_records.verification_method (QR / FINGERPRINT / FACE / CARD).
-- verification_method covers every method, so it is kept: face records are
-- copied into it, the face evidence rule moves onto it, and method is dropped.
--
-- The lecturer's per-class choice (attendance_sessions.verification_methods)
-- defaulted to QR alone, written before face check-in existed. Face is QR's
-- fallback (docs/face-recognition.md), so a class activated without a choice
-- now accepts both.
--
-- Safe in either order of the 019 files, and on a database that already has
-- face records. Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

-- Records: method -> verification_method -------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'attendance_records' AND column_name = 'method'
  ) THEN
    UPDATE attendance_records SET verification_method = method WHERE method <> verification_method;
  END IF;
END $$;

ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_face_evidence;
ALTER TABLE attendance_records DROP COLUMN IF EXISTS method;

ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_face_evidence CHECK (
    verification_method <> 'FACE' OR (face_score IS NOT NULL AND geofence_result = 'NOT_CHECKED')
  );

-- Sessions: QR + face unless the lecturer chose otherwise ---------------------
ALTER TABLE attendance_sessions
  ALTER COLUMN verification_methods SET DEFAULT ARRAY['QR', 'FACE']::text[];

-- Classes still running when this deploys got 019's QR-only default without a
-- lecturer choosing it; give them face too. Closed and past ones keep their history.
UPDATE attendance_sessions
   SET verification_methods = ARRAY['QR', 'FACE']::text[]
 WHERE verification_methods = ARRAY['QR']::text[]
   AND status <> 'CLOSED'
   AND closes_at > NOW();
