# management module

University-wide attendance for management, read-only. Gated to the
`MANAGEMENT` role. Faculties play no part (`039_no_faculties.sql`): every
department in the university is visible, each shown with its code.
Administrators invite management with `POST /admin/invitations
{ role: 'management' }`.

## Levels

1. **Departments** — every department, most check-ins first. `checkIns`
   (attendance records in its classes) and `avgAttendanceRate`, the mean
   per-session rate (the ranked bar chart).
2. **A department's years** — Years 1–4, each with its units, students,
   classes held, check-ins and attendance rate (the bar chart).
3. **One year** — that year's units, each with its lecturer and the
   students on its roster, with classes attended / held.

## A unit's year

The first digit of the unit code: `COSC 103` is Year 1, `COSC 410` Year 4.
A code starting 5 or higher is postgraduate and belongs to no year
(counted in `unitsWithoutYear`). Only a code with no digit at all falls
back to the year most of its students are in (`student_profiles.year_of_study`,
from SMARTTT).

## Figures

A session's rate is its check-ins over the unit's ACTIVE allocations, and
a department's or unit's rate the mean of those, so a department reads the
same here as in its own portal. A rate is `null`, not 0, until a class with a roster
has been held.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/management/departments` | Management | `{ totals, departments }` — every department with units, students, classes held, `checkIns`, `avgAttendanceRate` |
| `GET` | `/api/v1/management/departments/:departmentId` | Management | Department header, `years` (1–4) and `unitsWithoutYear`. 404 unknown |
| `GET` | `/api/v1/management/departments/:departmentId/years/:year` | Management | `year` 1–4: `units`, each with `lecturerName`, `staffNumber`, `avgAttendanceRate` and `students` (`sessionsAttended`, `sessionsHeld`, `attendanceRate`) |
