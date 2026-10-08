# Face recognition check-in: plan and phases

Status as of **9 October 2026**. Backend: `ATTENDANCE_backend`. Lecturer and
student portal: `ATTENDANCE_fronted`.

| Phase | Area | Status |
|---|---|---|
| 1. Face service (Python) | `face-service/` | ✅ Done ([`face-service/README.md`](../face-service/README.md)) |
| 2. Enrollment, identify, confirm | Backend | ✅ Done ([`src/modules/verification/README.md`](../src/modules/verification/README.md)) |
| 3. Terminal, enrollment and consent screens | Frontend | ✅ Done (section below) |
| 4. Threshold tuning and hand-over docs | Both | 🟡 Tooling and docs done. **Calibrating with your own photos is still to do** (section below) |

---

## Decisions

| Question | Decision |
|---|---|
| Relationship to QR | **Both are always on**, in every class. Each is the other's fallback. A student is recorded **once** per session, by whichever method comes first; the second attempt gets *"Your attendance for this class has already been recorded."* (`UNIQUE (session_id, student_user_id)` on `attendance_records` already enforces this.) |
| Whose camera | **A terminal operated by the lecturer.** For now the terminal is the lecturer's phone, signed in to their own account. Students do not start a face check-in from their own app. |
| Recording | The terminal shows the match; the **lecturer taps Confirm** before anything is written. |
| Matching | 1:N, but only against the faces of students **allocated to the session's unit** (typically 50–200), never the whole school. |
| Engine | A small **Python service** (`face-service/`), called over HTTP by the Node API only. |
| Enrollment | **Captured on the lecturer's terminal** (option 1c): the lecturer picks the student from the unit's roster, checks their ID card, and takes three photos. |
| Consent | The student must **opt in from their own app** first. Face templates are sensitive personal data under Kenya's Data Protection Act, 2019. A student who never consents uses QR only. Withdrawing consent deletes their templates. |
| Geofence | **Not applied** to face check-ins. The terminal is in the room, in the lecturer's hand. |
| Liveness | **No automatic liveness check in v1.** The lecturer sees the student in person before confirming, which defeats a photo held up to the camera. |

---

## How it works

### Checking in by face

1. On the live session screen, the lecturer taps **Face check-in**. The phone's
   camera opens.
2. A student steps up. The terminal captures a frame and sends it to
   `POST /sessions/:id/face/identify`.
3. The API asks the face service for the frame's template, then compares it
   with the enrolled templates of the unit's ACTIVE students. It returns the
   best candidate (photo, name, registration number, score) and a short-lived
   signed **match token**. **Nothing is recorded.**
4. The lecturer checks the face against the person and taps **Confirm**
   (`POST /sessions/:id/face/confirm` with the match token), or **Not them** to
   retry.

The match token binds the session, the student, the score and an expiry
(~60 s). The confirm endpoint accepts only a student the server matched, so the
face endpoint cannot be used to mark an arbitrary student present.

Outcomes the terminal must handle:

| Outcome | What the lecturer sees |
|---|---|
| Match above threshold, clear margin over the runner-up | Candidate card with Confirm / Not them |
| No face, several faces, or poor quality | "Move closer / one person at a time", retry |
| No candidate above threshold | "Not recognised": retry, or the student scans the QR code |
| Two candidates too close to call | "Not sure", retry |
| Candidate already checked in | "Already recorded" (same rule as QR) |

### Enrolling a face

1. The student turns on **face check-in consent** in their app.
2. On the unit's student list, the lecturer taps **Register face**, checks the
   student's ID card, and captures three photos.
3. The API embeds each photo, rejects any with no face, several faces or low
   quality, checks the three agree with one another, and checks the face
   does **not** already match another enrolled student (which catches
   registering the wrong person).
4. The templates are stored against the student, not the unit, so one
   enrollment works for all their units.

Re-enrolling replaces the old templates and is audited. Photos are discarded
once embedded; only templates are stored.

---

## Phase 1: Face service (Python) ✅

`face-service/` in this repository, alongside `mock-erp/`.

- **FastAPI**, stateless: no database, no stored images.
- **Models:** OpenCV **YuNet** (detection) and **SFace** (128-d recognition
  embedding), from the OpenCV model zoo. Both are permissively licensed and run
  on CPU. InsightFace is more accurate but its pretrained weights are licensed
  for non-commercial use only, so it is not used.
- **Endpoint:** `POST /embed` with `{ image }` (base64 JPEG/PNG or data URL)
  returns `{ model, faceCount, face }`, where `face` is the **largest** face
  (the person at the terminal) with its box, detection score, sharpness and
  embedding. `faceCount` includes the queue behind them; the API decides
  whether a crowded frame is acceptable.
- **Auth:** a shared key in the `X-Face-Service-Key` header. Only the Node API
  calls it; it is never exposed to browsers.
- **Matching stays in Node.** The service only turns images into vectors. The
  API owns templates, rosters and thresholds, so the service can be swapped
  for another engine without a migration.
- `docker-compose.yml` gains a `face-service` container.

## Phase 2: Backend ✅

Builds out `src/modules/verification`.

**Migration `019_face_recognition.sql`**

- `face_enrollments`: student, embeddings, model version, enrolled by,
  timestamps. One per student.
- `users.face_consent_at`.
- `attendance_records`: `method` (`QR` / `FACE`, default `QR`), `face_score`,
  `confirmed_by_user_id`.

**Endpoints**

