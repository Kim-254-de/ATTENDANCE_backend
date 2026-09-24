# reporting module

Session-by-session attendance history, and a per-session CSV export.

`present`/`total` per session reuse the same checked-in/ACTIVE-allocation
counting `session.service.ts`'s `assertSessionAcceptingScans` path and
`lecturer.service.ts`'s `getOverview` already do — `total` is measured
*now* (ACTIVE allocations on the unit today), not a historical snapshot of
who was enrolled at the time, since no such snapshot is kept anywhere.

`reference` (the `QR-COSC100-0924`-style string) is display-only, derived
from the unit code and session date — nothing is stored under that name.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/reports/sessions` | Lecturer | `?unitId=&limit=` — session history, newest first |
| `GET` | `/api/v1/reports/sessions/:sessionId/export` | Lecturer (owner) | CSV: one row per ACTIVE allocation on the session's unit |

PDF export and student-facing progress views are not implemented.
