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
reach: it's recorded by the university's systems, not something a lecturer
types in or a student self-declares.

**Where the roster comes from:**

- **SMARTTT, when `SMARTTT_BASE_URL` is set.** The students registered for
  the unit in SMARTTT this term (registration number and name) arrive with
  the lecturer's units in one call (see the next section), so the units page
  and the roster page both refresh every unit's roster. Throttled per
  lecturer, so a roster can be up to `SMARTTT_SYNC_INTERVAL_SECONDS` old.
- **Otherwise the ERP** — today `mock-erp/` — via
  `erpClient.listCourseEnrollments` each time the roster is viewed.

Either way `unitRepository.syncRosterAllocations` applies the list:

- Every listed student is upserted `ACTIVE`, `source = 'SMARTTT'` or `'ERP'`.
- A synced row (`'SMARTTT'` or `'ERP'`) no longer on the list is marked
  `DROPPED` — kept, not deleted, so past attendance keeps its context. Only
  one source is the authority for a deployment, so switching from the mock ERP
  to SMARTTT drops the mock students.
- Rows from another source (`'LECTURER'`/`'SELF_ENROLLED'` — legacy data from
  before this sync existed) are left untouched either way.

The sync fails **soft**: if the source can't be reached, the roster just shows
whatever was last synced rather than blocking the view — viewing a roster is
refreshing a display, not granting trust on faith the way unit creation is.

A synced allocation has a registration number but no account until the
student registers. Student registration must call
`linkAllocationsToStudent(userId, registrationNumber)` (exported from
`index.ts`) so those students can check in.

## Units from SMARTTT (the timetable system)

When `SMARTTT_BASE_URL` is set, `GET /api/v1/units` first asks SMARTTT which
units the lecturer is timetabled to teach this term
(`unit.service.ts syncUnitsFromTimetable`, client in
`src/integrations/smarttt/`), and upserts them with SMARTTT's
registered-student count (`units.registered_students`).

| SMARTTT says | What happens here |
|---|---|
| Unit linked to the lecturer's SMARTTT account (staff number) | Created or refreshed `VERIFIED`. A `PENDING_VERIFICATION` unit is upgraded |
| Unit matched only by the lecturer's name (department allocation) | Created `PENDING_VERIFICATION`, admins notified, as for a lecturer-added unit the timetable doesn't assign to them. Never downgrades a verified unit |
| Exactly one weekly slot | Written to `unit_schedule` |
| Several weekly slots | `unit_schedule` left as it is: it holds one slot per unit |
| Unit split into groups taught by different lecturers (COSC 103 GR A, GR B ...) | Each group the lecturer is allocated is its own unit (`code` `COSC 103 GR A`, `base_code`, `class_group`), with its own sessions, QR codes, schedule and roster. Groups never collide between lecturers |
| Students registered for the class | Become its roster: registration number and name, `source = 'SMARTTT'`. For a group, only students who picked that group in SMARTTT |
| Students who haven't picked a group yet | On no group's roster; counted in `studentsWithoutGroup` so the lecturer can tell them to pick one in SMARTTT |
| Code already held by another lecturer | Left alone (roster included), logged. Units have one owner |
| Unit no longer listed | Kept, with its last known count |
| SMARTTT off, asleep, 403, unreadable | Fails soft: the units already on file are returned |

Throttled to one SMARTTT call per lecturer per `SMARTTT_SYNC_INTERVAL_SECONDS`.
`registeredStudents` is SMARTTT's number; `studentCount` is still who can
check in here (the ERP-synced roster).

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/units` | Lecturer | Units they teach, synced from SMARTTT first, with active, pending and registered counts |
| `POST` | `/api/v1/units` | Lecturer | Add a unit `{ code }` — name/schedule come from the ERP |
| `GET` | `/api/v1/units/:unitId/students` | Lecturer (owner) | The roster, synced from SMARTTT (or the ERP when SMARTTT is off) — read-only |
