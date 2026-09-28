# QR code geofencing: phases and hand-over

Status as of **28 September 2026**. Backend: `ATTENDANCE_backend`. Lecturer
portal: `ATTENDANCE_fronted`.

| Phase | Area | Status |
|---|---|---|
| 1. Foundations | Backend | ✅ Done |
| 2. Rooms | Backend | ✅ Done |
| 3. Starting a session | Backend | ✅ Done |
| 4. Check-in | Backend | ✅ Done |
| 5. Student-app specification | Docs | ✅ Done ([`student-app-checkin.md`](student-app-checkin.md)) |
| Extra: check-in rate limiting | Backend | ✅ Done |
| 6.0 Backend additions for the portal (B1-B3) | Backend | ✅ Done |
| **6. Lecturer portal** | **Frontend** | ⏳ **To do** (section 6 below) |
| 7. Tests | Backend | ✅ Done (written with each phase) · frontend tests are part of phase 6 |

---

## How it works

- At **Activate Class**, the server picks the fence's centre point:
  1. the room has surveyed coordinates → use them;
  2. otherwise → the lecturer's device location, if accurate to 30 m or better;
  3. otherwise → activation is refused with a clear message: activate from a
     phone, or turn the geofence off for this session.
- At **check-in**, the student app sends its GPS reading with the scanned code.
  The server accepts it when `distance − accuracy ≤ 20 m`, after refusing
  readings that are missing, faked, older than 60 s, or vaguer than 50 m.
- The lecturer can turn the geofence **off** when activating or partway through
  the session. Every change is audited.
- A check-in **outside the fence is rejected**, not flagged. This is the
  stricter option. A room with bad GPS still has a way out: the lecturer
  can switch the fence off.
- Students' coordinates are **never stored**, only their distance from the
  centre and the reading's accuracy.

---

## Phase 1: Foundations (backend) ✅

- `db/migrations/012_geofence.sql`:
  - new `rooms` table (code, name, latitude, longitude, surveyed accuracy/date/by)
  - `unit_schedule.room_code`
  - `attendance_sessions.geofence_mode` (`ROOM` / `LECTURER_DEVICE` / `OFF`), `geofence_lat`, `geofence_lng`, `geofence_radius_m`, `geofence_anchor_accuracy_m`
  - `attendance_records.distance_m`, `location_accuracy_m`, `geofence_result` (`INSIDE` / `NOT_CHECKED`)
  - existing sessions and records default to `OFF` / `NOT_CHECKED`
- Settings in `src/config/env.ts`: `GEOFENCE_RADIUS_METRES=20`,
  `GEOFENCE_MAX_STUDENT_ACCURACY_METRES=50`, `GEOFENCE_MAX_ANCHOR_ACCURACY_METRES=30`,
  `GEOFENCE_MAX_FIX_AGE_SECONDS=60`.
- `src/modules/session/session.geofence.ts`: distance maths, the accept/reject
  rule and the centre-point choice. No database or HTTP code, with its own tests.
- Error codes: `LOCATION_REQUIRED`, `LOCATION_TOO_IMPRECISE`, `LOCATION_STALE`,
  `LOCATION_MOCKED`, `OUTSIDE_GEOFENCE`, `GEOFENCE_ANCHOR_UNAVAILABLE`.
- Audit action: `ATTENDANCE_SESSION_GEOFENCE_CHANGED`.

## Phase 2: Rooms (backend) ✅

- The SMARTTT sync saves each class's room to `unit_schedule.room_code`,
  normalised like unit codes (`" lh  1 "` → `LH 1`). A room SMARTTT stops naming
  is cleared. A slot SMARTTT lists in two different rooms gets none.
- `npm run dev:set-room -- <CODE> <LAT> <LNG> <ACCURACY_M> [--name ...] [--by STF/...]`
  records a room's centre point, and `npm run dev:set-room -- --list` shows each
  room's survey status. Readings vaguer than 30 m are refused. Every survey is
  audited as `ROOM_SURVEYED`.
- Lecturers cannot set room coordinates. A lecturer who could place "the
  room" anywhere could place it where their absent students are.
- Survey procedure and a fill-in sheet: [`room-survey-sheet.md`](room-survey-sheet.md).

## Phase 3: Starting a session (backend) ✅

- `POST /sessions` accepts `location?: { latitude, longitude, accuracy }` and
  `geofence?: 'ON' | 'OFF'` (default `ON`).
- No usable centre point → `422 GEOFENCE_ANCHOR_UNAVAILABLE` and no session is created.
- `PATCH /sessions/:id/geofence` with `{ mode: 'OFF' }` or `{ mode: 'ON', location? }`.
  A surveyed room always wins, so a lecturer cannot move the fence off it.
  Audited with the lecturer's ID.
