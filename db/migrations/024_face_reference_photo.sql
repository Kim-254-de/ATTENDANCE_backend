-- Face check-in: keep one small photo from each enrollment, so the terminal
-- shows the lecturer the face that was registered rather than the student's
-- own profile picture (which they choose, and may not have set).
-- Plan: docs/face-recognition.md. Matches docs/expected-schema.md.
-- Apply with `npm run db:migrate`.

-- A 160x160 JPEG data URL of the straight-on enrollment photo's face, cropped
-- by face-service. NULL for enrollments made before this column existed; they
-- get one when re-enrolled. Deleted with the row, so withdrawing consent or
-- removing the enrollment removes it too.
ALTER TABLE face_enrollments
  ADD COLUMN IF NOT EXISTS reference_photo TEXT
    CHECK (reference_photo IS NULL OR (reference_photo LIKE 'data:image/jpeg;base64,%' AND length(reference_photo) <= 60000));
