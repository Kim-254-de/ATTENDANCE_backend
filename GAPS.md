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

### B-3 · High · Pass SMARTTT's venue groups through the admin console
- **Raised:** 2026-11-03, frontend (Wayler)   **Status:** open
- **Seen:** the Venues page (`ATTENDANCE_fronted/src/portals/admin/smarttt/VenuesPage.tsx:60`)
  can only switch "In the health unit" on or off, because a room has only `health_unit`. The
  proxy table in `src/modules/admin/admin.smarttt.ts:71-78` passes `/rooms` through and has
  no route for groups. SMARTTT is asked to add venue groups (SMARTTT_BACKEND `GAPS.md` B-3),
  and the Generator to use them (Timetable-Generator `GAPS.md` B-4).
  **Example to test against:** the university starts a new Bachelor of Engineering. Its papers
  (codes starting `BENG`) must be sat only in the engineering workshops, W1 and W2, and no
  other course's paper may be put in W1 or W2.
- **What we ask for:** once SMARTTT has the group endpoints, add them to the proxy table:
  `GET /admin/smarttt/rooms/groups` and `POST /admin/smarttt/rooms/groups`, with `group` passed
  through unchanged in the room list, `POST /admin/smarttt/rooms` and `PATCH /admin/smarttt/rooms/:id`.
  An unknown group is refused like any other SMARTTT validation error: 400, naming the field.
- **Why it matters:** the admin sets the groups on the Venues page; without these routes the
  page can't list or create them.
- **Done when:** the two routes answer through the console and an F- entry below gives their
  responses. We'll replace the "In the health unit" switch with a group picker and a "New
  group" action (that part is ours).

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
- **Raised:** 2026-10-25, backend   **Status:** done (ATTENDANCE_fronted df634d2, d9eac25)
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
- **Reply (2026-10-31, Wayler):** reviewed and kept df634d2. d9eac25 fixes what the review found: Open room
  now appears by itself when the slot starts, Close room asks in the app's dialog, the exam room uses the palette,
  and `GEOFENCE_ANCHOR_UNAVAILABLE` → "Open without the location check" has a test. `EXAM_MODE` on opening a class
  shows your message as it is.

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
- **Raised:** 2026-10-27, backend   **Status:** done (ATTENDANCE_fronted 680f1d0)
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

### F-4 · Medium · Remove the uploaded exam list as a whole; student numbers in the paper's Edit dialog
- **Raised:** 2026-10-28, backend   **Status:** done (backend 06f4194, ATTENDANCE_fronted ab79943)
- **What changed** (`/api/v1/departments/teaching`):
  - New `DELETE /exam-list?term=<id>`: removes every listed (uploaded) paper of the officer's department this term,
    with its class rows and invigilators; papers built from units stay. 409 while the papers are published (reopen
    first). Response: `{ "deleted": 104, "board": <exam board> }`. Audit `exam_list.delete`.
  - No new field for numbers: a listed paper's students are still its class rows (`PUT /exam-papers/:id/rows`),
    because the Generator sizes rooms and clashes by class row.
- **Frontend:** Exams tab has "Remove uploaded list" (confirm) beside the upload button; the paper Edit dialog has a
  "Number of students" section (the class-row editor, seeded with a guessed class for a paper nobody synced, e.g.
  MATH 241 → MATH Y2S1, so only the number is typed). Papers built from units show their total read-only.

### F-5 · Medium · Student numbers for many papers in one save
- **Raised:** 2026-10-29, backend   **Status:** done (backend ebe3c4d, ATTENDANCE_fronted b8f1298)
- **What changed** (`/api/v1/departments/teaching`):
  - New `PUT /exam-papers/rows?term=<id>`: `{ "papers": [{ "paperId": "<uuid>", "rows": [{ "programme": "MATH",
    "year": 2, "semester": 1, "stream": "", "students": 40 }] }] }` (1–1500 papers). Same rules per paper as
    `PUT /exam-papers/:id/rows`; all or none (one unknown or unit-built paper → 404/400, nothing saved). 409 when
    published. Response: the exam board.
