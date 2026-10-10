# faculty module

Read-only oversight of every department in one faculty: the department
module one level up, plus one new thing a department officer cannot see —
how its departments compare against each other.

## Scoping

A faculty officer sees exactly one faculty's data, read from their own
`faculty_profiles` row by `req.auth.userId`; there is no `facultyId`
parameter anywhere in this module to tamper with.

Every query starts from
`lecturer_profiles WHERE department_id IN (SELECT id FROM departments WHERE faculty_id = $1)`
— the department module's `department_id = $1` widened by one join. A unit's
department (and so its faculty) is still derived, never stored, for the same
reason `department`'s README gives: `units.lecturer_user_id →
lecturer_profiles.user_id → department_id → faculty_id`.

The two endpoints that name something else — the department drill-down and
the lecturer drill-down — resolve that thing's own faculty first and refuse
unless it equals the caller's. Both come back **404, not 403** for something
outside the caller's faculty, the same enumeration-resistance rule
`department` uses.

Everything is a GET, so nothing is audited.

## Figures

Same rate math and the same "null means nothing measured yet" rule as
`department` throughout — `onTimeRate`/`avgLateMinutes` are null, not zero,
when no session has a schedule to be judged against, and a department or
lecturer with no sessions yet reports null rather than a false zero.

`/faculties/departments` is the one figure a department officer cannot see
on their own: the same six numbers `/departments/overview` reports for one
department, computed per department so they can be read side by side.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/faculties/me` | Faculty | The officer's faculty |
| `GET` | `/api/v1/faculties/overview` | Faculty | Head counts (incl. `departmentCount`), `avgAttendanceRate`, `sessionsHeld`, `onTimeRate` |
| `GET` | `/api/v1/faculties/departments` | Faculty | One row per department — lecturers, students, units, attendance, `onTimeRate` |
| `GET` | `/api/v1/faculties/departments/:departmentId` | Faculty (own) | That department's lecturers and units |
| `GET` | `/api/v1/faculties/lecturers` | Faculty | Every lecturer across every department, with `departmentName` |
| `GET` | `/api/v1/faculties/lecturers/:lecturerUserId` | Faculty (own) | That lecturer's units and 20 most recent sessions with timekeeping |
| `GET` | `/api/v1/faculties/students` | Faculty | One row per (student, unit) across the faculty, with lecturer and department |
| `GET` | `/api/v1/faculties/units` | Faculty | Units with aggregate attendance rate, lecturer and department |
| `GET` | `/api/v1/faculties/timekeeping` | Faculty | `?lecturerUserId=&unitId=&departmentId=&limit=` — session-level punctuality log, newest first |

## Not built

No self-registration, same reason as `department`: there is no ERP record to
verify a faculty officer against, so accounts are provisioned directly. For
local work: `npm run dev:seed-faculty`.

A faculty officer cannot write anything — no reassigning departments, no
editing rosters. Quality assurance is the next milestone.
