# session module

**Status:** not implemented — placeholder.

Attendance sessions: create, open, pause, close, and issue signed QR tokens.

Spec: README section 6 - Attendance session module.

## Expected files

Follow the layout established by `src/modules/auth`:

| File | Responsibility |
|---|---|
| `session.schema.ts` | Zod request contracts; trims and normalises input |
| `session.repository.ts` | All SQL for this module; parameterised queries only |
| `session.service.ts` | Business rules; throws `AppError` for client-facing failures |
| `session.controller.ts` | HTTP in, HTTP out — no business logic |
| `session.routes.ts` | Router; applies `validate()` and any rate limits |
| `index.ts` | Public surface of the module |

Mount the router in `src/routes.ts` when the module goes live.
