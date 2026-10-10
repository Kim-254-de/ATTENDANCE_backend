# Signing in with a SMARTTT account

SMARTTT (the university timetable) is the system of record for people. A
student or lecturer cannot use attendance unless they have a SMARTTT account,
so attendance has no sign-up of its own for them: they sign in with the same
login and password they use for SMARTTT.

Department and faculty officers are not in SMARTTT. They keep attendance's own
accounts and passwords, unchanged.

## Switch

| Setting | Where | Meaning |
| --- | --- | --- |
| `SMARTTT_ACCOUNTS` (default `true`) | backend | On whenever `SMARTTT_BASE_URL` is also set. `false` brings back attendance's own registration and passwords (development without SMARTTT). |
| `SMARTTT_AUTHENTICATE_PATH` | backend | SMARTTT's sign-in check, default `/api/v1/integrations/attendance/authenticate/`. |
| `VITE_SMARTTT_ACCOUNTS` | frontend | Must match the backend. Hides sign-up, relabels the sign-in form, points password resets at SMARTTT. |
| `ATTENDANCE_API_KEY` | SMARTTT | Must equal attendance's `SMARTTT_API_KEY`. |

SMARTTT must be deployed with `apps/integrations` `attendance/authenticate/`.
Against an older SMARTTT, attendance logs an error and answers sign-ins with
503 `SMARTTT_UNAVAILABLE`.

## Sign-in flow

`POST /api/v1/auth/login` with `{ identifier, password }`:

1. The identifier finds an attendance account, if any. A department or faculty
   officer goes through the local password check as before. Anyone else
   (student, lecturer, or nobody yet) goes to SMARTTT.
2. A locked local account is refused (429) before SMARTTT is asked.
3. Attendance POSTs `{ identifier, password }` to SMARTTT with `X-API-Key`.
   SMARTTT looks the identifier up the same way its own login does (email,
   username or `university_id`, case-insensitive) and runs Django's
   `authenticate()`. A disabled account and a Google-only account (no
   password) are refused just as SMARTTT refuses them.
   - `{"authenticated": false}` → 401 `INVALID_CREDENTIALS`. If the
     identifier matched a local account, it counts towards that account's lock.
   - Network error, wrong key, unreadable answer → 503 `SMARTTT_UNAVAILABLE`.
     Nobody is let in on an unanswered check. Passkeys still work.
4. The SMARTTT account must be usable for attendance, or the sign-in is refused
   with 403 `SMARTTT_ACCOUNT_INCOMPLETE` and a message saying what to fix:
   - role is `student` or `lecturer`;
   - it has an admission number / staff ID (`university_id`);
   - a student is not marked as no longer current;
   - a lecturer's staff ID is still on SMARTTT's approved staff list.
5. The attendance account is found or created (`auth.smarttt.ts`):
   1. the account whose `users.smarttt_user_id` is this SMARTTT id;
   2. else the student/lecturer with the same registration or staff number —
      someone who registered here before this change keeps their history,
      and their old attendance password stops working;
   3. else a new ACTIVE account, with an unusable random password hash. A
      new student is put on every class list already naming their number.
6. On every sign-in SMARTTT's name, email, number and student/staff details
   are copied onto the account. A pending account becomes ACTIVE; a suspended
   or deactivated one stays as the administrator left it (403).

Conflicts that need an administrator are 409 `SMARTTT_ACCOUNT_CONFLICT`: the
number is already linked to a different SMARTTT account, the role differs, a
changed number is held by another account, or a new account's email is
already taken. An email clash on an existing account only keeps the old email.

Audit actions: `SMARTTT_ACCOUNT_CREATED`, `SMARTTT_ACCOUNT_LINKED`,
`SMARTTT_ACCOUNT_REFUSED`.

## What is closed

With SMARTTT accounts on:

- `POST /auth/student/register`, `POST /auth/lecturer/register` → 410
  `ACCOUNTS_MANAGED_BY_SMARTTT`.
- `POST /auth/change-password` → 409 `ACCOUNTS_MANAGED_BY_SMARTTT`.
- `POST /auth/forgot-password` for a student or lecturer sends nothing (the
  reply is the usual generic one); a reset link sent before the switch is
  refused with 409.

## Schema

`db/migrations/025_smarttt_accounts.sql` adds `users.smarttt_user_id` with a
partial unique index.

## Tests

- attendance: `tests/integration/smarttt-accounts.test.ts` (SMARTTT stubbed at `fetch`).
- SMARTTT: `apps/integrations/tests/test_attendance_authenticate.py`.
