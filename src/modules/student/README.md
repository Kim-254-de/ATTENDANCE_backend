# student module

Student accounts and what a signed-in student sees about their own classes.

## Registration and sign-in (in `src/modules/auth`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/auth/student/register` | `{ fullName, email, registrationNumber, password, confirmPassword }` |
| `POST` | `/api/v1/auth/verify-email` | A student is `ACTIVE` here and is linked to every roster already listing their registration number. (Lecturers don't confirm an email: they are active on registration) |
| `POST` | `/api/v1/auth/login` | `identifier` may be a registration number; the token carries `role: STUDENT` |
| `GET` | `/api/v1/auth/me` | Returns `{ role: 'student', registrationNumber, programme, yearOfStudy, ... }` |
| `POST` | `/api/v1/auth/forgot-password`, `/reset-password`, `/change-password` | Same as lecturers |

**The registration gate** (`student.directory.ts`). The registration number
is looked up in **SMARTTT** first when `SMARTTT_BASE_URL` is set
(`GET /api/v1/integrations/attendance/students/`), with the **ERP**
(`erpClient.lookupStudent`, today `mock-erp/`) as the fallback: when SMARTTT
is off, can't be reached, or doesn't list the number. A student SMARTTT
reports as no longer current is refused without asking the ERP.

| Directory says | Result |
|---|---|
| Not found | 403 `STUDENT_RECORD_NOT_FOUND`, nothing created |
| Not a current student (graduated, withdrawn, suspended…) | 403 `STUDENT_RECORD_INACTIVE` |
| Unreachable (SMARTTT down and the ERP doesn't list it, or the ERP down) | 503 `STUDENT_DIRECTORY_UNAVAILABLE`: fails closed |
| Found and current | 201; account `ACTIVE`, the student signs in straight away |

Only the registration number is checked: the name and email typed are not compared with the directory record.

Every attempt is audited (`STUDENT_REGISTRATION_*`, `audit_logs.subject_registration_number`).

## Endpoints

| Method | Path | Role | Returns |
|---|---|---|---|
| `GET` | `/api/v1/students/me/units` | Student | Units they're `ACTIVE` on (`onRoster: true`): code (with group, e.g. `COSC 103 GR A`), lecturer, schedule, `sessionsHeld`, `sessionsAttended`, `attendanceRate`. Then every other unit SMARTTT has them registered for this term (`onRoster: false`, `id: null`), see below |
| `GET` | `/api/v1/students/me/attendance?unitId=&limit=` | Student | `{ summary, records }`: each class session newest first, marked `PRESENT`, `ABSENT`, or `OPEN` (still taking check-ins, not counted yet) |

Check-in itself is `POST /api/v1/attendance/check-in` (attendance module).

## Units from SMARTTT

When `SMARTTT_BASE_URL` is set, `GET /students/me/units` first asks SMARTTT
which classes the student is registered for this term
(`GET /api/v1/integrations/attendance/student-units/?registration_number=`,
`student.service.ts syncMyUnitsFromTimetable`) and stores them in
`student_timetable_units` (migration 015), replacing the previous list.

Each class carries the same section code the lecturer's unit sync uses
(`COSC 103 GR A`, or `COSC 103` when not split), so a class is matched to the
unit here by `units.code`. Classes the student is already `ACTIVE` on are shown
once, with their attendance. The rest are shown with `onRoster: false`: their
lecturer hasn't set the unit up here yet (or hasn't synced since), so there is
nothing to check in to. `groupRequired: true` marks a split unit the student
hasn't picked a group for in SMARTTT, so no group's class list includes them.

This is display only: it never puts a student on a class list. Who can check
in still comes from the roster the lecturer's sync brings from SMARTTT.
Throttled per student (`SMARTTT_SYNC_INTERVAL_SECONDS`) and fails soft: when
SMARTTT is off or down, the student sees what was last synced.

## Tables

`student_profiles` (`db/migrations/012_student_accounts.sql`): one row per
student account, `registration_number` UNIQUE and upper-cased, plus the
programme and year from the directory and which directory verified them.
