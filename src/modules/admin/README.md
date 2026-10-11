# admin module

The administrator's console, the top of the invitation chain:

```
administrator  ──invites──▶  administrators, faculty officers   (this module)
faculty officer ──invites──▶ department officers                (faculty module)
```

None of these accounts can be self-registered: there is nothing to verify an
officer against (no ERP staff record, no SMARTTT account), so whoever manages
them vouches for them by inviting them. An invitation creates the account at
once, scoped and `PENDING_VERIFICATION` with no usable password, and emails a
single-use link (`OFFICER_INVITE_TTL_HOURS`, default 72). Following it, the
invitee chooses their own password; nobody else ever sees or sets it. The
shared logic is `src/modules/auth/auth.invitation.ts`.

Everyone it invites signs in at the unlisted staff page, `/oversight`, which
the invitation email links to. The public role selector offers only students
and lecturers.

## The first administrator

Only an administrator can invite another, so the first comes from the command
line on the server (it sends the same email; it sets no password, so it is
safe in production):

```
npm run build && npm run admin:invite -- someone@university.ac.ke "Jane Wanjiru"
npm run dev:invite-admin -- someone@university.ac.ke "Jane Wanjiru"   # development
```

Without `RESEND_API_KEY` (development only) the link is printed instead.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/faculties` | Every faculty with department and officer counts |
| `POST` | `/api/v1/admin/faculties` | Creates a faculty; 409 when the name is taken |
| `GET` | `/api/v1/admin/officers` | Every administrator, faculty officer and department officer, with invitation status |
| `POST` | `/api/v1/admin/invitations` | `{ role: 'admin' }` or `{ role: 'faculty', facultyId }`, plus `fullName`, `email`; returns `{ userId, emailSent }` |
| `POST` | `/api/v1/admin/officers/:userId/resend` | Re-sends a pending invitation; the old link stops working |
| `POST` | `/api/v1/admin/officers/:userId/deactivate` | Removes access: DEACTIVATED, signed out, invitation withdrawn. Not oneself |

All are `ADMIN` only. Invitations are limited to `OFFICER_EMAIL_DOMAINS` when
it is set. Re-inviting a deactivated person (same role) re-opens their account.
Public counterparts: `POST /auth/invitations/lookup` and
`POST /auth/invitations/accept` (auth module).
