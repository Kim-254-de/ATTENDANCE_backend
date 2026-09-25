# unit module

Units, and which students are on them (allocations).

A lecturer adds a unit by **code only** — the name and schedule are never
typed in. `unit.service.ts createUnit` looks the code up against the ERP's
issued timetable (`erpClient.lookupCourse`, mock-erp's `erp_courses` table)
and takes the name/day/start/end straight from that record, the same way an
added student's name comes from the ERP rather than a text field.

## Verification: existence is automatic, lecturer assignment is not

| ERP result | What happens |
|---|---|
| Code not on the timetable | 404 — creation refused. No admin involved. |
| ERP unreachable | 503 `ERP_UNAVAILABLE` — fails closed, same as student lookups. |
| Timetable lists *this* lecturer's staff number for the course | Unit is `VERIFIED` immediately. No admin involved. |
| Timetable lists someone else (or nobody) | Unit is created `PENDING_VERIFICATION`; every `ADMIN` user is emailed to confirm the lecturer-unit assignment (`notificationService.sendUnitVerificationRequest`, logged rather than sent — see `notification` module). |

`session.service.ts` refuses to activate a class for a unit that is not
`VERIFIED`. There is no admin UI yet for confirming an assignment by hand;
do it locally with `npm run dev:verify-unit -- "COSC 100"` (mirrors
`dev:approve` for lecturer accounts).

## How students get onto a unit

A unit's roster is **read-only** for the lecturer — the same reasoning as a
unit's name and schedule. Deciding who's enrolled is above a lecturer's
reach: it's the registrar's call, recorded in the ERP, not something a
lecturer types in or a student self-declares.

`unit.service.ts listStudents` syncs from `erpClient.listCourseEnrollments`
(mock-erp's `erp_enrollments` table, joined with `erp_students`) every time
the roster is viewed:

- Every student the ERP currently enrols in the course is upserted `ACTIVE`,
  `source = 'ERP'`.
- An `'ERP'`-sourced row that has dropped off the ERP's list is marked
  `DROPPED` — kept, not deleted, so past attendance keeps its context.
- Rows from another source (`'LECTURER'`/`'SELF_ENROLLED'` — legacy data from
  before this sync existed) are left untouched either way.

The sync fails **soft**: if the ERP can't be reached, the roster just shows
whatever was last synced rather than blocking the view — viewing a roster is
refreshing a display, not granting trust on faith the way unit creation is.

A synced allocation has a registration number but no account until the
student registers. Student registration must call
`linkAllocationsToStudent(userId, registrationNumber)` (exported from
`index.ts`) so those students can check in.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/units` | Lecturer | Units they teach, with active and pending counts |
| `POST` | `/api/v1/units` | Lecturer | Add a unit `{ code }` — name/schedule come from the ERP |
| `GET` | `/api/v1/units/:unitId/students` | Lecturer (owner) | The roster, synced from the ERP's enrollment records — read-only |
