# faculty module

Oversight of every department in one faculty: the department module one
level up, plus one new thing a department officer cannot see — how its
departments compare against each other. Read-only except for creating
departments, provisioning courses, inviting department officers and deleting
accounts (see below).

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
| `POST` | `/api/v1/faculties/departments` | Faculty | Creates a department in the caller's own faculty |
| `POST` | `/api/v1/faculties/departments/:departmentId/courses` | Faculty (own) | Provides a course to one of the caller's own departments — manually entered, no ERP check, no lecturer yet |
| `GET` | `/api/v1/faculties/courses` | Faculty | Every course offering across every department, with `departmentName` and segments planned/filled |
| `DELETE` | `/api/v1/faculties/lecturers/:lecturerUserId` | Faculty (own) | Deletes the account of a lecturer in one of the faculty's departments (anonymised) |
| `DELETE` | `/api/v1/faculties/students/:studentUserId` | Faculty (on a faculty roster) | Deletes the account of a student on a roster of one of the faculty's units (anonymised) |
| `GET` | `/api/v1/faculties/officers` | Faculty | The department officers of the faculty's departments, with invitation status |
| `POST` | `/api/v1/faculties/departments/:departmentId/officers` | Faculty (own) | Invites the officer for one of the faculty's departments |
| `POST` | `/api/v1/faculties/officers/:userId/resend` | Faculty (own) | Re-sends a pending invitation with a new link |
| `POST` | `/api/v1/faculties/officers/:userId/deactivate` | Faculty (own) | Removes a department officer's access |

## Course provisioning (writes)

The two writes above are how this university actually fills a class: faculty
decides which courses a department offers; the department
(`src/modules/department/README.md`) decides how many lecturer-taught
sections each needs and allocates its own lecturers to them — the moment
that happens the lecturer can activate classes for it, no confirmation step.
See `db/migrations/023_course_offerings.sql` and
[`docs/expected-schema.md`](../../../docs/expected-schema.md) for the full
mechanism. A department outside the caller's faculty 404s rather than
confirming it exists, and a duplicate department name or course code is a 409.

## Not built

No self-registration, same reason as `department`: there is no ERP record to
verify a faculty officer against, so accounts are provisioned directly. For
local work: `npm run dev:seed-faculty`.

Quality assurance is the next milestone.

## Account deletion (writes)

The department module's account deletion, one level up: lecturers in any of
the faculty's departments, students on a roster of any of its units. See
`src/modules/department/README.md` and `src/modules/auth/auth.deletion.ts`.

## Department officers (writes)

A faculty officer invites the officer for each of its own departments and
removes their access when they leave the post. The invitee gets an email to
choose their own password (`src/modules/auth/auth.invitation.ts`); nobody else
ever sets it. A department outside the caller's faculty is a 404.
