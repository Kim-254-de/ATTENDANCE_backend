# attendance module

Check-in: turns a verified QR scan into an `attendance_records` row.

Every rule about whether a scan counts — signature, rotation window, session
state, allocation, one check-in per session — lives in
`sessionService.verifyScan`. This module only persists the verdict. The
`UNIQUE (session_id, student_user_id)` constraint is what stops two
simultaneous scans both being recorded; the loser gets a 409.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/attendance/check-in` | Student | `{ payload }` from the scanned code. 201 with the record |
| `GET` | `/api/v1/attendance/sessions/:sessionId` | Lecturer (owner) | Who has checked in, newest first |

`POST /api/v1/sessions/scan` still exists as a dry run: it verifies without
recording. Clients should use `check-in`.
