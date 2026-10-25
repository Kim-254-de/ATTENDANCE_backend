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

Any department officer can edit, publish and reopen. Scope comes from the
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
| `GET` | `/export/:format` | The allocation form as `pdf`, `docx` or `xlsx` (phone numbers, and times once published) |

For the Generator: `GET /api/v1/integrations/generator/terms/:termId/submissions`
(`X-API-Key` = `GENERATOR_API_KEY`), in the snake_case shape the Allocator
served, which the Generator's import reads unchanged.

## Data and settings

Tables `teaching_lecturers`, `teaching_courses`, `teaching_units`,
`teaching_unit_courses`, `teaching_groups`, `teaching_group_members`,
`teaching_publications` (`db/migrations/040_department_teaching.sql`).
Writes take an advisory lock per term and department, so two officers never
interleave and a publish never races an edit. Every change is audited
(`TEACHING_CHANGED`, `TEACHING_PUBLISHED`, `TEACHING_REOPENED`).

`GENERATOR_BASE_URL` (the Generator), `GENERATOR_API_KEY` (one key both ways,
= `ATTENDANCE_API_KEY` in the Generator), `GENERATOR_TERMS_PATH`,
`GENERATOR_TIMEOUT_MS`.
