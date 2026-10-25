# department module

Oversight of one department's teaching: who teaches what, how well attended
it is, whether classes start on time, which students are at risk of missing
exams, and what students said in course evaluations — read-only except for
course provisioning and account deletion (see below).

## Scoping

A department officer sees exactly one department's data, and which one is
never taken from the request. Every handler resolves it from the officer's own
`department_profiles` row by `req.auth.userId`; there is no `departmentId`
parameter anywhere in this module to tamper with.

A unit belongs to the department that owns its curriculum,
`units.department_id` (`db/migrations/033_unit_owning_department.sql`), not to
whoever teaches it. Units, students, sessions, attendance, timekeeping,
eligibility and evaluations are all scoped by it, so a unit taught by a
lecturer borrowed from another department still counts here. A unit gets its
owner from the course offering it was allocated from, or else from its
lecturer's department when it is created; moving a lecturer later does not
move their units.

Staff are the lecturers whose own `lecturer_profiles.department_id` is this
department: they make up `lecturerCount`, and only they can have their
account deleted from here. The lecturer list shows them plus any borrowed
lecturer teaching one of the department's units, marked `isOwnStaff: false`.
Each row's figures cover this department's units only, so the rows add up to
the department's totals; `unitsElsewhere` counts what a lecturer teaches for
other departments, for workload.

The lecturer drill-down refuses unless the lecturer is the department's staff
or teaches one of its units. Anyone else comes back **404, not 403**: telling
an officer "this person exists but is not yours" would let them enumerate
staff across the institution one user id at a time.

Reads are not audited, the same precedent the reporting module's GETs set.

## Figures

`avgAttendanceRate` is the lecturer module's average, re-scoped: each
session's own checked-in ÷ ACTIVE-allocations rate, averaged over the
department's sessions, to one decimal. A department's numbers reconcile with
what each of its lecturers sees on their own dashboard because the SQL shape
is the same one, widened from `lecturer_user_id = $1` to
`unit_id IN (SELECT id FROM units WHERE department_id = $1)`.

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
| `GET` | `/api/v1/departments/me` | Department | The officer's department and its code |
| `GET` | `/api/v1/departments/overview` | Department | Head counts, `avgAttendanceRate`, `sessionsHeld`, `onTimeRate` |
| `GET` | `/api/v1/departments/lecturers` | Department | One row per lecturer: units, students, attendance, `avgLateMinutes`, `onTimeRate` |
| `GET` | `/api/v1/departments/lecturers/:lecturerUserId` | Department (own dept) | That lecturer's units and 20 most recent sessions with timekeeping |
| `GET` | `/api/v1/departments/students` | Department | One row per (student, unit) across the department, with the owning lecturer |
| `GET` | `/api/v1/departments/units` | Department | Units with aggregate attendance rate and lecturer name |
| `GET` | `/api/v1/departments/timekeeping` | Department | `?lecturerUserId=&unitId=&limit=` — session-level punctuality log, newest first |
| `GET` | `/api/v1/departments/courses` | Department | Courses provided to the department, with segments planned/filled |
| `PATCH` | `/api/v1/departments/courses/:offeringId` | Department (own) | Sets how many lecturer-taught sections a course needs |
| `GET` | `/api/v1/departments/lecturer-directory` | Department | `?q=` — lecturers anywhere in the institution, own staff first, for the allocation picker (25 at most) |
| `POST` | `/api/v1/departments/courses/:offeringId/segments` | Department (own) | Allocates a lecturer, own or borrowed, to the next open section — immediate, creates a real `units` row owned by this department |
| `GET` | `/api/v1/departments/eligibility` | Department | `?all=true` — exam eligibility on the department's units (see Exam eligibility) |
| `GET` | `/api/v1/departments/evaluations` | Department | Student course evaluation rounds that have opened |
| `GET` | `/api/v1/departments/evaluations/:id` | Department | One round's results for the department's units (see `quality-assurance/README.md`) |
| `DELETE` | `/api/v1/departments/lecturers/:lecturerUserId` | Department (own staff) | Deletes the lecturer's account (anonymised; see Account deletion) |
| `DELETE` | `/api/v1/departments/students/:studentUserId` | Department (on a dept roster) | Deletes the student's account (anonymised; see Account deletion) |

## Course provisioning (writes)

The only mutations this module has besides account deletion: a department can
allocate lecturers to courses provided to it (`course_offerings`),
and decide how many sections a course needs. See
`db/migrations/023_course_offerings.sql` and
[`docs/expected-schema.md`](../../../docs/expected-schema.md)'s
"course-provisioning write endpoints" section for the full mechanism —
allocating reuses `units.base_code`/`class_group`, so the resulting unit
needs no special handling anywhere else in this codebase. Any active lecturer
may be allocated, including one from another department; the unit is created
with the offering's department as its owner, and the lecturer's own
department is unchanged. Allocating someone who is not an active lecturer is
a 400. An offering outside the caller's department 404s rather than
confirming it exists.

## Exam eligibility

`GET /departments/eligibility` judges every active (student, unit) pair on
the department's units against the institution's attendance policy
(`src/modules/eligibility`): `NOT_ELIGIBLE` below the minimum, `AT_RISK` within
the margin above it, `ELIGIBLE` above that, and `NOT_YET_MEASURED` before the
unit has held a class. Rates are the same held/attended counts the students
list uses, so the two pages agree. Only at-risk and not-eligible rows are
returned, worst first, unless `?all=true`; the summary always counts
everyone.

## Accounts and writes

There is no self-registration for this role: a department officer has no ERP
staff record to verify against. Accounts are invite-only — an administrator
invites them from the admin console (`auth.invitation.ts`), and they sign in
at the unlisted `/oversight` page. `npm run dev:seed-department` still seeds
one for local work.

What a department officer can change: course offerings and their lecturer
segments (`/departments/courses/...`), account deletion (below), and the
department's portable terminals and fingerprint enrolment
(`/departments/terminals`, `/departments/enrolment`, `src/modules/terminal`,
`docs/terminals.md`). They cannot approve units (an administrator does, in the
admin console) or close another lecturer's sessions.

## Account deletion (writes)

An officer may delete the account of a lecturer on their department's staff,
or of a student on a roster of one of its units; anyone else is a 404.
Borrowing a lecturer to teach a unit gives no say over their account. The work is `src/modules/auth/auth.deletion.ts`, shared with
a student's or lecturer's own `DELETE /auth/me`: the account is anonymised,
not removed, so the department's figures still include the classes taught and
attended. Deleted lecturers drop out of the lecturer list and head count.
