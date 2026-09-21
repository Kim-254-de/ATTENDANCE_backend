# attendance module

**Status:** not implemented — placeholder.

Check-in, attendance records, duplicate and window enforcement, auditable corrections.

Spec: README section 2 objectives 6-7.

## Expected files

Follow the layout established by `src/modules/auth`:

| File | Responsibility |
|---|---|
| `attendance.schema.ts` | Zod request contracts; trims and normalises input |
| `attendance.repository.ts` | All SQL for this module; parameterised queries only |
| `attendance.service.ts` | Business rules; throws `AppError` for client-facing failures |
| `attendance.controller.ts` | HTTP in, HTTP out — no business logic |
| `attendance.routes.ts` | Router; applies `validate()` and any rate limits |
| `index.ts` | Public surface of the module |

Mount the router in `src/routes.ts` when the module goes live.
