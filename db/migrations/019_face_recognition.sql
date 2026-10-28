-- Face check-in: consent, enrolled face templates, and how each record was taken.
-- Plan: docs/face-recognition.md. Matches docs/expected-schema.md.
-- Apply with `npm run db:migrate`.

-- When the student opted in to face check-in, from their own app. NULL = not
-- consented: no lecturer can enroll them, and withdrawing deletes their templates.
-- Face templates are sensitive personal data (Kenya Data Protection Act, 2019).
ALTER TABLE users ADD COLUMN IF NOT EXISTS face_consent_at TIMESTAMPTZ;

-- One enrollment per student, used for every unit they are on. Only the
-- templates (embeddings from face-service) are kept; the photos are never stored.
CREATE TABLE IF NOT EXISTS face_enrollments (
  student_user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Which face-service model produced the templates. Templates from different
  -- models are not comparable, so a model change means re-enrolling.
  model                TEXT NOT NULL,
  -- JSON array of templates, each an array of numbers (L2-normalised).
  embeddings           JSONB NOT NULL CHECK (jsonb_typeof(embeddings) = 'array' AND jsonb_array_length(embeddings) > 0),
  enrolled_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- QR and face check-in work side by side; a student is still recorded once
-- per session (attendance_records_once_per_session), by whichever came first.
ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'QR' CHECK (method IN ('QR', 'FACE')),
  -- Cosine similarity of the confirmed match. Only for FACE.
  ADD COLUMN IF NOT EXISTS face_score REAL,
  -- The lecturer who tapped Confirm on the terminal. Only for FACE.
  ADD COLUMN IF NOT EXISTS confirmed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_face_evidence;
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_face_evidence CHECK (
    method <> 'FACE' OR (face_score IS NOT NULL AND geofence_result = 'NOT_CHECKED')
  );
