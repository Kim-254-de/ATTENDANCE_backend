# teaching module

What each department teaches in a term of the Timetable Generator, entered on
the department portal's **Teaching** page and published to the Director. It
used to be a separate app, the Timetable Allocator; the rules are the same.

## The flow

1. The Director opens a term in the Generator. Departments enter their
   teaching against it: terms are read from the Generator
   (`src/integrations/generator`), newest first, cached for 30 seconds.
2. An officer enters the department's **courses** (cohorts: programme, year,
   study semester, sub-class, students; each becomes a class row), its
   **units** (code, title, hours per week, class length, room type, the
   courses taking it) and each unit's **groups** (the whole class, or groups
   A, B, C… with each course's share of students, a lecturer and the
   allocation form's L/P/CF hours). A unit taught to another department's
   students is entered by the department that owns it, choosing their course.
3. **Lecturers** are the department's own list (title, name, staff number,
   FT/PT, phone, email, weekly hour limit), not attendance accounts, so a
   part-timer without an account can teach. The staff number is how the same
   person is known on another department's list, by the Generator's solver
   and by SMARTTT.
4. **Publish** is refused until nothing is missing (`problems`: every unit has
   courses and groups, every group a lecturer with a staff number, a split
   course's shares add up, no lecturer is over their weekly limit counted
   across all departments). Publishing locks courses, units and groups until
   an officer **reopens**; the lecturer list stays editable. A unit changed
   after publishing is marked "changed since published".
5. The Generator imports what is published
   (`GET /integrations/generator/terms/:termId/submissions`), solves, and the
   Director publishes. Each class's day, time and room then shows on the page
   and on the downloads (read from the Generator's `/terms/:id/times`).

## Exams

Also the department's, and also from the Allocator (`exams.service.ts`,
`invigilation.service.ts`, `moderation-letter.ts`):

- **Exam papers**: built from the department's units. All groups of a unit
  sit one paper; one paper can carry several units' codes, another
  department's too ("BITE 131/COSC 130"); a unit is on one paper at most.
  Each has an examiner (default: the unit's lecturer). A unit can be marked
  "no written exam". "A paper for each unit" starts the list.
- **Uploaded exam list** (`exam-list.read.ts`, `exam-list.service.ts`): instead of
  building papers from units, the department uploads the Word letter it sends
  for moderation. Each table row with a unit code is a paper (title from the
  next cell; "COSC 0172/0170" is two codes; rows under an ODEL/part-time
  heading, or "Math 241 odel", are ODEL papers). A review flags duplicates,
  codes SMARTTT doesn't know, codes another department listed and papers
  nobody synced, before anything is saved. A listed paper's class rows and
  numbers are the students who synced its units in SMARTTT
  (`unit-enrolment/` there); the department corrects any number, and a
  corrected row keeps it. SMARTTT is read again when the Generator imports
  the papers. A listed paper's examiner is optional (SMARTTT's lecturer when
  on the list). Its class rows reach the Generator with ids like
  `listed:BSCCS|1|1|`, so a class sitting several papers is one class row.
- **Practicals**, on weekdays the department sets; the Generator only shows them.
- **Moderation letter** (Word or PDF) to the external moderator, from the papers.
- Publishing the papers needs every unit on a paper or marked, and every
  paper an examiner; it locks only the paper list.
