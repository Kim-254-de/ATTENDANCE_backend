# Student app: checking in

What the student app sends when a student scans the QR code on the lecturer's
screen, what can come back, and how to get a location reading the server will
accept. The app can be built against this without touching the backend.

Server side: `src/modules/session/session.geofence.ts` (the rule),
`session.service.ts verifyScan` (the order of checks),
`src/modules/attendance/attendance.service.ts` (the record).

---

## 1. The flow

1. The student opens the scanner. **Start getting a location reading now**, in
   parallel (section 4). A good GPS fix can take several seconds; the QR code
   is only valid for 45-90 seconds.
2. The camera reads the QR code: a string like `v1.<sessionId>.<counter>.<signature>`.
   Treat it as opaque.
3. Wait for the location reading (up to the time limit in section 4), then send
   both in one request.
4. Show the result (section 6).

**Always send a location if you have one.** The app cannot tell whether this
session's geofence is on, so it should not try to. If the lecturer switched
it off, the server ignores the location. If the student refused location
permission, send the request without `location`: a session with the fence off
still accepts it, and one with the fence on answers `LOCATION_REQUIRED`, which
the app turns into a prompt to allow location access.

---

## 2. The request

```http
POST /api/v1/attendance/check-in
Authorization: Bearer <access token>
Content-Type: application/json
```

```json
{
  "payload": "v1.3f1b2c4d-0000-4000-8000-000000000001.39174861.q0hC9w0qkT3Rrb5Yx3m6NQ",
  "location": {
    "latitude": -0.370312,
    "longitude": 35.932241,
    "accuracy": 9.6,
    "capturedAt": 1790499662113,
    "isMocked": false
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `payload` | string | yes | Exactly what the camera read. 8-512 characters |
| `location` | object | when available | Omit the whole object if there is no reading. Never send a partial one |
| `location.latitude` | number | yes | Decimal degrees, -90 to 90 |
| `location.longitude` | number | yes | Decimal degrees, -180 to 180 |
| `location.accuracy` | number | yes | Horizontal accuracy in **metres**, as the OS reports it (68% confidence radius). 0 or more |
| `location.capturedAt` | number or string | yes | When the **fix was taken**, not when the request is sent. Epoch **milliseconds** (what browsers and Android give you) or an ISO 8601 string with an offset (`2026-09-28T09:01:02.113Z`) |
| `location.isMocked` | boolean | no | `true` if the OS says the location is faked (section 4). Omit it when the platform can't tell you. Do not send `false` just because you didn't check |

Numbers must be JSON numbers, not strings. Any other field (`altitude`,
`speed`, ...) is rejected with `400`, so send only these.

`POST /api/v1/sessions/scan` takes the same body and applies the same checks,
but only returns a verdict; it does not record attendance. Production check-in
uses `/attendance/check-in`.

---

## 3. What the server checks, in order

1. The code: well-formed, signed, not expired.
2. The session: open, not paused, inside its time window.
3. **The location**, if the lecturer has the geofence on:
   1. no `location` -> `LOCATION_REQUIRED`
   2. `isMocked: true` -> `LOCATION_MOCKED`
   3. `capturedAt` more than **60 s** away from the server's clock (older, or
      ahead) -> `LOCATION_STALE`
   4. `accuracy` worse than **50 m** -> `LOCATION_TOO_IMPRECISE`
   5. `distance to the room's centre - accuracy > 20 m` -> `OUTSIDE_GEOFENCE`
4. The student is on the class list.
5. The student hasn't already checked in to this session.

The limits above are the defaults. The error details (section 6) carry the
values actually in force, so display those rather than hard-coding them.

Step 3.5 gives the student the benefit of the doubt: a reading 30 m from the
centre with 15 m accuracy is accepted, because the student might really be
15 m away. That's why step 3.4 exists: without it, a 500 m-accurate reading
from anywhere nearby would pass.

---

## 4. Getting a reading the server will accept

### Settings