- Every session response includes `geofence` (the mode, radius, room, centre
  accuracy and whether a centre point is set; never the coordinates).

## Phase 4: Check-in (backend) ✅

- `POST /attendance/check-in` and `POST /sessions/scan` accept
  `location?: { latitude, longitude, accuracy, capturedAt, isMocked? }`.
- The location check runs after the code and session-time checks and before
  the class-list check:
  `LOCATION_REQUIRED` 422 · `LOCATION_MOCKED` 403 · `LOCATION_STALE` 422 ·
  `LOCATION_TOO_IMPRECISE` 422 · `OUTSIDE_GEOFENCE` 403 ("about 140 m from LH1").
- Every rejection is audited with the distance and accuracy. `GET /sessions/:id/qr`
  returns `refusedOutsideFence`: students refused for being outside who haven't
  since checked in.
- An accepted record stores `distance_m`, `location_accuracy_m` and `geofence_result`.

## Phase 5: Student-app specification ✅

[`student-app-checkin.md`](student-app-checkin.md): the request format, every
error code with the message to show, platform settings (web, Android, iOS,
Flutter), approximate-vs-precise location, the best-of-several-readings
approach, privacy wording, and a test checklist.

## Extra: check-in rate limiting (backend) ✅

A whole class on campus Wi-Fi shares one public IP address, so the global
limit of 100 requests per 15 minutes per IP would have locked out a lecture
hall. The two check-in routes are now exempt from it. Instead they allow
**20 attempts per 5 minutes per signed-in student**, with a **3000-per-IP**
backstop (`CHECKIN_RATE_LIMIT_*` in `.env.example`).

---

## Phase 6: Lecturer portal (frontend) ⏳

**Why this is urgent:** since Phase 3, activating a class in an **unsurveyed
room fails with 422**, because the portal does not send a location yet. Until
6.1 ships, the only workaround is sending `geofence: 'OFF'`.

### 6.0 Backend additions the portal needs ✅ done

Shipped and covered by integration tests. The frontend can build against these shapes.

