# session module

Attendance sessions and **rotating QR codes**.

## The problem this solves

A student photographs the QR projected in the lecture hall and sends it to an
absent friend, who scans it and is marked present.

## How rotation works

The code is not a stored value. It is derived from the session's secret and the
current time window:

```text
payload   = v1.<sessionId>.<counter>.<signature>
counter   = floor(unixSeconds / rotationSeconds)          ← changes every 60s
signature = HMAC-SHA256(sessionSecret, "v1.<sessionId>.<counter>")
```

The server recomputes the signature when a scan arrives. **Nothing is written
per rotation** — a two-hour COSC 100 class produces one `attendance_sessions`
row, not 120 QR rows. The stable identifier for the class meeting is that row;
the unit itself (`COSC 100`) is a single row in `units`.

The signature covers the counter, so a photographed code cannot be edited to
look current — changing the counter invalidates the signature.

## What rotation does *not* solve

Rotation shrinks the sharing window; it does not close it. A student can still
send a screenshot within the current minute. Three checks do the real work:

1. **Allocation** — the scanner must be registered on the unit, so a forwarded
   code gets an unrelated student nowhere.
2. **One record per student per session** — enforced by
   `UNIQUE (session_id, student_user_id)` on `attendance_records`.
3. **Session window** — a session that has closed, or drifted past `closes_at`,
   accepts nothing regardless of status.

If you want the window closed further, geofencing or classroom-network checks
(root README §13) are the next layer. Shortening `QR_ROTATION_SECONDS` helps
too, at the cost of more failed scans.

## The grace window

`QR_ACCEPT_PREVIOUS_WINDOWS` (default `1`) accepts the previous counter as well
as the current one, so a code is usable for 60–120 seconds.

This exists because scanning is not instant — a student who opens the camera at
second 59 submits at second 61, and rejecting them would be wrong. It is a
genuine trade-off: every extra window is another minute in which a shared
screenshot still works. Set it to `0` for the strictest behaviour and expect
some legitimate scans to fail.

Codes from the **future** are never accepted, at any setting.

## Why the secret is per-session, not per-unit

Both resist replay, since the counter is signed. But a per-unit secret, once
leaked, mints valid codes for COSC 100 forever. A per-session secret dies with
the class meeting.

## Files

| File | Responsibility |
|---|---|
| `session.token.ts` | Token generation, signing, rotation maths. Pure — no DB, no HTTP |
| `qr.render.ts` | PNG / SVG / data-URL rendering |
| `session.schema.ts` | Zod request contracts |
| `session.repository.ts` | All SQL; parameterised only |
| `session.service.ts` | When a code may be issued or accepted |
| `session.controller.ts` | HTTP in, HTTP out |
| `session.routes.ts` | Router, auth guards, validation |

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/sessions` | Lecturer | Open a session for a unit they teach |
| `GET` | `/api/v1/sessions/:id/qr` | Lecturer | Current code + countdown, plus `checkedIn` / `enrolled` counts, as JSON |
| `GET` | `/api/v1/sessions/:id/qr.image?format=png\|svg` | Lecturer | Rendered image; `X-QR-Expires-In` header carries the countdown |
| `POST` | `/api/v1/sessions/scan` | Student | Verify a scanned code without recording it (dry run — use `/attendance/check-in`) |
| `PATCH` | `/api/v1/sessions/:id/status` | Lecturer | Pause, resume or close |

Lecturers cannot scan and students cannot mint — a lecturer who could do both
could mark a hall present from their desk.

The client should re-request the code every `expiresInSeconds`; polling costs
nothing, since no row is written.

## Scope

This module verifies a scan and returns a verdict. It does **not** write the
attendance record — that belongs to the attendance module, which calls
`sessionService.verifyScan()` and persists the result.

## Tables

Created by `db/migrations/005_*` and `006_*`. `docs/expected-schema.md` documents the exact
columns these queries depend on: `units`, `attendance_sessions`,
`unit_allocations`, `attendance_records`.