| Platform | How |
|---|---|
| Web / PWA | `navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })`. `accuracy` = `coords.accuracy`, `capturedAt` = `position.timestamp`. Browsers cannot report mocking: omit `isMocked`. Requires HTTPS |
| Android (native) | `FusedLocationProviderClient` with `Priority.PRIORITY_HIGH_ACCURACY`, via `getCurrentLocation` or a short `requestLocationUpdates`. **Never** `getLastLocation()`: it is a cached fix. `accuracy` = `location.accuracy`, `capturedAt` = `location.time`. `isMocked` = `location.isMock` (API 31+) or `location.isFromMockProvider` (API 18-30) |
| iOS (native) | `CLLocationManager` with `desiredAccuracy = kCLLocationAccuracyBest`. `accuracy` = `horizontalAccuracy` (a **negative** value means invalid: discard the fix), `capturedAt` = `timestamp`. On iOS 15+, `isMocked` = `sourceInformation?.isSimulatedBySoftware` |
| Flutter (`geolocator`) | `Geolocator.getPositionStream(locationSettings: LocationSettings(accuracy: LocationAccuracy.best))`. `accuracy` = `position.accuracy`, `capturedAt` = `position.timestamp`, `isMocked` = `position.isMocked` (reliable on Android only; omit it on other platforms) |

### Precise location must be on

Android 12+ and iOS 14+ let the user grant **approximate** location only. An
approximate fix is accurate to 1-3 km and will always fail with
`LOCATION_TOO_IMPRECISE`. Request precise/full accuracy (iOS:
`requestTemporaryFullAccuracyAuthorization`; Android: ask for
`ACCESS_FINE_LOCATION`), and if the user has chosen approximate, tell them
check-in needs precise location.

### Take the best of several fixes

The first fix is often the worst: network-based, with 100 m+ accuracy.
GPS improves over the next few seconds. So:

1. Start watching when the scanner opens.
2. Keep the fix with the smallest `accuracy`.
3. Stop as soon as a fix is accurate to **20 m or better**, or after
   **10 seconds**, whichever comes first.
4. Send the best fix, provided it is **less than 60 seconds old** when sent.
   If it is older, keep watching for a fresh one.

```ts
/** Web example. The same shape works with any platform's location stream. */
function bestFix(maxWaitMs = 10_000, goodEnoughMetres = 20): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    let best: GeolocationPosition | null = null;
    const finish = () => { navigator.geolocation.clearWatch(watchId); clearTimeout(timer); resolve(best); };
    const watchId = navigator.geolocation.watchPosition(
      (fix) => {
        if (!best || fix.coords.accuracy < best.coords.accuracy) best = fix;
        if (fix.coords.accuracy <= goodEnoughMetres) finish();
      },
      () => finish(), // denied or unavailable: send without location
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs },
    );
    const timer = setTimeout(finish, maxWaitMs);
  });
}

const fix = await bestFix();
const body = {
  payload,
  ...(fix && Date.now() - fix.timestamp < 60_000
    ? { location: { latitude: fix.coords.latitude, longitude: fix.coords.longitude,
                    accuracy: fix.coords.accuracy, capturedAt: fix.timestamp } }
    : {}),
};
```

Show progress while waiting ("Getting your location... ±35 m"), so a
10-second wait doesn't look like a hang.

### The QR code expires while you wait

The code is valid for about 45-90 seconds from when it appeared on screen.
Starting location at scanner-open (step 1 of section 1) usually hides the
wait entirely. If you get `410` (expired code) after waiting on location, ask
the student to scan again; the location watch can keep running in between.

---

## 5. Success

`201 Created`:

```json
{
  "success": true,
  "data": {
    "recordId": "8c7b...",
    "sessionId": "3f1b...",
    "unitCode": "COSC 100",
    "recordedAt": "2026-09-28T09:01:03.412Z",
    "distanceMetres": 7.4
  }
}
```

`distanceMetres` is how far from the room's centre the check-in was, or `null`
when the lecturer had the geofence off.

---

## 6. Errors

Every error has the same shape:

```json
{
  "success": false,
  "error": {
    "code": "OUTSIDE_GEOFENCE",
    "message": "You appear to be about 140 m from LH1. Check-in only works from inside the room.",
    "details": { "...": "..." }
  },
  "requestId": "..."
}
```

**Branch on `error.code`, not the HTTP status.** Several codes share a status
(403 is also used for "not on the class list"). `error.message` is written to
be shown to the student as-is; use your own wording if you prefer, but keep
the meaning.

### Location errors

For these, `error.details` is:

