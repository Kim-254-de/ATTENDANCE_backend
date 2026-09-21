# verification module

**Status:** not implemented — placeholder.

QR token validation plus biometric and facial verification.

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
