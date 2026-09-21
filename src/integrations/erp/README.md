# ERP integration

Registration for a lecturer is gated on the institutional ERP. **If the staff
number is not in the ERP, the registration is revoked** — no user row, no
profile, no token. Only an audit entry is written, so the rejection can be
explained later.

## Outcomes

| ERP result | HTTP | Error code | Account created? |
|---|---|---|---|
| Staff number found, active, identity matches | 201 | — | Yes |
| Staff number not in ERP | 403 | `ERP_STAFF_NOT_FOUND` | **No — revoked** |
| Found but retired/suspended | 403 | `ERP_STAFF_INACTIVE` | **No — revoked** |
| Found but name/email disagree | 403 | `ERP_IDENTITY_MISMATCH` | **No — revoked** |
| ERP unreachable, timing out, or 5xx | 503 | `ERP_UNAVAILABLE` | **No — refused** |

## The gate fails closed

An ERP outage returns 503 and creates nothing. The alternative — letting
registrations through when the directory is down — would turn every outage
into an open door. A lecturer blocked by a genuine outage retries in a minute;
an unverified account admitted during one may never be noticed.

Two cases are deliberately **not** treated as "staff number not found", because
reporting them that way would reject legitimate lecturers on a configuration
mistake:

- **401/403 from the ERP** — our own credentials are wrong. Logged as an error
  naming `ERP_API_KEY` / `ERP_AUTH_SCHEME`.
- **A 200 whose body cannot be mapped** — an integration fault, not evidence
  that the person does not exist.

## Files

| File | Role |
|---|---|
| `erp.types.ts` | The internal `ErpStaffRecord` shape and the `ErpProvider` interface |
| `erp.mapper.ts` | **The only file that knows the real ERP payload shape** |
| `erp.identity.ts` | Name and email matching against the ERP record |
| `erp.client.ts` | HTTP transport: auth, timeout, retry, caching |

## Wiring up the real ERP

Everything vendor-specific is either an environment variable or lives in
`erp.mapper.ts`.

1. Set the endpoint in `.env`:

   ```ini
   ERP_BASE_URL=https://erp.your-institution.ac.ke/api
   ERP_STAFF_LOOKUP_PATH=/v1/staff/{staffNumber}
   ERP_AUTH_SCHEME=bearer          # bearer | api-key | basic | none
   ERP_API_KEY=...
   ```

2. Open `erp.mapper.ts` and edit `erpStaffPayloadSchema` to the real field
   names, deleting the alternatives it currently accepts. Adjust
   `toStaffRecord()` if the mapping is not a straight rename.

3. If the ERP answers "not found" with something other than HTTP 404 — some
   return `200 {"found": false}` — handle it in `erp.client.ts` where the 404
   is checked, and return `'NOT_FOUND'`.

No other file needs to change.

## Caching

Successful lookups are cached in memory for `ERP_CACHE_TTL_SECONDS`.
`NOT_FOUND` is **never** cached: a lecturer added to the ERP this morning must
be able to register this morning.

The cache is per-process. With several instances behind a load balancer each
keeps its own; that is fine for a short TTL. Move it to Redis if the ERP starts
complaining about request volume.

## Identity matching

Controlled by `ERP_ENFORCE_IDENTITY_MATCH` (default on). This stops someone
registering with a colleague's staff number, which the ERP would otherwise
happily confirm as valid.

Matching tolerates honorifics (`Dr`, `Prof`), accents, punctuation, reordered
names and a dropped middle name, but requires at least two shared name tokens
so a common surname alone is not enough. Email is only compared when the ERP
holds one.

Turn the check off only if your ERP's name data is too inconsistent to match
reliably — and note that doing so removes the protection described above.