| Method | Path | Role | Purpose |
|---|---|---|---|
| `PUT` / `DELETE` | `/api/v1/students/me/face-consent` | Student | Give consent / withdraw it (deletes templates) |
| `GET` | `/api/v1/students/me/face` | Student | Consent and enrollment status |
| `POST` | `/api/v1/units/:unitId/students/:studentUserId/face` | Lecturer | Enroll from three photos |
| `DELETE` | `/api/v1/units/:unitId/students/:studentUserId/face` | Lecturer | Remove an enrollment |
| `POST` | `/api/v1/sessions/:id/face/identify` | Lecturer (owner) | Best candidate + match token. Writes nothing |
| `POST` | `/api/v1/sessions/:id/face/confirm` | Lecturer (owner) | Record attendance as `FACE` |

Rules: the session must be the lecturer's, open, and within its window; the
student must be ACTIVE on the unit; one record per student per session. Every
refusal is audited; identify and enroll are rate-limited and get their own
JSON size limit (like `/auth/me/avatar`).

**Configuration:** `FACE_SERVICE_URL`, `FACE_SERVICE_KEY`,
`FACE_MATCH_THRESHOLD`, `FACE_MATCH_MARGIN`, `FACE_MATCH_TOKEN_TTL_SECONDS`,
`FACE_MIN_FACE_PX`, `FACE_MIN_SHARPNESS`, `FACE_RATE_LIMIT_PER_LECTURER`. With
`FACE_SERVICE_URL` unset, face check-in is off (503) and QR is unaffected.

As built, also: the unit roster shows `faceConsent` / `faceEnrolled` per
student, and the attendance list shows each record's `method`. Error codes and
the full contract: the module README.

Tests use a fake engine behind the same interface, so they do not need the
Python service.

## Phase 3: Frontend ✅

In `ATTENDANCE_fronted`:

| Who | Where | What |
|---|---|---|
| Lecturer | Live session → **Face check-in** (`/session/:id/face`, `FaceTerminalPage.tsx`) | The terminal. Photograph a student, check the name, registration number and photo shown against the person, tap **Confirm** or **Not them**. A match must be confirmed within 60 s. Shows what to do for "not recognised", "not sure", already checked in, and unusable photos |
| Lecturer | Live session | Attendees checked in by face carry a **Face** badge |
| Lecturer | Units → a unit (`UnitStudentsPage.tsx`, `FaceEnrollDialog.tsx`) | Each student shows **Face registered** (Retake / Remove face), **Register face**, or **Face check-in off** (not consented). Registering takes three photos (straight, slightly left, slightly right); if the server rejects one, only that one is retaken |
| Lecturer | Activate Class | QR Code and Facial Recognition both shown as active |
| Student | Profile (`FaceCheckInCard.tsx`) | Off by default. Turning it on needs an explicit "I agree"; turning it off deletes their face data, after a confirmation |

The shared camera is `src/components/FaceCamera.tsx` (back camera by default,
switchable; photos are scaled to 720 px, ~100 KB). The mock API
(`src/mocks/handlers.ts`, `faceHandlers`) implements every face endpoint for
`VITE_USE_MOCKS=true` and the tests (`FaceCheckIn.test.tsx`).

## Phase 4: Tuning and hand-over 🟡

### What's done

- **Calibration tool:** `face-service/scripts/calibrate.py` runs labelled
  photos through the real models and the API's own matching rules, and
  recommends `FACE_MATCH_THRESHOLD` and `FACE_MATCH_MARGIN`. Its maths is in
  `face-service/app/calibration.py`, with tests.
- **Error codes and API contract:** in
  [`src/modules/verification/README.md`](../src/modules/verification/README.md).
- **Current values:** `FACE_MATCH_THRESHOLD=0.40`, `FACE_MATCH_MARGIN=0.05`.
  These are safe starting points (OpenCV publishes 0.363 for SFace, and the
  lecturer confirms every match) but have **not** been checked against your
  students, phones or rooms.

### What's left: calibrate with your own photos

No public face dataset could be downloaded from the development machine, and a
threshold is only as good as photos like the real ones. So:

1. **Collect photos, with consent.** At least **10 volunteers** (20+ is
   better, with a mix of skin tones, glasses, head coverings and ages like your
   students). For each, **8 photos** taken on the lecturers' own phones, in a
   real teaching room, at arm's length: 3 like enrollment (straight, slightly
   left, slightly right) and 5 like the terminal (different times, lighting,
   expressions). Each volunteer must agree in writing that their photos are
   used to tune the system and deleted afterwards.
2. **Lay them out** as one folder per volunteer:
   `photos/volunteer-01/01.jpg … 08.jpg`. The first three files by name are
   treated as the enrollment.
3. **Run:**
   ```bash
   cd face-service
   .venv/bin/python scripts/calibrate.py /path/to/photos --json results.json
   ```
   It prints, for each threshold, how many terminal photos are recognised,
   offered a **wrong name**, not recognised, or "not sure", and how many
   enrollments would be refused. It recommends the lowest threshold that
   offers no wrong names, refuses no enrollment, and stays 0.05 above the
   closest pair of different people.
4. **Apply** the recommended `FACE_MATCH_THRESHOLD` (and `FACE_MATCH_MARGIN`
   if you changed it) in the API's `.env`, restart it, and record the values
   and the date here.
5. **Delete the photos** and `results.json` (it holds scores, not images,
   but belongs with the photos).

If photos are often left out as "face too small" or "blurred", lower
`FACE_MIN_FACE_PX` or `FACE_MIN_SHARPNESS` in the API's `.env` and pass the
same values to the script by editing `MIN_FACE_PX` / `MIN_SHARPNESS` at its
top.

### Also left

- **Test fixtures:** `face-service/tests/fixtures` still uses OpenCV's sample
  images (`lena.jpg`, `messi5.jpg`). Replace them with two consenting team
  members' photos; the tests only need one face per image and two different
  people.

---

## Later (not in v1)

- Dedicated terminal devices with their own credentials instead of a
  lecturer's sign-in.
- Automatic liveness detection, if terminals run unattended.
