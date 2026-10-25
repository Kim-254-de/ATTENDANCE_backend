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
- **Raised:** 2026-10-25, frontend (Wayler)   **Status:** open
- **Seen:** `src/modules/teaching` now holds exam papers and invigilators, but
  `src/modules/session` has no exam session type. The plan (Timetable-Allocator `README.md` →
  "Exams: needs from SMARTTT and Smart Attendance") needs: one exam session per paper per
  room, opened by its invigilator; students check in only to their own paper and room; a
  sat/absent report per paper; and teaching classes refused while the term is in exam mode.
- **Why it matters:** the invigilator's screen (open the room, see who sat) and the student's
  exam check-in can't be built without it.
- **Done when:** the routes exist and their request/response shapes are added below under
  "For the frontend", including the error codes for "not your paper" and "not your room".

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

_Nothing yet._
