# unit module

**Status:** not implemented — placeholder.

Units, academic periods, lecturer assignment and student allocation.

Spec: README section 6 - Unit and allocation module.

## Expected files

Follow the layout established by `src/modules/auth`:

| File | Responsibility |
|---|---|
| `unit.schema.ts` | Zod request contracts; trims and normalises input |
| `unit.repository.ts` | All SQL for this module; parameterised queries only |
| `unit.service.ts` | Business rules; throws `AppError` for client-facing failures |
| `unit.controller.ts` | HTTP in, HTTP out — no business logic |
| `unit.routes.ts` | Router; applies `validate()` and any rate limits |
| `index.ts` | Public surface of the module |

Mount the router in `src/routes.ts` when the module goes live.
