# Expected database schema

**This service does not create, migrate or own the schema.** It connects to a
database that already exists and queries it.

This document describes what those queries expect to find, so the database can
be checked against it. It is a contract, not a migration — nothing here is
executed by the application.

At boot, [`verifyDatabaseConnection()`](../src/db/database.ts) checks that the
four tables below exist and refuses to start if any is missing, so a mismatch
surfaces at startup rather than as a 500 on the first registration.

---

## Tables the lecturer registration flow touches

### `users`

One row per human — lecturers, students and admins share it, so credentials
and account status have a single home.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, server-generated |
| `email` | `varchar(255)` | **UNIQUE** — the registration race depends on this |
| `password_hash` | `varchar(255)` | Argon2id. Never plaintext |
| `full_name` | `varchar(160)` | |
| `role` | enum/text | `LECTURER` · `STUDENT` · `ADMIN` |
| `status` | enum/text | See below |
| `email_verified_at` | `timestamptz` null | |
| `failed_login_attempts` | `integer` | Defaults to 0; used by sign-in throttling |
| `locked_until` | `timestamptz` null | |
| `last_login_at` | `timestamptz` null | |
| `created_at` | `timestamptz` | Defaults to `NOW()` |
| `updated_at` | `timestamptz` | |
| `deleted_at` | `timestamptz` null | Soft delete — attendance history must outlive an account |

`status` values: `PENDING_VERIFICATION`, `PENDING_APPROVAL`, `ACTIVE`,
`SUSPENDED`, `DEACTIVATED`. Only `ACTIVE` may authenticate.

Whether `role` and `status` are Postgres enums or plain `text` with a check
constraint does not matter to this service — it sends and receives strings.

### `lecturer_profiles`

A row exists only once the ERP has confirmed the staff number, so its presence
is itself proof of verification.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | **UNIQUE**, FK → `users(id)` ON DELETE CASCADE |
| `staff_number` | `varchar(64)` | **UNIQUE** — stored uppercased |
| `title` | `varchar(32)` null | From the ERP |
| `department` | `varchar(160)` null | From the ERP |
| `faculty` | `varchar(160)` null | From the ERP |
| `phone` | `varchar(32)` null | Not set at registration |
| `erp_staff_id` | `varchar(128)` null | The ERP's own key, for reconciliation |
| `erp_verified_at` | `timestamptz` | Set to `NOW()` on insert |
| `erp_snapshot` | `jsonb` null | Verbatim ERP payload — evidence for disputes |
| `created_at` / `updated_at` | `timestamptz` | |

### `email_verification_tokens`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | FK → `users(id)` ON DELETE CASCADE |
| `token_hash` | `varchar(64)` | **UNIQUE** — SHA-256 hex. The plaintext token is never stored |
| `expires_at` | `timestamptz` | |
| `consumed_at` | `timestamptz` null | The `IS NULL` guard makes consumption atomic |
| `created_at` | `timestamptz` | |

### `audit_logs`

Append-only. A revoked registration writes here even though no user row is
created — that is what makes a rejection explainable afterwards.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `action` | enum/text | See `AuditAction` in [`src/db/types.ts`](../src/db/types.ts) |
| `outcome` | enum/text | `SUCCESS` · `FAILURE` |
| `user_id` | `uuid` null | FK → `users(id)` ON DELETE SET NULL. Null when no user existed |
| `subject_email` | `varchar(255)` null | Denormalised, so a rejection stays traceable |
| `subject_staff_number` | `varchar(64)` null | Likewise |
| `erp_outcome` | enum/text null | `VERIFIED` · `NOT_FOUND` · `INACTIVE` · `IDENTITY_MISMATCH` · `UNAVAILABLE` |
| `reason` | `varchar(255)` null | Truncated by the app before insert |
| `ip_address` | `varchar(64)` null | |
| `user_agent` | `varchar(512)` null | |
| `request_id` | `varchar(64)` null | Correlates with the API logs |
| `metadata` | `jsonb` null | |
| `created_at` | `timestamptz` | |

---

## Constraints the logic actually relies on

Two unique indexes are load-bearing, not merely tidy. The service checks for
duplicates before inserting, but that check cannot be atomic on its own — two
simultaneous registrations would both pass it. The insert then fails with
SQLSTATE `23505` and the service converts that to a 409. Without these indexes,
concurrent requests would create duplicate accounts:

- `users(email)` UNIQUE
- `lecturer_profiles(staff_number)` UNIQUE

Useful but not load-bearing: indexes on `users(role, status)`,
`email_verification_tokens(user_id)`, `audit_logs(action, created_at)` and
`audit_logs(subject_staff_number)`.

---

## Tables later modules will need

Not queried yet — listed so the database owner can plan: `student_profiles`,
`password_reset_tokens`, `units`, `unit_allocations`, `attendance_sessions`,
`attendance_records`.

---

## If the real schema differs

Column and table names live only in the SQL inside each module's
`*.repository.ts`. Adjust the queries there; nothing else in the codebase
refers to them. If names differ substantially, update
[`src/db/types.ts`](../src/db/types.ts) to match so the row types stay honest.
