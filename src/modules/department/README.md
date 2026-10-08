# department module

Read-only oversight of one department's teaching: who teaches what, how well
attended it is, and whether classes start on time.

## Scoping

A department officer sees exactly one department's data, and which one is
never taken from the request. Every handler resolves it from the officer's own
`department_profiles` row by `req.auth.userId`; there is no `departmentId`
parameter anywhere in this module to tamper with.

A unit's department is derived, not stored —
`units.lecturer_user_id → lecturer_profiles.user_id → department_id`
(`db/migrations/020_departments.sql`). `units` deliberately has no
`department_id` column: a second copy could disagree with the first the moment
a unit changes hands. Every query here therefore starts from
`lecturer_profiles WHERE department_id = $1`.

The one endpoint that names another user — the lecturer drill-down — reads
that lecturer's own `department_id` and refuses unless it equals the caller's.
A lecturer in another department comes back **404, not 403**: telling an
officer "this person exists but is not yours" would let them enumerate staff
across the institution one user id at a time.

Everything is a GET, so nothing is audited — the same precedent the reporting
module's GETs set. There is no mutation to reconstruct later.

## Figures

`avgAttendanceRate` is the lecturer module's average, re-scoped: each
session's own checked-in ÷ ACTIVE-allocations rate, averaged over the
department's sessions, to one decimal. A department's numbers reconcile with
what each of its lecturers sees on their own dashboard because the SQL shape
is the same one, widened from `lecturer_user_id = $1` to
`lecturer_user_id IN (SELECT user_id FROM lecturer_profiles WHERE department_id = $1)`.

Timekeeping compares `attendance_sessions.opens_at` with
`scheduled_start_at` — the start of the timetabled meeting the class was
activated inside, captured at activation by `session.service.ts`'s
`resolveWindow`. `lateMinutes` is `opens_at - scheduled_start_at` in minutes,
rounded, and negative when the class was activated early.

Sessions with a null `scheduled_start_at` are **excluded** from every
timekeeping figure, not counted as on time: they were opened against a unit
with no issued schedule, so there is nothing to be late against.

`onTimeRate` allows a **5-minute grace period**
(`ON_TIME_GRACE_MINUTES`) — rooms do not unlock on the second — and is `null`,
not `0`, when no session is measurable, so "nothing measured" cannot read as
"nobody on time".

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/departments/me` | Department | The officer's department and its faculty |
| `GET` | `/api/v1/departments/overview` | Department | Head counts, `avgAttendanceRate`, `sessionsHeld`, `onTimeRate` |
| `GET` | `/api/v1/departments/lecturers` | Department | One row per lecturer: units, students, attendance, `avgLateMinutes`, `onTimeRate` |
| `GET` | `/api/v1/departments/lecturers/:lecturerUserId` | Department (own dept) | That lecturer's units and 20 most recent sessions with timekeeping |
| `GET` | `/api/v1/departments/students` | Department | One row per (student, unit) across the department, with the owning lecturer |
| `GET` | `/api/v1/departments/units` | Department | Units with aggregate attendance rate and lecturer name |
| `GET` | `/api/v1/departments/timekeeping` | Department | `?lecturerUserId=&unitId=&limit=` — session-level punctuality log, newest first |

## Not built

There is no self-registration for this role. A department officer has no ERP
staff record to verify against, so there is nothing an open sign-up form could
check — only sign-in is wired up (`auth.session.repository.ts`'s `DEPARTMENT`
branch), and accounts are provisioned directly. For local work:
`npm run dev:seed-department`.

A department officer cannot write anything: no approving units, no editing
rosters, no closing sessions. A faculty-level role is the next milestone and is
why `faculties` exists as a table already.