- **Frontend:** Exams tab "Enter student numbers": every uploaded paper with one box (papers sat by one class, or
  nobody yet with a guessed class); a pasted column of numbers fills the boxes downward; papers with several
  classes stay under Numbers.

### F-6 · High · Uploaded papers' classes come from the master timetable
- **Raised:** 2026-11-04, backend   **Status:** done (frontend on the same branch name)
- **What changed:** a listed paper's `rows` now include every class taking its units on SMARTTT's master
  timetable, `smartttStudents: 0, students: 0, edited: false` until someone syncs. They reach the Generator and
  hold to its hard rules. A row with `edited: true, students: 0` is removed: it doesn't sit the paper.
  The review has `classRows` for those classes with `students: 0`, and `summary.noClasses` (no class and no synced
  student). A guessed class gives way to the real classes, passing them its number if they have none.
- **Why it matters:** clashes are avoided by course, even when nobody has synced.
- **Done when:** the upload review tells "classes on the timetable, no numbers" from "no class at all", and any
  class can be removed from a paper.

### F-7 · High · Venues edited in the admin console
- **Raised:** 2026-11-04, backend   **Status:** done (frontend on the same branch name)
- **What changed:** `GET /admin/smarttt/rooms` -> `{ rooms: [{ id, code, name, building, capacity, capacity_confirmed, room_type, status, for_exams, health_unit }] }`,
  `POST /admin/smarttt/rooms` and `PATCH /admin/smarttt/rooms/:id` (only the fields sent). SMARTTT validates; a code already used answers 400.
- **Why it matters:** venues and their exam use change without a file; the health unit's rooms are marked here.
- **Done when:** the Venues page has the table, an add form and the two switches.

### F-8 · High · One room under two codes
- **Raised:** 2026-11-04, backend   **Status:** done (frontend on the same branch name)
- **What changed:** `GET /admin/smarttt/rooms/duplicates` -> `{ groups: [{ keep, merge: [..], result: { capacity, capacity_confirmed, for_exams, health_unit } }] }`
  (each room `{ id, code, capacity, capacity_confirmed, for_exams, health_unit, slots }`; changes nothing),
  `POST /admin/smarttt/rooms/merge-duplicates`, and `POST /admin/smarttt/rooms/merge` `{ keep, merge: [ids] }` for rooms whose codes don't say they are one.
- **Why it matters:** a mark on one twin didn't reach the other, and two exams could be put in one physical room.
- **Done when:** the Venues page shows the groups with what merging does, and can merge chosen venues.

### F-9 · High · Only papers on a moderation letter reach the exam timetable
- **Raised:** 2026-11-04, backend   **Status:** done (frontend on the same branch name)
- **What changed:** removed `POST /departments/teaching/exam-papers`, `POST .../exam-papers/from-units`,
  `POST .../exam-papers/bulk` and `PUT .../units/:id/no-written-exam`; `PATCH` of an exam paper no longer takes `unitIds`
  (400). The exams board and the Generator's read return only letter papers; `problems` is only `no_exam_list`
  when a department has none. The health unit is revoked too: `health_unit` is still sent on venues but means nothing,
  and the Venues page no longer shows it.
- **Why it matters:** a department has to upload and publish its letter; a paper built from units no longer counts.
- **Done when:** the Exams tab has no way to add a paper by hand or from units, and asks for the letter instead.
- **Reply (2026-11-05, backend):** the user then asked for units to be typed in one by one as well. The Exams tab's "Add a unit" saves a paper through `POST /departments/teaching/exam-list` like a line of the letter, so it counts the same. Papers from Teaching units still don't.

