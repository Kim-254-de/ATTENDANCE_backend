-- The classes SMARTTT says a student is registered for this term
-- (src/modules/student: student.service syncMyUnitsFromTimetable), so a
-- student sees every unit they take, including those whose lecturer hasn't
-- set them up here yet. `code` is the section code the lecturer-units sync
-- gives the unit ("COSC 103 GR A", or "COSC 103" when not split), which is
-- how a row is matched to the unit (units.code) once it exists here.
-- Replaced wholesale on each sync. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS student_timetable_units (
  student_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code             VARCHAR(80) NOT NULL,
  base_code        VARCHAR(80) NOT NULL,
  class_group      VARCHAR(50),
  name             VARCHAR(200),
  -- A split unit the student hasn't picked a group for in SMARTTT yet.
  group_required   BOOLEAN NOT NULL DEFAULT FALSE,
  lecturer_names   TEXT[] NOT NULL DEFAULT '{}',
  -- [{dayOfWeek, startTime, endTime, room}], as SMARTTT reports them.
  slots            JSONB NOT NULL DEFAULT '[]',
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_user_id, code)
);