| # | Endpoint | Added | Used by |
|---|---|---|---|
| B1 | `GET /units/current` and `GET /units` | `room: { code: string; surveyed: boolean } \| null` on each unit | 6.1: decides whether to ask for the lecturer's location |
| B2 | `GET /attendance/sessions/:id` | per attendee: `distanceMetres: number \| null`, `geofenceResult: 'INSIDE' \| 'NOT_CHECKED'` | 6.2, 6.3 |
| B3 | `GET /reports/sessions`, and the CSV at `/reports/sessions/:id/export` | per session: `geofenceMode: 'ROOM' \| 'LECTURER_DEVICE' \| 'OFF'` (the session's final setting; mid-session changes are in the audit log); CSV: a `Distance (m)` column | 6.3 |

### 6.1 Activate Class (`src/features/attendance/ActivateClass.tsx`)

**What the lecturer sees**

- The room: "Room **LH1** · location surveyed ✓", or "Room **LH1** · not
  surveyed: your device's location will be used", or "No room on the timetable".
- A **Geofence** switch, on by default, with the help text "Only students in
  the room can check in."
- When the fence is on and the room is **not** surveyed:
  - ask the browser for a location as soon as the page opens (see *Getting the
    lecturer's location* below), and show progress: "Finding your location… ±45 m";
  - **30 m or better** → "Location ready (±12 m)" and the Activate button is enabled;
  - **worse than 30 m** after 10 s → a warning: "Your location is only accurate
    to about 120 m. Activate from a phone, or turn the geofence off for this
    class." Activate stays disabled until the reading improves or the switch is
    turned off. Offer a **Try again** button;
  - **permission denied** → "Location access is blocked. Allow it in the
    browser, activate from a phone, or turn the geofence off."
- When the room **is** surveyed, don't ask for a location at all. The server
  uses the room's point.

**Request**

```ts
// POST /sessions
{
  unitId: string,
  geofence: 'ON' | 'OFF',
  // only when the fence is on and the room is not surveyed
  location?: { latitude: number, longitude: number, accuracy: number },
}
```

**Server refusal to handle:** `422` with `code: 'GEOFENCE_ANCHOR_UNAVAILABLE'`.
Show `error.message` (it already says what to do) and a button: **Turn geofence
off and activate**, which resends with `geofence: 'OFF'`.
`error.details = { reason: 'NO_READING' | 'TOO_IMPRECISE', accuracyMetres: number | null, maxAccuracyMetres: number }`.

### 6.2 Live session (`src/features/attendance/LiveSessionPage.tsx`)

Everything comes from `GET /sessions/:id/qr`, which is already polled by
`useSessionQr`: read `session.geofence` and `refusedOutsideFence`.

**Badge**, by `session.geofence.mode`:

| Mode | Badge |
|---|---|
| `ROOM` | 🟢 Geofence: 20 m · LH1 |
| `LECTURER_DEVICE` | 🟢 Geofence: 20 m · around your device (±12 m) |
| `OFF` | ⚪ Geofence off: students can check in from anywhere |

(`radiusMetres`, `roomCode`, `anchorAccuracyMetres` fill in the numbers.)

**Controls**

| Button | Shown when | Request |
|---|---|---|
| Turn geofence off | mode ≠ `OFF` | `PATCH /sessions/:id/geofence` `{ mode: 'OFF' }`. Confirm first: "Students will be able to check in from anywhere. This change is recorded." |
| Turn geofence on | mode = `OFF` | `{ mode: 'ON' }`. If that returns 422 (no centre point yet), get the lecturer's location and resend with `location` |
| Re-capture my location | mode = `LECTURER_DEVICE` | Get a fresh location (same flow as 6.1), then `{ mode: 'ON', location }`. Hide it for `ROOM`: the server always keeps a surveyed room's point |

All three return the updated `SessionSummary`. On success, invalidate
`['sessions', id, 'qr']`. The server returns `409` once the session is closed,
and `422 GEOFENCE_ANCHOR_UNAVAILABLE` for a vague re-capture, in which case the
fence stays where it was.

**Refused count:** when `refusedOutsideFence > 0`, show "**3** students refused:
outside the room" next to the checked-in counter. A student who later checks
in drops out of this count. A high number usually means the centre point is
wrong: suggest re-capturing, or report the room for re-survey.

### 6.3 Attendance reports (`AttendanceReportsPage.tsx`, `reportingApi.ts`)

Needs B2 and B3.

- The session list shows a geofence column: "On · room", "On · device", or "Off".
- In each session's attendee list, show the distance next to each check-in
  (`7 m`), or "—" when the fence was off (`geofenceResult: 'NOT_CHECKED'`).
- The CSV export gains a `Distance (m)` column (server side, B3).

### 6.4 Types and mock API

**`src/types/index.ts`:**

```ts
export type GeofenceMode = 'ROOM' | 'LECTURER_DEVICE' | 'OFF'

export interface GeofenceStatus {
  mode: GeofenceMode
  radiusMetres: number | null
  roomCode: string | null
  anchorAccuracyMetres: number | null
  /** Whether turning it back on can reuse the stored centre without a new reading. */
  hasCentre: boolean
}

export interface DeviceLocation { latitude: number; longitude: number; accuracy: number }

// SessionSummary: add
  geofence: GeofenceStatus

// CurrentQr: add
  refusedOutsideFence: number

// CreateSessionInput: add
  geofence?: 'ON' | 'OFF'
  location?: DeviceLocation

// TaughtUnit: add (B1)
  room: { code: string; surveyed: boolean } | null

// SessionAttendance.attendees[]: add (B2)
  distanceMetres: number | null
  geofenceResult: 'INSIDE' | 'NOT_CHECKED'

// RecentSession: add (B3)
  geofenceMode: GeofenceMode
```

`ApiErrorBody.details` is typed as a list of field errors, but geofence errors
return an object (see 6.1). Widen it to `unknown`, or add a union type, and
narrow on `code`.

**`sessionApi.ts`:** add
`useSetGeofence(sessionId)` → `PATCH /sessions/:id/geofence`, which invalidates
`['sessions', id, 'qr']`.

**`src/mocks/handlers.ts`:**

- `POST /sessions`: return `geofence`. With `geofence: 'ON'`, no surveyed room
  and no `location` (or `accuracy > 30`), return the 422 above so the refusal
  UI can be built.
- `GET /sessions/:id/qr`: include `geofence` and `refusedOutsideFence`.
- New `PATCH /sessions/:id/geofence`.
- `GET /units/current` and `GET /units`: include `room`. Have one mock unit
  surveyed and one not.
- Attendee and report mocks: include `distanceMetres`, `geofenceResult` and `geofenceMode`.

### Getting the lecturer's location (6.1 and 6.2)

Take the best of several readings. The first one is usually network-based
and poor.

```ts
/** Best reading within `maxWaitMs`; stops early once one is accurate to `goodEnough` metres. */
export function bestFix(maxWaitMs = 10_000, goodEnough = 15): Promise<DeviceLocation | null> {
  return new Promise((resolve) => {
    let best: GeolocationPosition | null = null
    const done = () => {
      navigator.geolocation.clearWatch(id)
      clearTimeout(timer)
      resolve(best && { latitude: best.coords.latitude, longitude: best.coords.longitude, accuracy: best.coords.accuracy })
    }
    const id = navigator.geolocation.watchPosition(
      (fix) => {
        if (!best || fix.coords.accuracy < best.coords.accuracy) best = fix
        if (fix.coords.accuracy <= goodEnough) done()
      },
      () => done(),
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs },
    )
    const timer = setTimeout(done, maxWaitMs)
  })
}
```

- Report progress as readings arrive, so the lecturer sees the accuracy improve.
- Distinguish permission denied (`error.code === 1`) from no reading, for the messages in 6.1.
- **HTTPS is required.** Browsers only share location with secure pages
  (`localhost` is allowed in development). The production portal must be
  served over HTTPS.
- Laptops usually locate by Wi-Fi only (±50-150 m) and will often fail the
  30 m limit. That's expected: the message tells the lecturer to use a phone.
  It stops being an issue once rooms are surveyed.

### 6.5 Frontend tests

- **Vitest + Testing Library** (with the MSW handlers above):
  - surveyed room: activates without asking for location
  - unsurveyed room: location ≤ 30 m enables Activate; > 30 m disables it and shows the warning
  - permission denied: shows the blocked-location message
  - a 422 from the server offers "Turn geofence off and activate", which resends with `geofence: 'OFF'`
  - the live page shows the right badge for each mode; turn off asks for confirmation and calls the PATCH
  - the refused count appears only when above 0
- **Playwright:** stub `navigator.geolocation` with `context.setGeolocation(...)`
  and `context.grantPermissions(['geolocation'])` for the activate → live →
  turn off/on flow.

### Phase 6 done when

- [x] B1-B3 shipped on the backend
- [ ] A lecturer can activate in a surveyed room from a laptop, and in an unsurveyed room from a phone
- [ ] A vague reading or denied permission leads to a clear message and the off-switch, never a dead end
- [ ] The live page shows the fence, can switch it off and on, re-capture the location, and shows the refused count
- [ ] Reports show distances and the fence mode
- [ ] Types, mock handlers and tests updated; `npm run typecheck`, `npm run lint` and `npm test` pass
- [ ] Production portal served over HTTPS

---

## Phase 7: Tests (backend) ✅

- `tests/unit/session-geofence.test.ts`: real-world distances (one degree,
  Nairobi-Mombasa, the antimeridian), and the exact edges of the rule (20 m
  radius, 50 m accuracy, 60 s fix age, 30 m anchor accuracy).
- `tests/integration/units-attendance.test.ts`:
  - check-ins inside, outside, with a vague reading, with no location, with a faked location
  - a stale reading
  - the geofence off, including switched off mid-session
  - the room's coordinates taking priority over the lecturer's location
  - activation refused for a vague reading
  - turning the geofence off being audited
  - the refused counter
- `tests/integration/units-smarttt-sync.test.ts`: rooms saved from SMARTTT.
- `tests/unit/checkin-rate-limit.test.ts`: 200 students on one IP all get
  through; one student is limited on their own.

---

## Before go-live

- [ ] Commit the backend work (phases 2-5 and rate limiting)
- [ ] Run `npm run db:migrate` on every environment (applies `012_geofence.sql`; local dev databases may also be missing 007-011)
- [ ] Survey the real rooms using [`room-survey-sheet.md`](room-survey-sheet.md)
- [ ] Phase 6 shipped, with the portal on HTTPS
- [ ] Student app sends `location` ([`student-app-checkin.md`](student-app-checkin.md)). Until it does, check-ins to fenced sessions are refused with `LOCATION_REQUIRED`
- [ ] Brief lecturers: the switch-off exists for rooms with bad GPS, and every use of it is recorded

## Limits accepted up front

- **Faked GPS can't be fully stopped.** `isMocked` catches the easy cases, mainly on Android.
- **Floors:** a 20 m circle covers the rooms above and below. Accepted, since students there can't see the QR code.
- **Lecturer's location:** until rooms are surveyed, a lecturer on a laptop will often be asked to activate from a phone.
- **HTTPS:** without it, browsers won't share location.
- **Large halls:** one radius (20 m) for all rooms covers a room about 40 m across. Bigger halls would need a per-room radius (not built).
- **Rate limits are per server instance:** with several backend instances, each counts separately.

## Open decisions

- **Reject or flag** a check-in outside the fence? Currently **reject**. Flagging it for the lecturer to review instead is possible, but hasn't been decided.
- **Per-room radius** for halls wider than about 40 m: decide after the survey.
