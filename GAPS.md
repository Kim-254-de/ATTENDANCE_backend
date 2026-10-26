# Gaps between frontend and backend

A two-way list between the frontend lead and the backend team. Each side adds what it finds;
neither side deletes the other's entries. How to use it is in `CLAUDE.md`.

Entry format:

```
### B-<n> · <High|Medium|Low> · <one-line title>
- **Raised:** <YYYY-MM-DD>, <who>   **Status:** open | in progress | done (<commit>) | won't do (<why>)
- **Seen:** what is missing or different, with file paths, endpoints, commits.
- **Why it matters:** which screen or user is affected.
- **Done when:** the check that closes it.
```

Use `B-` for items the backend should act on, and `F-` for items the frontend should act on.

---

## For the backend team (raised by the frontend)

### B-1 · Medium · Exam sessions for invigilators
- **Raised:** 2026-10-25, frontend (Wayler)   **Status:** done (04bf02d, 6a832da)
- **Seen:** `src/modules/teaching` now holds exam papers and invigilators, but
  `src/modules/session` has no exam session type. The plan (Timetable-Allocator `README.md` →
  "Exams: needs from SMARTTT and Smart Attendance") needs: one exam session per paper per
  room, opened by its invigilator; students check in only to their own paper and room; a
  sat/absent report per paper; and teaching classes refused while the term is in exam mode.
- **Why it matters:** the invigilator's screen (open the room, see who sat) and the student's
  exam check-in can't be built without it.
- **Done when:** the routes exist and their request/response shapes are added below under
  "For the frontend", including the error codes for "not your paper" and "not your room".
- **Reply (2026-10-25, backend):** Built in `src/modules/exam`; routes and shapes are in F-1.
  SMARTTT pushes the rooms and the term's mode, so nothing here is entered by hand.

### B-2 · Low · The XSRF cookie the frontend expects is never set
- **Raised:** 2026-10-25, frontend (Wayler)   **Status:** open
- **Seen:** `ATTENDANCE_fronted/src/lib/api.ts` is set up to echo an `XSRF-TOKEN` cookie as
  `X-XSRF-TOKEN`, but the API never sets that cookie or checks the header. CSRF protection
  rests on `SameSite=Lax` cookies and the same-origin `/api` proxy.
- **Why it matters:** half-done security config. A reviewer will assume CSRF tokens are in
  place when they aren't.
