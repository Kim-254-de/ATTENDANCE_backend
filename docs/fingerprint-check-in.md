# Fingerprint check-in: what a terminal sends

What a fingerprint terminal has to do to record attendance. Everything on the
server side is built; this is the contract the hardware has to meet.

The sibling documents are `card-check-in.md` and `student-app-checkin.md`.

---

## 1. The decision this rests on

**No fingerprint, template or image ever reaches this service.**

The readers this is built for — R307, ZFM-20, GROW R503 and similar — hold
their own template store on the module and run the 1:N match themselves. On a
match they report which of their own slots the template was enrolled in. So
the division of labour is:

| | Who does it |
|---|---|
| Capture the finger | the reader |
| Store the template | the reader |
| Match 1:N against enrolled fingers | the reader |
| Say which student that slot belongs to | this service |
| Decide whether the check-in counts | this service |

That keeps biometric data, its retention and the consent that goes with it out
of this system entirely. It is also the only version that could be built before
the hardware was chosen, since nothing here depends on a vendor's template
format.

**The consequence to plan around:** a slot number is only meaningful on the
reader that enrolled it. Slot 37 on `TERM-01` and slot 37 on `TERM-02` are
different people. A student who should be recognised by two terminals must be
enrolled on both — on the devices *and* here.

---

## 2. The request

```http
POST /api/v1/attendance/fingerprint-check-in
X-API-Key: <FINGERPRINT_TERMINAL_API_KEY>
Content-Type: application/json

{
  "sessionId": "3311322c-5de5-4cda-b81c-95400d0ea297",
  "terminalId": "TERM-01",
  "fingerRef": "37"
}
```

| Field | |
|---|---|
| `sessionId` | The class being recorded. The lecturer's interface hands this to the terminal when they activate the class — the terminal does not guess it |
| `terminalId` | This reader's own id, configured once on the device. Identifies whose slot numbering `fingerRef` belongs to |
| `fingerRef` | The slot the reader matched. Opaque here; letters, digits, `:`, `_`, `-`, up to 64 characters |

Nothing else is accepted. A body carrying a template or an image is refused by
the schema — if that is ever needed, it is a design change, not a field.

The key is **separate from the card terminals' key**, so one class of device can
be revoked without taking the other down.

### Success

```json
{
  "success": true,
  "data": {
    "recordId": "40497025-6318-4d87-b9f6-7b8c8e46d73b",
    "sessionId": "3311322c-5de5-4cda-b81c-95400d0ea297",
    "unitCode": "COSC 205",
    "recordedAt": "2026-10-10T12:26:30.485Z",
    "student": { "fullName": "Amina Wanjiku Kamau", "registrationNumber": "SC211/0001/2022" }
  }
}
```

Show the name. A student who sees someone else's has been matched to the wrong
slot, and that is worth catching at the moment it happens rather than in a
report at the end of term.

---

## 3. What to show for each answer

| Status | What happened | Show |
|---|---|---|
| `201` | Recorded | The student's name, briefly, then ready for the next finger |
| `404` | Slot not enrolled here, or revoked | "Fingerprint not registered on this terminal" |
| `404` | No such session | "This class is not running" — the id is stale, ask the lecturer's screen again |
| `403` | Not on this unit's roster | "You are not registered for COSC 205" |
| `409` | Already recorded — by any method | "Already marked present" — not an error, do not style it as one |
| `409` | Class closed, paused, or outside its window | "This class is not taking attendance" |
| `409` | Fingerprint not enabled for this class | "This class is not taking fingerprint check-ins" |
| `400` | Malformed body | A configuration or firmware fault — log it, do not show the student |
| `401` | Key missing or wrong | Refuse to start rather than failing per finger |
| `429` | Too many presentations from this address | Back off and retry |

An unenrolled slot and a revoked one give the same answer deliberately. A
terminal should not be a way to discover which fingers are enrolled.

A student already recorded by QR, face or card gets the `409` too — one record
per student per class, whichever method got there first.

---

## 4. Practical notes

**Retry safely.** On a timeout, retry once and treat `409` as success: the
one-record-per-session constraint means a retry cannot double-record.

**Rate limiting.** Every presentation in a hall comes from one terminal, so this
route is exempt from the global per-IP bucket and takes only the higher
check-in backstop. A class of 200 will not hit it; a looping reader will.

**Offline.** There is no store-and-forward. A terminal that cannot reach the API
should say so rather than appear to accept fingers. Queuing would need a ruling
on how late a presentation may still count, and nothing has made one.

**Enrolment is two steps, and both must happen.** The template goes on the
reader; the mapping goes here:

```bash
npm run dev:enrol-fingerprint -- SC211/0001/2022 TERM-01 37 --label "right index"
npm run dev:enrol-fingerprint -- SC211/0001/2022 TERM-01 --revoke
npm run dev:enrol-fingerprint -- SC211/0001/2022 --revoke-all
npm run dev:enrol-fingerprint -- SC211/0001/2022 --list
```

Revoking here stops the check-in working, but **does not clear the template off
the reader** — do that on the device too, or the finger still matches a slot
that now maps to nobody.

**The slot reference is not recoverable.** Only an HMAC of it is stored, keyed
with `FINGERPRINT_REF_SECRET`, because a slot number in the low hundreds would
otherwise be guessable from a database dump and a reference is all it takes to
post a check-in. To move a student to a different slot, revoke and re-enrol.

---

## 5. If you buy a reader that exports templates

Then matching could move server-side and a single enrolment would work across
every terminal. That is a different system, with real obligations: templates are
biometric data, needing consent, a retention policy and a breach plan. The team
already worked through that reasoning for face recognition
(`docs/face-recognition.md`), so there is a precedent to follow rather than a
decision to make from scratch.

The schema here survives that change: `terminal_id` becomes a constant and
`finger_ref_hmac` becomes a stable per-student reference. Nothing else moves.
