# Smart Attendance System — Backend

REST API for the Smart Attendance System. Built for production use: validated
configuration, structured logging, an audit trail, and a registration flow
gated on the institutional ERP.

**Status:** lecturer registration is implemented. Every other module is a
documented placeholder.

---

## Lecturer sign-in

`POST /api/v1/auth/login` `{ "identifier": "<staff number or email>", "password": "..." }` (ported from Albert's
prototype, `origin/Albert`), plus `GET /auth/me`, `POST /auth/refresh`, `POST /auth/logout`.

| Result | Status | Notes |
|---|---|---|
| Signed in | 200 | httpOnly cookies `sa_access` (15m) and `sa_refresh` (7d, path `/api/v1/auth`); body is the lecturer |
| Wrong password **or** unknown account | 401 `INVALID_CREDENTIALS` | identical answer and comparable timing, so accounts cannot be enumerated |
| Correct password, account not ACTIVE | 403 `ACCOUNT_NOT_ACTIVE` | says why: unverified email / awaiting approval / suspended / deactivated. Only shown after a correct password |
| Too many failures | 429 `ACCOUNT_LOCKED` | `LOGIN_MAX_FAILED_ATTEMPTS` (5) wrong passwords lock the account for `LOGIN_LOCKOUT_MINUTES` (15); checked before the password. There is also a per-IP limiter |

Sessions live in `auth_sessions`. Every request re-checks the session and account status, so **sign-out, suspension
and detected token theft take effect immediately**. Refresh tokens rotate on every use; presenting an already-rotated one
revokes the whole session. Native clients may send `Authorization: Bearer <access token>` instead of cookies.

There is no administrator approval endpoint yet. Locally, after the lecturer has confirmed their email (the link is
printed in the API log in development), run `npm run dev:approve -- STF/0004` to activate them.

## Local development with the mock ERP

The real university ERP is not available yet, so `mock-erp/` stands in for it. It is a separate
service with its **own database** (`erp_mock`), exactly as the real ERP would be, and the API talks
to it over HTTP through `src/integrations/erp/`. Nothing in the API knows the ERP is a mock: to go
live, change `ERP_BASE_URL`, `ERP_STAFF_LOOKUP_PATH`, `ERP_AUTH_SCHEME`, `ERP_API_KEY` (and adjust
`erp.mapper.ts` if the payload differs).

```bash
cp .env.example .env               # then fill in secrets; ERP block below is for the mock
npm run db:up                      # Postgres in Docker (docker-compose.yml)
npm run db:migrate                 # creates the tables in db/migrations/ (the API never does this itself)

cd mock-erp && cp .env.example .env && npm install && npm start   # http://localhost:4100 (creates + seeds erp_mock)
cd .. && npm run dev                                               # http://localhost:4000
```

`.env` values that point the API at the mock ERP (the key must equal `ERP_API_KEY` in `mock-erp/.env`):

```ini
ERP_BASE_URL=http://localhost:4100/api/erp
ERP_STAFF_LOOKUP_PATH=/staff/{staffNumber}
ERP_AUTH_SCHEME=api-key
ERP_API_KEY=<same key as mock-erp/.env>
```

Sample staff for trying each outcome: `STF/0001` Peter Kamami (ERP holds an email, so the email must
match `peter.kamami@uni.ac.ke`), `STF/0002`-`0004` active, `STF/0005` left (rejected as inactive),
`STF/0006` suspended (rejected), any other number is rejected as not found. Students are in the same
service (`/api/erp/students/...`) for the student flow. Both are viewable and editable in the browser at
`http://localhost:4100/` (the mock ERP serves its own admin page; it asks for `ERP_API_KEY`).

## Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ (ESM) | Per the project spec |
| Language | TypeScript 5 (strict) | Typed DTOs, services and DB rows |
| Framework | Express 5 | Async errors handled natively |
| Database | PostgreSQL (existing) | **Not owned by this service** — it connects and queries |
| Driver | `pg` (node-postgres) | Parameterised SQL; no schema ownership, no migrations |
| Validation | Zod | One schema for parsing, typing and error messages |
| Passwords | Argon2id (`@node-rs/argon2`) | Prebuilt binaries — no C++ build toolchain |
| Logging | Pino | Structured JSON, redacted by default |
| Tests | Vitest + Supertest | Fast, native ESM |

---

## Quick start

