# verification module

**Face check-in**: QR's fallback, and QR is face's. Plan, decisions and
phases: [`docs/face-recognition.md`](../../../docs/face-recognition.md).

A student is recorded **once** per session, by QR or by face, whichever comes
first. The second attempt gets the usual *"already been recorded"* 409 from the
`UNIQUE (session_id, student_user_id)` constraint on `attendance_records`.

## How it fits together

```text
lecturer's phone ──photo──► verification ──image──► face-service (Python)
                                 │  ◄──template────┘
                                 │  compares against the unit's enrolled students
                                 ▼
                       attendance.recordFaceCheckIn ──► attendance_records (method FACE)
```

face-service (`face-service/`) only turns a photo into a template. Which
students may match, the thresholds and the stored templates all live here, so
the model can be swapped without touching data.

1. **Consent.** The student opts in from their own app
   (`PUT /students/me/face-consent`). Withdrawing it deletes their templates.
2. **Enrollment.** The lecturer picks the student from the unit's roster,
   checks their ID card, and sends three photos. Each must show exactly one
   usable face; the three must agree with each other
   (`FACE_MATCH_THRESHOLD`); and none may match another enrolled student,
   anywhere in the school.
3. **Identify.** The terminal (the lecturer's phone) sends one photo. The
   largest face is compared against the templates of students **ACTIVE on the
   session's unit** who still consent. A clear winner comes back with a
   **match token**. Nothing is recorded.
4. **Confirm.** The lecturer checks the face against the person and sends the
   token back. The student is recorded with `method = 'FACE'`, the score, and
   who confirmed.

## The match token

`face.token.ts`. Signed with the session's QR secret, bound to the session, the
student and the score, and valid for `FACE_MATCH_TOKEN_TTL_SECONDS` (60).
Confirm accepts only a student the server matched on that session, so the
endpoint cannot be used to mark an arbitrary student present. Nothing is
stored: confirming twice hits the one-record constraint.

## Matching

`face.match.ts`, pure. A student's score is their best template's cosine
similarity. A match needs:

- the best score at or above `FACE_MATCH_THRESHOLD` (default 0.40), and
- a lead of at least `FACE_MATCH_MARGIN` (0.05) over the runner-up. Otherwise
  the result is `AMBIGUOUS` and nobody is offered.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/students/me/face` | Student | Consent and enrollment status |
| `PUT` | `/api/v1/students/me/face-consent` | Student | Opt in |
| `DELETE` | `/api/v1/students/me/face-consent` | Student | Opt out; deletes templates |
| `POST` | `/api/v1/units/:unitId/students/:studentUserId/face` | Lecturer (teaches the unit) | Enroll from `{ images: [3 data URLs] }`. 201 `{ studentUserId, enrolledAt, replaced }` |
| `DELETE` | `/api/v1/units/:unitId/students/:studentUserId/face` | Lecturer (teaches the unit) | Remove the enrollment; consent stays |
| `POST` | `/api/v1/sessions/:sessionId/face/identify` | Lecturer (owns the session) | `{ image }` → `MATCH` (with `student`, `score`, `alreadyCheckedIn`, `matchToken`, `expiresAt`), `NO_MATCH` or `AMBIGUOUS`; all with `facesInFrame` and `enrolledOnUnit` |
| `POST` | `/api/v1/sessions/:sessionId/face/confirm` | Lecturer (owns the session) | `{ matchToken }` → 201 with the record |

The session must be open and inside its window, as for QR. The unit roster
(`GET /units/:unitId/students`) shows `faceConsent` and `faceEnrolled` for each
student, and the attendance list shows each record's `method`.

## Errors

| Status | Code | When | Terminal should |
|---|---|---|---|
| 422 | `FACE_NOT_FOUND` | No face in the photo | Retake |
| 422 | `FACE_MULTIPLE` | Enrollment photo with several faces (`details.photo` says which) | Retake that photo |
| 422 | `FACE_POOR_QUALITY` | Face too small (`FACE_MIN_FACE_PX`) or blurred (`FACE_MIN_SHARPNESS`) | Retake |
| 422 | `FACE_IMAGE_INVALID` | face-service could not read the image | Retake |
| 422 | `FACE_PHOTOS_INCONSISTENT` | The three enrollment photos are not one person | Retake all three |
| 409 | `FACE_CONSENT_REQUIRED` | Enrolling a student who has not opted in | Ask the student to opt in |
| 409 | `FACE_MATCHES_ANOTHER_STUDENT` | The face is enrolled as someone else (named only in the audit log) | Check the ID card |
| 409 | `CONFLICT` | Session paused / closed / outside its window, or already recorded | — |
| 410 | `FACE_MATCH_EXPIRED` | Confirm after the token expired | Photograph again |
| 503 | `FACE_RECOGNITION_UNAVAILABLE` | face-service down or not configured | Use QR |

`NO_MATCH` and `AMBIGUOUS` are 200 results, not errors.

## Audit

`FACE_CONSENT_GIVEN`, `FACE_CONSENT_WITHDRAWN`, `FACE_ENROLLED`,
`FACE_ENROLLMENT_REJECTED`, `FACE_ENROLLMENT_REMOVED`,
`ATTENDANCE_FACE_NOT_MATCHED`, and `ATTENDANCE_RECORDED` with
`metadata.method = 'FACE'`. Scores are recorded, never templates or photos.

## Limits

`faceLimiter`, per lecturer: `FACE_RATE_LIMIT_PER_LECTURER` (1500) per
`CHECKIN_RATE_LIMIT_WINDOW_MS`. These routes skip the per-IP global limit, which
one phone checking in a whole class would exhaust. Body limits in `app.ts`:
450 KB for identify, 1300 KB for enrollment.

## Files

| File | Responsibility |
|---|---|
| `face.client.ts` | HTTP to face-service. Never throws |
| `face.match.ts` | Cosine similarity, best match, photo agreement. Pure |
| `face.token.ts` | Match tokens. Pure |
| `verification.schema.ts` | Zod request contracts |
| `verification.repository.ts` | All SQL; parameterised only |
| `verification.service.ts` | Consent, enrollment, identify, confirm |
| `verification.controller.ts` | HTTP in, HTTP out |
| `verification.routes.ts` | Router, auth guards, limits, validation |

Tables: `db/migrations/019_face_recognition.sql`, documented in
`docs/expected-schema.md`.
