# reporting module

**Status:** not implemented — placeholder.

Attendance summaries, filtering, CSV and PDF export, student progress.

Spec: README section 6 - Reporting module.

## Expected files

Follow the layout established by `src/modules/auth`:

| File | Responsibility |
|---|---|
| `reporting.schema.ts` | Zod request contracts; trims and normalises input |
| `reporting.repository.ts` | All SQL for this module; parameterised queries only |
| `reporting.service.ts` | Business rules; throws `AppError` for client-facing failures |
| `reporting.controller.ts` | HTTP in, HTTP out — no business logic |
| `reporting.routes.ts` | Router; applies `validate()` and any rate limits |
| `index.ts` | Public surface of the module |

Mount the router in `src/routes.ts` when the module goes live.
