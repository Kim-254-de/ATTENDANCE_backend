# verification module

**Status:** not implemented — placeholder.

How a student proves they are the one present. Four methods are in scope, and
a lecturer ticks any combination when activating a class
(`verificationMethods` on `POST /sessions`). A check-in by a method the class
did not enable is refused with a 409.

| Method | Status |
|---|---|
| Rotating QR code | **Built** — `src/modules/session/session.token.ts`, `POST /attendance/check-in`, and `docs/student-app-checkin.md` |
| Student ID card swipe | **Built** — `POST /attendance/card-check-in`, `src/modules/attendance/card.repository.ts`, `docs/card-check-in.md`. Only the hardware is outstanding: a terminal has to read a card and post its UID |
| Fingerprint | Not implemented |
| Facial recognition | Not implemented |

Both built methods live in `session` and `attendance` rather than here, because
the rules that decide whether a check-in counts are the same whichever way it
arrives and belong in one place: `sessionService.verifyScan` and
`sessionService.verifyCardSwipe`. This folder stays empty until a method needs
state of its own — a face template or a fingerprint minutiae record would.

`FINGERPRINT` and `FACE` are accepted in a session's method list so the
lecturer's interface can offer all four, but the schema refuses a class that
enables *only* those: nobody could check in to it.

Spec: README section 6 - Verification module.

## Expected files

Follow the layout established by `src/modules/auth`:

| File | Responsibility |
|---|---|
| `verification.schema.ts` | Zod request contracts; trims and normalises input |
| `verification.repository.ts` | All SQL for this module; parameterised queries only |
| `verification.service.ts` | Business rules; throws `AppError` for client-facing failures |
| `verification.controller.ts` | HTTP in, HTTP out — no business logic |
| `verification.routes.ts` | Router; applies `validate()` and any rate limits |
| `index.ts` | Public surface of the module |

Mount the router in `src/routes.ts` when the module goes live.
