# lecturer module

**Status:** not implemented — placeholder.

Lecturer profile management: view and update profile, list units taught.

Spec: README section 3.1 - Lecturer Features (profile).

## Expected files

Follow the layout established by `src/modules/auth`:

| File | Responsibility |
|---|---|
| `lecturer.schema.ts` | Zod request contracts; trims and normalises input |
| `lecturer.repository.ts` | All SQL for this module; parameterised queries only |
| `lecturer.service.ts` | Business rules; throws `AppError` for client-facing failures |
| `lecturer.controller.ts` | HTTP in, HTTP out — no business logic |
| `lecturer.routes.ts` | Router; applies `validate()` and any rate limits |
| `index.ts` | Public surface of the module |

Mount the router in `src/routes.ts` when the module goes live.
