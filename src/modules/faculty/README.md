# faculty module

Oversight of every department in one faculty: the department module one
level up, plus one new thing a department officer cannot see — how its
departments compare against each other. Read-only except for creating
departments, provisioning courses, inviting department officers, placing
lecturers in departments and deleting accounts (see below).

## Scoping

A faculty officer sees exactly one faculty's data, read from their own
`faculty_profiles` row by `req.auth.userId`; there is no `facultyId`
parameter anywhere in this module to tamper with.

The same split `department`'s README describes, widened by one join.
Teaching is scoped by the unit's owning department
(`units.department_id IN (SELECT id FROM departments WHERE faculty_id = $1)`),
so a unit taught by a lecturer from another faculty counts here and not
there. Staff are lecturers whose own department is in the faculty. The
lecturer list shows them plus anyone teaching one of the faculty's units
(`isOwnStaff: false`), with figures over the faculty's units only.

The department and lecturer drill-downs refuse anything outside the caller's
faculty. A lecturer counts as inside if they are the faculty's staff or teach
one of its units. Both come back **404, not 403**, the same
enumeration-resistance rule `department` uses.

Reads are not audited; placing a lecturer is.

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
| `GET` | `/api/v1/faculties/lecturers` | Faculty | Every lecturer across every department plus borrowed ones, with home `departmentName` and `isOwnStaff` |
| `GET` | `/api/v1/faculties/lecturers/:lecturerUserId` | Faculty (own) | That lecturer's units and 20 most recent sessions with timekeeping |
| `GET` | `/api/v1/faculties/students` | Faculty | One row per (student, unit) across the faculty, with lecturer and department |
| `GET` | `/api/v1/faculties/units` | Faculty | Units with aggregate attendance rate, lecturer and department |
| `GET` | `/api/v1/faculties/timekeeping` | Faculty | `?lecturerUserId=&unitId=&departmentId=&limit=` — session-level punctuality log, newest first |
| `POST` | `/api/v1/faculties/departments` | Faculty | Creates a department in the caller's own faculty |
| `POST` | `/api/v1/faculties/departments/:departmentId/courses` | Faculty (own) | Provides a course to one of the caller's own departments — manually entered, no ERP check, no lecturer yet |
| `GET` | `/api/v1/faculties/courses` | Faculty | Every course offering across every department, with `departmentName` and segments planned/filled |
| `DELETE` | `/api/v1/faculties/lecturers/:lecturerUserId` | Faculty (own) | Deletes the account of a lecturer in one of the faculty's departments (anonymised) |
| `DELETE` | `/api/v1/faculties/students/:studentUserId` | Faculty (on a faculty roster) | Deletes the account of a student on a roster of one of the faculty's units (anonymised) |
| `GET` | `/api/v1/faculties/lecturer-placement` | Faculty | `?q=&unassigned=true` — every unassigned lecturer in the institution, then the faculty's own staff |
| `PATCH` | `/api/v1/faculties/lecturers/:lecturerUserId/department` | Faculty (own or unassigned) | Places a lecturer in one of the faculty's departments, or moves them between its departments |
| `GET` | `/api/v1/faculties/eligibility` | Faculty | `?departmentId=&all=true` — exam eligibility across the faculty's units |
| `GET` | `/api/v1/faculties/evaluations` | Faculty | Student course evaluation rounds that have opened |
| `GET` | `/api/v1/faculties/evaluations/:id` | Faculty | `?departmentId=` — one round's results across the faculty's units |
| `GET` | `/api/v1/faculties/officers` | Faculty | The department officers of the faculty's departments, with invitation status |
| `POST` | `/api/v1/faculties/departments/:departmentId/officers` | Faculty (own) | Invites the officer for one of the faculty's departments |
| `POST` | `/api/v1/faculties/officers/:userId/resend` | Faculty (own) | Re-sends a pending invitation with a new link |
| `POST` | `/api/v1/faculties/officers/:userId/deactivate` | Faculty (own) | Removes a department officer's access |

## Course provisioning (writes)

The two writes above are how this university actually fills a class: faculty
decides which courses a department offers; the department
(`src/modules/department/README.md`) decides how many lecturer-taught
sections each needs and allocates lecturers to them, its own or borrowed — the moment
that happens the lecturer can activate classes for it, no confirmation step.
See `db/migrations/023_course_offerings.sql` and
[`docs/expected-schema.md`](../../../docs/expected-schema.md) for the full
mechanism. A department outside the caller's faculty 404s rather than
confirming it exists, and a duplicate department name or course code is a 409.

Creating a department also places any unassigned lecturer whose SMARTTT
department name matches it: they signed in before the department existed.
A name that is only another spelling of an existing department ("Department
of Mathematics" next to "Mathematics") is refused with a 409 naming the
existing one.

## Placing lecturers (writes)

Sign-in places a lecturer in the department SMARTTT's name refers to, and only
when they have none yet. Matching goes through `department_for_name`
(`db/migrations/036_department_spelling.sql`). It compares a canonical form of
both names, so "Dept. of Comp. Sci" and "Computer Science" match, then falls
back to spellings learned earlier. When nothing matches, the lecturer is left **unassigned** instead of a
department being invented from SMARTTT's spelling. An unassigned lecturer
counts toward no department or faculty, so `GET /faculties/lecturer-placement`
lists every one of them first, with the department and faculty names SMARTTT
reported, for any faculty officer to claim.

`PATCH /faculties/lecturers/:id/department` places an unassigned lecturer in
one of the faculty's departments, or moves one of its own staff between its
departments. A lecturer in another faculty is a 404, and a department outside
the faculty is a 400. Moving across faculties is left to an administrator
(`PATCH /admin/lecturers/:id/department`), since neither faculty officer sees
both sides. Each move is audited as `LECTURER_DEPARTMENT_CHANGED` with the
before and after departments.

Placing an **unassigned** lecturer also teaches the system their spelling.
SMARTTT's name for their department is saved in `department_aliases` as
another name for the chosen department, and every other unassigned lecturer
with that spelling is placed at the same time. The response carries
`learnedSpelling` and `alsoPlaced`. An administrator can remove a wrongly
learned spelling (`src/modules/admin/README.md`). Sign-in never undoes it. Units stay with the
department that owns them; only units with no owner follow the lecturer.
Shared code: `src/modules/lecturer/lecturer.placement.ts`.

## Accounts

No self-registration, same reason as `department`. Faculty officers are
invited by an administrator (admin console), and in turn invite their
departments' officers (`/faculties/departments/:departmentId/officers`). They
sign in at `/oversight`. `npm run dev:seed-faculty` still seeds one for local work.

## Account deletion (writes)

The department module's account deletion, one level up: lecturers whose own
department is in the faculty, students on a roster of any of its units. See
`src/modules/department/README.md` and `src/modules/auth/auth.deletion.ts`.

## Department officers (writes)

A faculty officer invites the officer for each of its own departments and
removes their access when they leave the post. The invitee gets an email to
choose their own password (`src/modules/auth/auth.invitation.ts`); nobody else
ever sets it. A department outside the caller's faculty is a 404.