- **Invigilators**: once the Director shares an exam draft (read from the
  Generator's `/terms/:id/exam-draft`), each paper gets one, from any
  department's list. One person (staff number) is never in two rooms in one
  session, nor over their `maxExamDuties` (the smallest set on any of their
  lists). Published on their own; the Director can publish the exam
  timetable only when every paper has one.

Courses also carry a study `mode` (ODEL students sit exams in a room of
their own), and lecturers `maxExamDuties`.

Teaching, exam papers and invigilators each publish and reopen on their own
(`teaching_publications.kind`). Any department officer can edit, publish and reopen. Scope comes from the
officer's own `department_profiles` row, never from the request.

## Endpoints

All under `/api/v1/departments/teaching`, DEPARTMENT role; `?term=` picks the
Generator's term (default: the newest).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | The whole page: courses, other departments' courses, units with groups and times, lecturers with their hours, problems, publication |
| `GET` | `/terms` | The Generator's terms |
| `POST` / `PATCH` / `DELETE` | `/courses`, `/courses/:id` | A course |
| `POST` / `PATCH` / `DELETE` | `/units`, `/units/:id` | A unit; a new one is one whole class |
| `PUT` | `/units/:id/groups` | The unit's groups, all at once (kept by label: lecturer and hours stay) |
| `PATCH` | `/groups/:id` | A group's lecturer and L/P/CF hours |
| `GET` / `POST` / `PATCH` / `DELETE` | `/lecturers`, `/lecturers/:id` | The department's lecturer list |
| `POST` | `/courses/bulk`, `/units/bulk`, `/groups/bulk`, `/lecturers/bulk` | Paste from Excel: rows keyed by column heading; good rows kept, bad ones reported by line |
| `POST` | `/spreadsheet` | A .xlsx (base64) read back as cells for the paste dialog; nothing stored |
| `POST` | `/publish`, `/reopen` | Lock and send to the Director; unlock |
| `POST` | `/exam-list/read` | The uploaded .docx exam list read and checked against SMARTTT; nothing stored |
| `POST` | `/exam-list` | The reviewed papers saved, sized from SMARTTT |
| `PUT` | `/exam-papers/:id/rows` | A listed paper's class rows and numbers, as the department corrects them |
| `POST` | `/exam-papers/recount` | Listed papers' numbers read from SMARTTT again |
| `GET` | `/export/:format` | The allocation form as `pdf`, `docx` or `xlsx` (phone numbers, and times once published) |
| `GET` | `/exams` | Exam papers, units (on a paper or not), other departments' units, practicals, problems |
| `POST` / `PATCH` / `DELETE` | `/exam-papers`, `/exam-papers/:id` | A paper |
| `POST` | `/exam-papers/from-units`, `/exam-papers/bulk` | A paper per unit; paste from Excel |
| `PUT` | `/units/:id/no-written-exam` | `{ noWrittenExam }` |
| `POST` / `PUT` / `DELETE` | `/practicals`, `/practicals/:id`; `POST /practicals/bulk` | Practicals |
| `POST` | `/exams/publish`, `/exams/reopen` | The paper list |
| `GET` | `/moderation-letter/:format` | `pdf` or `docx`; `?moderator=` (lines) `&date=` |
| `GET` | `/invigilators` | The department's papers on the shared draft, with who invigilates; every list's lecturers with their duties |
| `PUT` | `/invigilators/:paperId` | `{ lecturerId }` (null clears) |
| `POST` | `/invigilators/publish`, `/invigilators/reopen` | The invigilators |

For the Generator (`X-API-Key` = `GENERATOR_API_KEY`), in the snake_case
shapes the Allocator served, which its imports read unchanged:
`GET /api/v1/integrations/generator/terms/:termId/submissions` (teaching),
`.../exams` (papers with the class rows sitting them, and practicals) and
`.../invigilators` (`{ paperId: { room: { staff_number, name } } }`, published only).

## Data and settings

Tables `teaching_lecturers`, `teaching_courses`, `teaching_units`,
`teaching_unit_courses`, `teaching_groups`, `teaching_group_members`,
`teaching_publications` (`db/migrations/040_department_teaching.sql`);
`teaching_exam_papers`, `teaching_exam_paper_units`, `teaching_no_written_exams`,
`teaching_practicals`, `teaching_invigilations` (`041_department_exams.sql`).
Writes take an advisory lock per term and department, so two officers never
interleave and a publish never races an edit. Every change is audited
(`TEACHING_CHANGED`, `TEACHING_PUBLISHED`, `TEACHING_REOPENED`).

`GENERATOR_BASE_URL` (the Generator), `GENERATOR_API_KEY` (one key both ways,
= `ATTENDANCE_API_KEY` in the Generator), `GENERATOR_TERMS_PATH`,
`GENERATOR_TIMEOUT_MS`.
