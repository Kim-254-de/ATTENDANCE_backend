# Card check-in: what a terminal sends

What a card terminal has to do to record attendance. Everything on the server
side is built; this is the contract the hardware has to meet.

The parallel document for phones is `student-app-checkin.md`.

---

## 1. The shape of it

A terminal is a peripheral, not a user. It does not sign in, it holds no
session, and it does not decide anything: it reads a card, posts the UID, and
shows whatever came back.

```
student taps card
   -> terminal reads UID            (the part still to build)
   -> POST /api/v1/attendance/card-check-in
   -> 201  "Recorded: Amina Wanjiku"
      404  "This card is not recognised"
      409  "Already recorded"  /  "This class is not taking ID card check-ins"
      403  "This student is not registered for COSC 205"
```

The terminal needs two things configured once, and one thing per class:

| | Where it comes from |
|---|---|
| `CARD_TERMINAL_API_KEY` | Set on the server; the same value burned into the terminal |
| API base URL | The deployment, e.g. `https://attendance-backend-kx0n.onrender.com/api/v1` |
| `sessionId` | The lecturer's interface, when they activate the class |

The session id is deliberately not guessed. A terminal knows the room it sits
in, not which class the timetable says is running there, and recording a swipe
against the wrong class is worse than refusing it. The lecturer's interface
hands the id over when the class is activated.

---

## 2. The request

```http
POST /api/v1/attendance/card-check-in
X-API-Key: <CARD_TERMINAL_API_KEY>
Content-Type: application/json

{
  "sessionId": "3311322c-5de5-4cda-b81c-95400d0ea297",
  "cardUid": "04:A3:B2:C1"
}
```

`cardUid` is the UID exactly as the reader reports it. Case and byte
separators do not matter — `04:A3:B2:C1`, `04-a3-b2-c1` and `04a3b2c1` are the
same card — so there is no need to normalise before sending. Hex only, 4 to 64
characters; anything else is a 400, because a reader sending something else is
misconfigured and that is worth knowing.

Nothing else is accepted in the body. There is no location field: a student at
the terminal is in the room by construction, so the geofence that checks a
*phone's* claim does not apply, and the record is stored `NOT_CHECKED`.

### Success

```json
{
  "success": true,
  "data": {
    "recordId": "40497025-6318-4d87-b9f6-7b8c8e46d73b",
    "sessionId": "3311322c-5de5-4cda-b81c-95400d0ea297",
    "unitCode": "COSC 205",
    "recordedAt": "2026-10-08T12:26:30.485Z",
    "student": { "fullName": "Amina Wanjiku Kamau", "registrationNumber": "SC211/0001/2022" }
  }
}
```

`student` is there so the terminal can show who it just recorded. A student who
sees someone else's name has been handed the wrong card, and that is worth
catching at the door.

---

## 3. What to show for each answer

| Status | `error.code` | What happened | Show |
|---|---|---|---|
| `201` | — | Recorded | The student's name, briefly, then ready for the next card |
| `404` | `NOT_FOUND` | Card not enrolled, or revoked | "Card not recognised — see your department" |
| `404` | `NOT_FOUND` | No such session | "This class is not running" — the id is stale, ask the lecturer's screen again |
| `403` | `FORBIDDEN` | Not on this unit's roster | "You are not registered for COSC 205" |
| `409` | `CONFLICT` | Already recorded | "Already marked present" — not an error, do not make it look like one |
| `409` | `CONFLICT` | Class closed, paused, or outside its window | "This class is not taking attendance" |
| `409` | `CONFLICT` | Card scanning not enabled for this class | "This class is not taking ID card check-ins" |
| `400` | `VALIDATION_FAILED` | Malformed UID or session id | A reader or configuration fault — log it, do not show the student |
| `401` | `INVALID_API_KEY` | Key missing or wrong | A configuration fault; the terminal should refuse to start rather than fail per swipe |
| `429` | `RATE_LIMITED` | Too many swipes from this address | Back off and retry; see below |

An unknown card and a revoked one give the same answer on purpose. A terminal
at the door should not be a way to find out which cards exist.

---

## 4. Practical notes

**Retry carefully.** Check-in is not idempotent in the usual sense, but it is
safe to retry: a second swipe for a student already recorded returns `409`, not
a duplicate row. So on a timeout, retry once and treat `409` as success.

**Rate limiting.** Every swipe in a hall comes from one address, so the card
route is exempt from the global per-IP bucket and takes only the higher
check-in backstop (`CHECKIN_RATE_LIMIT_PER_IP`). A class of 200 will not hit
it; a faulty reader looping will. On `429`, wait and retry rather than dropping
the swipe.

**Offline.** There is no store-and-forward. A terminal that cannot reach the
API cannot record attendance, and should say so rather than appear to accept
cards. Queuing swipes locally would need a decision about how late a swipe may
still count, which nothing has made yet.

**Enrolment.** A card has to be bound to a student before it works. There is no
administrator interface yet; locally:

```bash
npm run dev:enrol-card -- SC211/0001/2022 04:A3:B2:C1
npm run dev:enrol-card -- SC211/0001/2022 --revoke     # lost card
npm run dev:enrol-card -- SC211/0001/2022 --list
```

One usable card per student. Replacing one means revoking first, which keeps
the old row so the attendance it recorded still makes sense.

**The UID is not recoverable.** Only an HMAC of it is stored, keyed with
`CARD_UID_SECRET`. That is deliberate — see `src/common/utils/card-uid.ts` for
why a plain hash would not be enough for something this short — but it means
there is no way to ask the server which card a student holds. Rotating
`CARD_UID_SECRET` invalidates every enrolled card, which is the recovery path
if `student_cards` ever leaks.
