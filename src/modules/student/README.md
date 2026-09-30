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
is looked up in the student directory: **SMARTTT** when `SMARTTT_BASE_URL` is
set (`GET /api/v1/integrations/attendance/students/`), otherwise the **ERP**
(`erpClient.lookupStudent`, today `mock-erp/`) — the same authority the unit
rosters come from.

| Directory says | Result |
|---|---|
| Not found | 403 `STUDENT_RECORD_NOT_FOUND`, nothing created |
| Not a current student (graduated, withdrawn, suspended…) | 403 `STUDENT_RECORD_INACTIVE` |
| Unreachable | 503 `STUDENT_DIRECTORY_UNAVAILABLE`: fails closed |
| Found and current | 201; account `ACTIVE`, the student signs in straight away |

Only the registration number is checked: the name and email typed are not compared with the directory record.

Every attempt is audited (`STUDENT_REGISTRATION_*`, `audit_logs.subject_registration_number`).

## Endpoints

| Method | Path | Role | Returns |
|---|---|---|---|
| `GET` | `/api/v1/students/me/units` | Student | Units they're `ACTIVE` on: code (with group, e.g. `COSC 103 GR A`), lecturer, schedule, `sessionsHeld`, `sessionsAttended`, `attendanceRate` |
| `GET` | `/api/v1/students/me/attendance?unitId=&limit=` | Student | `{ summary, records }`: each class session newest first, marked `PRESENT`, `ABSENT`, or `OPEN` (still taking check-ins, not counted yet) |

Check-in itself is `POST /api/v1/attendance/check-in` (attendance module).

## Tables

`student_profiles` (`db/migrations/012_student_accounts.sql`): one row per
student account, `registration_number` UNIQUE and upper-cased, plus the
programme and year from the directory and which directory verified them.
