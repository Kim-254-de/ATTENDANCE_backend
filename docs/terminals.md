# Portable terminals: what a device does

The contract for the department-owned, wireless check-in terminals
(`docs/hardware-specs.md` section 6.2). Server side is built in
`src/modules/terminal/`. This replaces the shared-key routes in
`card-check-in.md` and `fingerprint-check-in.md` for new devices; those keep
working until every device is paired, then go.

---

## 1. Lifecycle

```
department officer                     device                         lecturer
------------------                     ------                         --------
POST /departments/terminals
  -> pairing code ABCDE-FGHJK  ------> POST /terminals/pair
     (QR + text, 30 min, once)           -> its own key (kept on device)

                                       POST /terminals/heartbeat      (every minute or so)

                                                                      GET /sessions/:id/terminal-link
                                       POST /terminals/link  <------  shows the code as a QR (5 min)
                                       POST /terminals/check-in       (each student)
                                       ...
                                       POST /terminals/unlink         (or the class closes)
```

Every device call except `pair` sends `X-Terminal-Key: <key>`. A `401`
means the key is not (or no longer) valid: the device was marked lost,
retired or re-paired. Show "Not paired: see your department" and stop.

---

## 2. Department officer (signed in as DEPARTMENT)

| Call | Does |
|---|---|
| `GET /departments/terminals` | The department's devices: status, battery, network, last seen, linked class |
| `POST /departments/terminals` `{ code, label?, capabilities }` | Adds a device. `code` like `TERM-01`, permanent, unique (upper-cased). `capabilities` from `BARCODE`, `CARD` (NFC), `FINGERPRINT`. Returns `{ terminal, pairingCode, expiresAt }` |
| `POST /departments/terminals/:id/pairing` | Fresh pairing code. **The old key stops working immediately**; use it to hand a device over or replace one |
| `PATCH /departments/terminals/:id` `{ label?, capabilities? }` | Rename or change readers |
| `POST /departments/terminals/:id/lost` | Cut the device off now. Re-pair it if found |
| `POST /departments/terminals/:id/retire` | Permanently out of use |

Another department's device is a `404`.

### Fingerprint enrolment

| Call | Does |
|---|---|
| `GET /departments/enrolment/students?q=&limit=` | Students on the department's lecturers' class lists, each with `fingerprints` (active, on this department's devices) and `pending` requests. `q` searches name or registration number |
| `POST /departments/terminals/:id/enrolments` `{ registrationNumber, label? }` | Queues an enrolment on a paired device with a fingerprint reader. A student with no account gets one from SMARTTT first. `201 { commandId, studentUserId }` |
| `POST /departments/enrolment/commands/:id/cancel` | Withdraws a request the device has not done yet |
| `DELETE /departments/enrolment/fingerprints/:id` | Stops the finger counting at once and queues its removal from the device |

## 3. Lecturer (signed in as LECTURER)

`GET /sessions/:sessionId/terminal-link` returns
`{ linkCode, expiresAt }` for their own running class. Show `linkCode` as a
QR code. It is valid for 5 minutes and can link several terminals.

## 4. Device

### Pair
`POST /terminals/pair` `{ "pairingCode": "ABCDE-FGHJK" }`, no key.
Dashes, spaces and case are ignored. Returns
`{ key, terminal: { code, label, capabilities }, session: null }`. **The key
is sent once; store it securely.** Limited to 20 attempts per 15 minutes per
address.

### Heartbeat
`POST /terminals/heartbeat` `{ batteryPercent?, network?: "WIFI" | "CELLULAR", appVersion? }`
Returns `{ terminal, session }`. `session` is the linked class
(`sessionId, unitCode, unitName, status, opensAt, closesAt, accepts`) or
`null`. A closed or finished class is dropped here automatically.
`accepts` lists which of the device's readers this class takes.

### Link
`POST /terminals/link` `{ "linkCode": "<scanned>" }`

| Status | Meaning |
|---|---|
| `200` | Linked; same body as heartbeat |
| `400` | Not a link code (or tampered with) |
| `410` | Code expired: ask the lecturer to show it again |
| `403` | Class is taught by another department's lecturer |
| `409` | Class has ended, or takes none of this device's readers |

### Check in
`POST /terminals/check-in` with exactly one of:

```json
{ "barcode": "SCT211-0001/2022" }
{ "cardUid": "04A3B2C1" }
{ "fingerRef": "37" }
```

No `sessionId`: the linked class is used. Answers are those of
`card-check-in.md` (barcode and NFC) and `fingerprint-check-in.md`, plus
`409` "not linked to a class" and `403` for a reader the device was not set up
with. Fingerprint slots are filed under the device's `code`, so enrol on the
same device that will read them.

### Commands (enrolment and removal)
The heartbeat's `pendingCommands` says when the department has queued work.

- `GET /terminals/commands`: pending requests, oldest first:
  `{ id, kind: "ENROL_FINGERPRINT" | "DELETE_FINGERPRINT", student: { fullName, registrationNumber }, fingerprintId, label, createdAt }`.
- **ENROL:** show the student's name, take the finger into a free slot, then
  `POST /terminals/commands/:id/complete` `{ "fingerRef": "<slot>" }`.
  The reply's `fingerprintId` **must be stored on the device against that
  slot**: a later DELETE names the `fingerprintId`, never the slot.
  `409` means the slot is already someone else's here, or the request was
  cancelled meanwhile: free the slot.
- **DELETE:** free the slot stored against `fingerprintId`, then
  `POST /terminals/commands/:id/complete` with no body.
- Could not do it (e.g. no usable finger): `POST /terminals/commands/:id/fail` `{ "reason": "..." }`.

### Unlink
`POST /terminals/unlink` when the lecturer hands the device back.

---

## 5. Notes

- **Rate limit** is per device (`TERMINAL_RATE_LIMIT_PER_DEVICE`, default
  600 per 5 minutes), not per address: many devices share campus Wi-Fi, and a
  device on 4G changes address.
- **Retry** as in `card-check-in.md`: on a timeout retry once and treat `409`
  "already recorded" as success.
- **No offline mode.** Without a connection the device must say so.