### F-10 · High · A letter's headings give classes their numbers; uploading again overwrites
- **Raised:** 2026-11-05, backend   **Status:** done (frontend on the same branch name)
- **What changed:** `POST /departments/teaching/exam-list/read` also answers `classes` (`{ id, heading, name, year, semester, students, programme }`, year and semester null when nobody says, programme '' when no single SMARTTT programme has that name) and `programmes` (`{ code, name }`), and each entry has `letterClasses` (ids). `POST /departments/teaching/exam-list` takes `classes` on each paper: `[{ programme, year, semester, students }]`. Those numbers overwrite what the class had on the paper, a typed number too, and the class's other rows go to `students: 0, edited: true`. A class with no number in the letter is unchanged.
- **Why it matters:** the nursing letter gives each class's size in its heading; a second upload has to correct a first that read none.
- **Done when:** the upload review lists the letter's classes, lets a programme be chosen, and sends them on save.

### F-11 · High · A unit listed twice is its ODEL paper; a letter now listing a unit only as ODEL switches your regular paper
- **Raised:** 2026-11-06, backend   **Status:** done (frontend on the same branch name)
- **What changed:** `POST /departments/teaching/exam-list/read`: a unit listed a second time with nothing saying ODEL comes back as `sitting: 'odel'` with `secondListingOf: <line it repeats>` (null otherwise); a third listing is still `duplicateOf`. Not under a class heading ("BSc Nursing Y1S1 (107 students)"): there it is another class sitting the same paper. A title saying ODEL ("Gross Anatomy ODEL") also gives `sitting: 'odel'`. Each entry has `switchesPaperId`: your regular paper of the same codes that this ODEL line takes over, when the letter has no regular line for them and you have no ODEL paper of them. `summary` adds `secondListings` and `toOdel`.
  `POST /departments/teaching/exam-list` takes `replacesPaperId` on an ODEL paper: that regular paper becomes the ODEL paper (same id, examiner, invigilators and numbers; the letter's numbers still win). 422 if it isn't your listed regular paper of the same codes, or the same save also lists the codes as regular. The answer adds `switched` (not counted in `created` or `updated`).
  Example: `{ papers: [{ codes: ['BOTA 473'], title: 'Plant Biochemistry', sitting: 'odel', replacesPaperId: '<uuid>' }] }` -> `{ created: 0, updated: 0, switched: 1, ... }`.
- **Why it matters:** letters list a unit twice for its regular and ODEL papers, and the second was dropped as a duplicate; a letter re-issued as all ODEL added ODEL papers beside the old regular ones.
- **Done when:** the review shows "ODEL: second listing of line N" (and when its title differs), the switch with a tick to keep it, and sends `replacesPaperId`.

### F-12 · Low · The timetabling office renames itself and changes its password from the Generator
- **Raised:** 2026-11-12, backend   **Status:** open (nothing to build in this frontend; for information)
- **What changed:** two calls for the Timetable Generator (X-API-Key = GENERATOR_API_KEY), behind its new My profile page:
  `PATCH /integrations/generator/identity` `{ "account_id": "<uuid>", "full_name": "Dr. Dee Director" }` -> the same `{ account, timetabling_office }` as `GET .../identity`; 404 once the account is not the active timetabling office's. Audited as `OFFICER_NAME_CHANGED` (new audit action, metadata `{ via, before, after }`).
  `POST /integrations/generator/password` `{ "account_id": "<uuid>", "current_password": "…", "new_password": "…" }` -> `{ "changed": true }` or `{ "changed": false, "reason": "wrong_password" | "same_password" }`; 400 when the new one breaks the password rules. Audited as `PASSWORD_CHANGED` with `via: GENERATOR`, and the usual "password changed" email is sent.
- **Why it matters:** the admin console's Officers list now shows the name the Director chose, and the audit log can show `OFFICER_NAME_CHANGED`.
- **Done when:** the audit log screen names the new action (if it lists actions by name).