```bash
# 1. Install Node.js 20 LTS first — see "Prerequisites" below.
npm install

# 2. Configure
cp .env.example .env
#    Then edit .env: at minimum DATABASE_URL, the two JWT secrets, and the ERP block.

# 3. Point DATABASE_URL at the existing database.
#    This service does NOT create or migrate the schema. It verifies at boot
#    that the tables it queries exist, and refuses to start if they do not.
#    See docs/expected-schema.md for what it expects to find.

# 4. Run
npm run dev          # http://localhost:4000
```

Verify it is up:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/health/ready   # also checks the database
```

### Prerequisites

Neither Node.js nor PostgreSQL is installed on this machine yet.

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen the terminal afterwards so `PATH` picks it up, then confirm
with `node -v` (expect v20 or newer).

You do not need Postgres installed locally unless the database you are
connecting to happens to run on this machine.

Generate the two JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## Project layout

```
src/
├── config/              Validated env + logger. Nothing starts without valid config.
│   ├── env.ts           Zod-checked environment; the process refuses to boot if it is wrong
│   └── logger.ts        Pino, with credentials and passwords redacted
├── common/
│   ├── errors/          AppError + stable error codes the mobile client branches on
│   ├── http/            The single success/error response envelope
│   └── utils/           Password hashing, opaque tokens, async handler
├── db/
│   ├── database.ts      Connection pool, query/transaction helpers, PG error codes
│   └── types.ts         Row and enum types — what the queries expect to find
├── middleware/
│   ├── request-context  Correlation id on every request
│   ├── validate         Zod validation that replaces req.body with parsed output
│   ├── rate-limit       Global / registration / sign-in buckets
│   └── error-handler    The only place an error becomes a response
├── integrations/
│   └── erp/             Institutional ERP client — see its own README
├── modules/
│   ├── auth/            Lecturer registration + email verification   [BUILT]
│   ├── audit/           Append-only audit trail                      [BUILT]
│   ├── notification/    Outbound email (no provider wired yet)       [STUB]
│   ├── lecturer/        Profile management                           [PLACEHOLDER]
│   ├── student/         Student registration                         [PLACEHOLDER]
│   ├── unit/            Units and allocations                        [PLACEHOLDER]
│   ├── session/         Sessions and QR issuance                     [PLACEHOLDER]
│   ├── attendance/      Check-in and records                         [PLACEHOLDER]
│   ├── verification/    QR / biometric / facial checks               [PLACEHOLDER]
│   └── reporting/       Summaries and exports                        [PLACEHOLDER]
├── routes.ts            Mounts module routers under /api/v1
├── app.ts               Express wiring (testable without a port)
└── server.ts            Boot, listen, graceful shutdown
```

Each module follows the same five-file shape — `schema` → `routes` →
`controller` → `service` → `repository`. Business rules live in the service;
controllers only translate HTTP. Each placeholder folder has a README naming
the files to add.

---

## Lecturer registration

`POST /api/v1/auth/lecturer/register`

```json
{
  "fullName": "Peter Kamau Mwangi",
  "email": "p.mwangi@university.ac.ke",
  "staffNumber": "KSU/LEC/014",
  "password": "a-strong-passphrase-1A",
  "confirmPassword": "a-strong-passphrase-1A"
}
```

### The flow

1. **Validate** — payload is parsed, trimmed and normalised. Email is
   lowercased and the staff number uppercased, so casing alone cannot create
   two accounts for one person. Unknown fields are rejected outright.
2. **Check for duplicates** — before spending an ERP call.
3. **Verify against the ERP** — **if the staff number is not in the ERP, the
   registration is revoked.** No user, no profile, no token; only an audit row
   explaining the rejection.
4. **Hash the password** with Argon2id and insert the account, profile and
   verification token in one transaction, with the audit entry committed
   alongside them.
5. **Email a verification link.** A delivery failure is logged, not thrown —
   it must not roll back a valid registration.

The account lands in `PENDING_VERIFICATION`. Confirming the email moves it to
`PENDING_APPROVAL` (or straight to `ACTIVE` if
`LECTURER_REQUIRES_ADMIN_APPROVAL=false`). Only an `ACTIVE` account can sign in.

### Responses

| Status | Code | Meaning |
|---|---|---|
| `201` | — | Verified and created; check email |
| `400` | `VALIDATION_FAILED` | Payload rejected |
| `403` | `ERP_STAFF_NOT_FOUND` | **Not in the ERP — revoked** |
| `403` | `ERP_STAFF_INACTIVE` | Retired or suspended — revoked |
| `403` | `ERP_IDENTITY_MISMATCH` | Details do not match the ERP record |
| `409` | `ACCOUNT_ALREADY_EXISTS` | Email or staff number already registered |
| `429` | `RATE_LIMITED` | Too many attempts |
| `503` | `ERP_UNAVAILABLE` | ERP unreachable — nothing created |

Success:

```json
{
  "success": true,
  "data": {
    "id": "…", "fullName": "…", "email": "…", "staffNumber": "…",
    "status": "PENDING_VERIFICATION", "nextStep": "VERIFY_EMAIL"
  }
}
```

Revoked:

```json
{
  "success": false,
  "error": {
    "code": "ERP_STAFF_NOT_FOUND",
    "message": "Registration was not completed. This staff number is not listed in the institutional staff records. Please contact the HR or ICT office."
  },
  "requestId": "…"
}
```

`POST /api/v1/auth/verify-email` takes `{ "token": "…" }` from the emailed link.

---

## Security decisions worth knowing

- **The ERP gate fails closed.** An unreachable ERP returns 503 and creates
  nothing. Admitting unverified lecturers during an outage would turn every
  outage into an open door.
- **A 401/403 from the ERP is never reported as "staff number not found".** Our
  own credentials being wrong must not silently reject legitimate lecturers, so
  it is logged as a configuration error and returns 503.
- **Duplicate registration returns one generic message** for both email and
  staff-number collisions. Naming the field would make the endpoint an oracle
  for enumerating staff numbers.
- **Identity is matched, not just the number.** A staff number alone is weak —
  colleagues know each other's. The ERP's name and email must agree with what
  was typed. Matching tolerates honorifics, accents, reordering and a dropped
  middle name, but needs two shared name tokens so a common surname is not
  enough.
- **Tokens are stored as SHA-256 hashes**, never in plaintext, so a database
  leak cannot be replayed to verify an address.
- **Token consumption is atomic** — the `consumed_at IS NULL` guard in the
  UPDATE means two requests carrying the same token cannot both succeed.
- **Every query is parameterised.** Values go through `$1, $2 …`; no value is
  ever interpolated into a SQL string.
- **Revoked registrations are audited** even though no user row exists. That is
  what lets an administrator later explain a rejection (README section 3.3).
- **Passwords never appear in logs** — Pino redacts them by path.

---

## Environment

Every variable is validated at boot by [`src/config/env.ts`](src/config/env.ts);
a missing or malformed value stops the process with a precise message rather
than failing mid-request. See [`.env.example`](.env.example) for the full list.

The ERP block is documented separately in
[`src/integrations/erp/README.md`](src/integrations/erp/README.md), including
how to point it at the real endpoint.

---

## Database

This service **connects to an existing database**. It does not create it,
migrate it, or own its schema — there is no migration tooling in this repo on
purpose.

[`docs/expected-schema.md`](docs/expected-schema.md) documents the tables and
columns the queries expect. At boot the service checks those tables exist and
refuses to start if any is missing, so a mismatch fails at startup rather than
mid-request.

Two unique indexes are load-bearing — `users(email)` and
`lecturer_profiles(staff_number)`. The duplicate check before insert cannot be
atomic on its own; the unique violation is what actually stops two concurrent
registrations creating two accounts.

All SQL lives in each module's `*.repository.ts`. If the real column names
differ, that is the only place to change.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch mode via tsx |
| `npm run build` / `npm start` | Compile to `dist/`, run compiled output |
| `npm run typecheck` | Types only, no emit |
| `npm run lint` | ESLint, zero warnings tolerated |
| `npm test` | Vitest |

---

## Next modules

In dependency order:

1. **Sign-in** — complete the auth module (account status checks, failed-attempt
   lockout, JWT issuance). The `users` table already carries
   `failed_login_attempts` and `locked_until`.
2. **Student registration** — mirrors this flow, gated on registration number.
3. **Units and allocations** — everything downstream depends on these.
4. **Sessions and QR issuance** — signed, short-lived tokens.
5. **Check-in and verification** — the duplicate/expiry rules the spec calls for.
6. **Reporting and exports.**
