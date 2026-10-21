# admin module

The platform's one admin console. SMARTTT and attendance used to have an
administrator each (SMARTTT's "SMART ClassCatch Admin" page and this portal);
now there is one administrator, one account and one console:

- **Who.** An administrator is a SMARTTT administrator: an active SMARTTT staff
  account (`is_staff`) that is not a student's or lecturer's. They sign in
  here with their SMARTTT login (`auth.smarttt.ts signInAdministrator`), like
  students and lecturers. Their attendance account is created on first
  sign-in, or linked by email to an administrator invited here before.
  Administrators are no longer invited here: `POST /admin/invitations` with
  `role: 'admin'`, re-sending an administrator's invitation, and
  `BOOTSTRAP_ADMIN_EMAIL` / `npm run admin:invite` are refused or skipped
  (409 `ACCOUNTS_MANAGED_BY_SMARTTT`) while SMARTTT accounts are on. Give the
  person staff status in SMARTTT instead.
- **What.** Attendance's own functions (below) plus SMARTTT's admin functions
  (`admin.smarttt.ts`), which SMARTTT still runs: the console calls SMARTTT's
  `integrations/admin/` endpoints with the shared key and the administrator's
  SMARTTT id (`X-Acting-Account`); SMARTTT re-checks on every call that they
  are still an administrator and keeps its own permission checks and records.
- **Faculties and departments** belong to SMARTTT (`src/modules/directory`):
  created there first, read back into attendance's linked copy.

With SMARTTT accounts off (`SMARTTT_ACCOUNTS=false` or no `SMARTTT_BASE_URL`,
development), administrators are invited here as before:

```
administrator  ──invites──▶  administrators, faculty officers   (this module)
faculty officer ──invites──▶ department officers                (faculty module)
```

Faculty and department officers are not in SMARTTT, so they are always
invited here. An invitation creates the account at once, scoped and
`PENDING_VERIFICATION` with no usable password, and emails a single-use link
(`OFFICER_INVITE_TTL_HOURS`, default 72); the invitee chooses their own
password. The shared logic is `src/modules/auth/auth.invitation.ts`. Officers
sign in at the unlisted staff page, `/oversight`.

### The first administrator without SMARTTT

`npm run admin:invite -- someone@university.ac.ke "Jane Wanjiru"` (or
`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_NAME` on a host with no shell; it
logs `bootstrap admin:` and does nothing once an administrator is ACTIVE).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/faculties` | Every faculty with department and officer counts |
| `POST` | `/api/v1/admin/faculties` | Creates a faculty (in SMARTTT first); 409 when the name is taken |
| `GET` | `/api/v1/admin/officers` | Every administrator, faculty officer and department officer, with invitation status |
| `POST` | `/api/v1/admin/invitations` | `{ role: 'admin' }` or `{ role: 'faculty', facultyId }`, plus `fullName`, `email`; returns `{ userId, emailSent }` |
| `POST` | `/api/v1/admin/officers/:userId/resend` | Re-sends a pending invitation; the old link stops working |
| `POST` | `/api/v1/admin/officers/:userId/deactivate` | Removes access: DEACTIVATED, signed out, invitation withdrawn. Not oneself |
| `GET` | `/api/v1/admin/units/pending` | Units still `PENDING_VERIFICATION` (the timetable doesn't list their lecturer), oldest first, with lecturer and weekly slots |
| `POST` | `/api/v1/admin/units/:unitId/verify` | Confirms the lecturer-unit assignment: `VERIFIED`, audited as `UNIT_VERIFIED`. 404 unknown, 409 already verified |

| `GET` | `/api/v1/admin/departments` | Every department with its faculty and staff count, for placing a lecturer |
| `GET` | `/api/v1/admin/lecturers` | `?q=&unassigned=true` — lecturers, unassigned ones first, with the department SMARTTT reported |
| `PATCH` | `/api/v1/admin/lecturers/:lecturerUserId/department` | `{ departmentId }` — places or moves a lecturer in any department, across faculties too; audited |
| `GET` | `/api/v1/admin/department-duplicates` | Groups of departments whose names mean the same thing, busiest first |
| `POST` | `/api/v1/admin/departments/:departmentId/merge` | `{ intoDepartmentId }` — folds the duplicate into the one kept; audited, cannot be undone |
| `GET` | `/api/v1/admin/department-aliases` | Spellings learned from placements and merges |
| `DELETE` | `/api/v1/admin/department-aliases/:aliasId` | Removes a wrongly learned spelling; audited |
| `GET` | `/api/v1/admin/directory` | `{ smartttConnected, onlyHere: { faculties, departments } }`: faculties and departments not yet in SMARTTT |
| `POST` | `/api/v1/admin/directory/sync` | Reads SMARTTT's faculties and departments now, then sends the ones only here to SMARTTT (`{ fromSmarttt, toSmarttt }`, with what was skipped and why). 503 when SMARTTT can't be reached |

`GET /admin/faculties` reads SMARTTT's faculties into the copy first (at most
every `SMARTTT_DIRECTORY_SYNC_SECONDS`) and marks each `inSmarttt`;
`POST /admin/faculties` creates the faculty in SMARTTT, then here.

### SMARTTT's admin functions (`/api/v1/admin/smarttt/...`)

| Method | Path | SMARTTT |
|---|---|---|
| `GET` / `POST` | `/terms` | Academic terms; create one |
| `PATCH` / `DELETE` | `/terms/:id` | Edit or delete a term |
| `POST` | `/terms/:id/set-current` | Make it the current term |
| `DELETE` | `/terms/:id/slots` | Clear a term's timetable slots |
| `GET` / `POST` | `/timetable/uploads` | Upload history; upload the master timetable (multipart, `file` + SMARTTT's fields) |
| `GET` | `/timetable/uploads/:id/status` | An upload's progress |
| `DELETE` | `/timetable/uploads/:id` | Delete an upload |
| `GET` / `POST` | `/lecturer-allocation` | The departments' allocation documents; upload one (multipart) or re-apply (JSON) |
| `DELETE` | `/lecturer-allocation?source=<department>` | Remove a department's allocation document and the lecturers it set |
| `GET` / `POST` | `/notifications` | Notification history; send one |
| `GET` / `POST` | `/staff-ids` | The approved staff-ID list; upload a CSV |
| `DELETE` | `/staff-ids/:id` | Remove a staff ID |
| `GET` | `/staff-id-uploads`, `DELETE` `/staff-id-uploads/:id` | Staff-ID upload history |
| `GET` / `POST` | `/rooms/capacities` | Venue capacity summary; upload capacities |
| `GET` | `/programs` | Programmes (a notification's audience) |

Answers come back in this API's envelope; what SMARTTT refused, with its
message. `403 NOT_SMARTTT_ADMIN`: SMARTTT no longer counts the person as an
administrator. `403 SMARTTT_LINK_REQUIRED`: the session predates SMARTTT
sign-in; sign in again. `502 SMARTTT_MISCONFIGURED`: the shared keys differ.
`503 SMARTTT_UNAVAILABLE`: SMARTTT is down or too old. Every change is
audited here as `SMARTTT_ADMIN_ACTION`.

All are `ADMIN` only. Invitations are limited to `OFFICER_EMAIL_DOMAINS` when
it is set. Re-inviting a deactivated person (same role) re-opens their account.
Public counterparts: `POST /auth/invitations/lookup` and
`POST /auth/invitations/accept` (auth module).

## Placing lecturers

A lecturer whose SMARTTT department name matches no department signs in
unassigned and counts toward no department. A faculty officer can place them
in one of its own departments. An administrator can place or move anyone,
including across faculties, which no faculty officer can do. The rules are in
`src/modules/faculty/README.md` ("Placing lecturers"), and the shared code is
`src/modules/lecturer/lecturer.placement.ts`.

## One department, one spelling

SMARTTT names departments in free text. `db/migrations/036_department_spelling.sql`
makes every spelling of a department resolve to the same one:

- `department_key()` reduces a name to a canonical form. It lower-cases,
  joins dotted initials, drops punctuation, reads `&` as "and", removes a
  leading "Department of", and expands common abbreviations, so
  "Dept. of Comp. Sci & IT" and "Computer Science and Information Technology"
  are the same name.
- `department_aliases` holds spellings learned when an unassigned lecturer is
  placed, plus the old names of merged departments.
- `merge_departments()` folds a duplicate into the department kept: lecturers,
  officers, course offerings, units, QA audits and evaluation results all
  move, and the duplicate is deleted. If the duplicate's name differs from
  the kept one even after normalising, it is kept as an alias.
  `DEPARTMENTS_MERGED` records both names.

The administrator's Departments page lists duplicates to merge and the
learned spellings.
