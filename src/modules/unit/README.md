# unit module

Units, and which students are on them (allocations).

Until units come from the ERP, **lecturers add their own units**. A unit code
is unique across the institution, so two lecturers cannot both claim `COSC 100`.

## How students get onto a unit

| Route | Who | Result |
|---|---|---|
| Lecturer pastes registration numbers | Lecturer | Each is looked up in the ERP's student records. Found and active → `ACTIVE` at once |
| Student asks to join by unit code | Student | `PENDING` until the lecturer approves |

Allocation is the check that makes a forwarded QR code near-useless: only an
`ACTIVE` student can check in, however current their code. That is why a
student can never make themselves `ACTIVE`, and why a student the lecturer
removed (`DROPPED`) cannot re-request their way back.

The ERP lookup fails **closed**: if the student records system is unreachable,
that number is reported `UNAVAILABLE` and not added. One bad number never fails
the batch — the response reports each number's outcome.

A lecturer-added allocation has a registration number but no account until the
student registers. Student registration must call
`linkAllocationsToStudent(userId, registrationNumber)` (exported from
`index.ts`) so those students can check in.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/units` | Lecturer | Units they teach, with active and pending counts |
| `POST` | `/api/v1/units` | Lecturer | Add a unit `{ code, name }` |
| `GET` | `/api/v1/units/:unitId/students` | Lecturer (owner) | Everyone on the unit, pending first |
| `POST` | `/api/v1/units/:unitId/students` | Lecturer (owner) | `{ registrationNumbers: [...] }` (max 300), per-number results |
| `PATCH` | `/api/v1/units/:unitId/students/:allocationId` | Lecturer (owner) | `{ status: ACTIVE \| DROPPED }` — approve, remove, restore |
| `POST` | `/api/v1/units/enrol` | Student | `{ code }` — ask to join |
