# student module

**Status:** not implemented — placeholder.

Student registration and profile. Mirrors the lecturer flow but gated on registration number against the student records system.

Spec: README section 3.2.

## Expected files

Follow the layout established by `src/modules/auth`:

| File | Responsibility |
|---|---|
| `student.schema.ts` | Zod request contracts; trims and normalises input |
| `student.repository.ts` | All SQL for this module; parameterised queries only |
| `student.service.ts` | Business rules; throws `AppError` for client-facing failures |
| `student.controller.ts` | HTTP in, HTTP out — no business logic |
| `student.routes.ts` | Router; applies `validate()` and any rate limits |
| `index.ts` | Public surface of the module |

Mount the router in `src/routes.ts` when the module goes live.