```json
{
  "reason": "OUTSIDE_GEOFENCE",
  "roomCode": "LH1",
  "radiusMetres": 20,
  "maxAccuracyMetres": 50,
  "maxFixAgeSeconds": 60,
  "distanceMetres": 140,
  "accuracyMetres": 8
}
```

`roomCode` may be `null` (the timetable names no room). `distanceMetres` and
`accuracyMetres` are `null` when the server never got as far as measuring,
and are rounded ("about 140 m"). `radiusMetres` is the session's own radius.

| Code | Status | Server message | What the app should do |
|---|---|---|---|
| `LOCATION_REQUIRED` | 422 | This class checks your location. Allow location access for the app and scan again. | Permission denied: explain why and open settings. No fix: retry the reading |
| `LOCATION_STALE` | 422 | Your location reading is out of date. Wait a moment for a fresh reading and scan again. | Get a fresh fix and resend. If a fresh fix is still refused, the **phone's clock** is probably wrong: tell the student to turn on automatic date and time |
| `LOCATION_TOO_IMPRECISE` | 422 | Your location reading is not precise enough. Move near a window, wait a few seconds and scan again. | Show the current accuracy against `maxAccuracyMetres`, keep watching for a better fix, check precise location is on (section 4) |
| `LOCATION_MOCKED` | 403 | Your phone reports that its location is being faked. Turn off any location-changing app and scan again. | Do not retry automatically. The refusal is recorded |
| `OUTSIDE_GEOFENCE` | 403 | You appear to be about 140 m from LH1. Check-in only works from inside the room. | Show the distance. Do not retry automatically; the student can move and rescan. The lecturer sees a count of students refused this way |

**422: the phone can fix it; retrying makes sense. 403: retrying won't help.**
Don't retry in a loop either way: each student gets 20 attempts per 5 minutes
(below), and every refusal is audited.

### Everything else

| Code | Status | When | What the app should do |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | Malformed body (`details` lists the fields), or not an attendance code | Fix the request / "That isn't an attendance QR code" |
| `VALIDATION_FAILED` | 410 | The code has expired, or is from the future (phone clock) | "Scan the code currently on screen" |
| `CONFLICT` | 409 | Session closed, paused, not started or ended; **or** already checked in | Show the message; "already recorded" is a success state for the student |
| `FORBIDDEN` | 403 | Not on this class's list, not signed in as a student, or the account is not active | Show the message ("Contact your department if this is wrong") |
| `UNAUTHENTICATED` | 401 | Access token missing or expired | Refresh the session (`POST /api/v1/auth/refresh`) and retry once; if that fails, sign in again |
| `RATE_LIMITED` | 429 | This student made more than 20 check-in attempts in 5 minutes (`/check-in` and `/sessions/scan` share the allowance). Limits are per student, so classmates on the same Wi-Fi are unaffected | Wait for the `Retry-After` header (seconds) before trying again. Never retry automatically on 429 |

---

## 7. Privacy

The server uses the reading to work out how far the student is from the room,
then discards it. **Coordinates are never stored**: an attendance record keeps
only the distance and the reading's accuracy, and a refused scan's audit entry
the same. Suggested wording for the permission prompt:

> Your location is used once, when you check in, to confirm you're in the
> classroom. Only your distance from the room is kept, not where you were.

Only ask for location **while the app is in use**. It is never needed in the
background.

---

## 8. Testing against a local backend

1. Survey a room: `npm run dev:set-room -- LH1 <lat> <lng> 5`, using a point you
   can stand at, then put a class in it (the SMARTTT sync does this; or
   `UPDATE unit_schedule SET room_code = 'LH1' WHERE unit_id = '...'`).
2. Activate the class from the lecturer portal and check in from the app at
   that point: accepted, with a small `distanceMetres`.
3. Walk 100 m away and scan again: `OUTSIDE_GEOFENCE`.
4. Deny location permission: `LOCATION_REQUIRED`.
5. Android: turn on a mock-location app from developer options: `LOCATION_MOCKED`.
6. Indoors, away from windows, with Wi-Fi off: expect `LOCATION_TOO_IMPRECISE`
   sometimes. Check the app's waiting and messages feel reasonable.
7. Have the lecturer switch the geofence off: check-in works from anywhere.