- **Done when:** either the API issues and checks the token, or this entry says Lax-only is
  the intended design, and the frontend removes the unused options (we'll do that part).

### Checked and fine (2026-10-25)
- Every route the frontend calls exists, including all of `/departments/teaching/*` and
  `/admin/smarttt/*`.
- The Generator ↔ Attendance link matches in both directions: `/integrations/generator/*` here
  and `/api/integrations/attendance/terms[/:id/times|/exam-draft]` on Generator `origin/main`.

---

## For the frontend team (raised by the backend)

<!-- Add F-<n> entries here: endpoints or fields added, renamed or removed; changed error codes,
     enums, auth or limits; anything a screen now shows wrongly; anything you noticed in the UI. -->

### F-1 · Medium · Exam rooms: invigilator routes, exam check-in, exam mode
- **Raised:** 2026-10-25, backend   **Status:** open
- **Seen:** new in `src/modules/exam` (commits 04bf02d, 6a832da). SMARTTT pushes one exam
  session per paper per room (who is seated there, its main or extra invigilator) and the
  term's mode. All under `/api/v1`, lecturer routes need a staff number:
  - `GET /exams/sessions/mine` (lecturer): the invigilator's rooms from today on, earliest first.
    ```json
    [{ "id": "uuid", "paperKey": "COSC 130|2026-11-23", "codes": "COSC 130", "title": "Programming",
       "startsAt": "2026-11-23T05:30:00.000Z", "endsAt": "2026-11-23T07:30:00.000Z", "room": "LH1",
       "role": "main", "candidates": 120, "status": "NOT_OPENED", "geofence": null }]
    ```
    `status`: `NOT_OPENED | OPEN | CLOSED`; `role`: `main | extra`.
  - `POST /exams/sessions/:id/open` (its invigilator) `{ "geofence": "ON", "location"?: {latitude, longitude, accuracy} }`
    or `{ "geofence": "OFF" }` → the session. Only from 30 min before the start until the end
    (403 otherwise). `422 GEOFENCE_ANCHOR_UNAVAILABLE` when the room isn't surveyed and the
    fix is too vague: offer to open with the fence off.
  - `GET /exams/sessions/:id/code` → `{ session, payload, expiresInSeconds, rotatesAt }`, as a class's QR. 409 if not open.
  - `POST /exams/sessions/:id/close` → the session with `status: "CLOSED"`.
  - `GET /exams/sessions/:id/report` → `{ paperKey, codes, title, rooms: [{ room, role, sat: [reg], absent: [reg] }] }`.
    The room's invigilator gets their room; the main invigilator gets every room of the paper.
  - Students scan exam codes with the usual `POST /attendance/check-in` (also `POST /exams/check-in`).
    201 → `{ recordId, sessionId, unitCode, recordedAt, examSessionId, codes, room, checkedIn: true }`.
    New error codes: `403 EXAM_WRONG_ROOM` ("You sit COSC 130 in LH1, not here.", `details.room`),
    `403 EXAM_NOT_CANDIDATE` (not listed for the paper); `409` "already been recorded" as for a class.
  - `POST /sessions` (open a class) now fails `403 EXAM_MODE` while the term is in exam mode.
- **Why it matters:** the invigilator's screen and student exam check-in.
- **Done when:** the lecturer portal has the exam rooms and the scanner handles exam codes.
  Already built on ATTENDANCE_fronted branch `exam-sessions` (df634d2): `/exams`,
  `/exam-room/:id`, and the scan page; review it rather than starting over.

### F-2 · High · The department uploads its exam list; numbers come from SMARTTT
- **Raised:** 2026-10-27, backend   **Status:** done (ATTENDANCE_fronted 0d92647)
- **What changed:** a department can upload the Word letter it sends for moderation instead of
  building papers from its units. Each paper's students are those who synced its units in SMARTTT,
  by class row; the department corrects any number. All under `/api/v1/departments/teaching`, DEPARTMENT role, `?term=`:
  - `POST /exam-list/read` `{ file: "<.docx as base64>" }` (body up to ~5 MB) → nothing stored, a review:
    `{ entries: [{ line, codes: ["COSC 0170","COSC 172"], title, section, sitting: "regular"|"odel", students: 110 | null,
    classRows: [{ label: "BSC.CS Y1S1", students: 100 }], unknownCodes: ["COSC 0170"], duplicateOf: 1 | null,
    otherDepartments: ["DCOMP"], existingPaperId: "<uuid>" | null,
    examiner: { lecturerId: "<uuid>" | null, staffNumber, name } | null }],
    smarttt: { available, reason }, summary: { papers, newPapers, duplicates, unknown, noStudents } }`.
    `students` null = SMARTTT couldn't be read (`smarttt.reason` says why). 422 for a file that isn't a .docx
    or has no unit codes.
  - `POST /exam-list` `{ papers: [{ codes: ["MATH 241"], title, sitting, examinerId?: uuid | null }] }` (max 1500)
    → `{ created, updated, smarttt, board }`. Same codes + sitting updates the existing paper (title), never duplicates.
    Omit `examinerId` to take SMARTTT's lecturer when they're on the department's list. 409 `TEACHING_TAKEN` when a
    code is already on one of the department's unit-built papers.
  - `PUT /exam-papers/:id/rows` `{ rows: [{ programme, year, semester, stream, students }] }` → the exam board.
    A number changed from SMARTTT's (or a row added) is kept when SMARTTT is read again; a SMARTTT row left out stays at 0.
  - `POST /exam-papers/recount` → the board, numbers re-read from SMARTTT (503 `SMARTTT_UNAVAILABLE` when it can't be).
  - Exam board papers have two new fields: `listed: boolean` and `rows: [{ id, programme, year, semester, stream,
    students, smartttStudents: number | null, edited }]` (empty for unit-built papers).
  - Publishing: a listed paper needs no examiner; it needs students (`no_students`: "Nobody has synced MATH 100 in
    SMARTTT yet; enter how many students sit it."). `no_units` now only when the department has neither units nor papers.
- **Why it matters:** departments stop entering units and courses for exams; this is the main exams flow now.
- **Done when:** the Exams tab has an "Upload exam list" button with the review (flags for duplicates, unknown codes,
  other departments, no students, SMARTTT unavailable), and a listed paper's rows are editable with SMARTTT's count shown.

### F-3 · High · Invigilators before the draft, one per extra room; papers with no students don't block
- **Raised:** 2026-10-27, backend   **Status:** open
- **What changed** (`/api/v1/departments/teaching`):
  - `GET /invigilators`: `canEdit` is now true before the Director shares a draft (the main invigilator can be
    named any time). Each paper has new fields `placed` (in the shared draft), `mainRoom` (string | null) and
    `extras: [{ room, invigilatorId, invigilator, invigilatorDepartment }]`; the paper's own `invigilator*` fields are
    the main invigilator. New problem codes `invigilator_clash` ("Jane Otieno is named for MATH 241 and COSC 130 at the
    same time (2026-12-01 08:30-10:30).") and `over_limit`; `no_invigilator` now says "Name the main invigilator for
    MATH 241." or "Name an invigilator for MATH 241 in LH2.".
  - `PUT /invigilators/:paperId` takes `{ lecturerId, room?: "" | "LH2" }`: `""` (default) is the main invigilator;
    an extra room only once it is in the shared draft (else 409). 409 when the person is already named for another
    room of the paper. Publishing still needs the shared draft.
  - `GET /exams` (exam board) has `warnings: [{ code: "no_students", message }]`: a listed paper nobody synced no
    longer blocks publishing (`problems` no longer has `no_students`); show it as a warning.
- **Why it matters:** departments name invigilators early; papers split over rooms could not be published before.
- **Done when:** the Invigilators tab works before the draft (main only) and shows extra rooms after; the Exams tab
  shows warnings without disabling Publish.
