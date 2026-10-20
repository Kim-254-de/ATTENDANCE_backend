# lecturer module

**Status:** built.

The signed-in lecturer's own data. Units (adding, SMARTTT sync, rosters) live
in the `unit` module; classes in `session`.

## Endpoints

All require a signed-in `LECTURER`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/lecturers/profile` | Profile from registration / SMARTTT: name, staff number, department, faculty |
| `GET` | `/api/v1/lecturers/overview` | Teaching summary: units taught, total students, average attendance, sessions held |
| `GET` | `/api/v1/lecturers/students` | Every student across the lecturer's units, with each one's per-unit attendance rate |

## Files

| File | Responsibility |
|---|---|
| `lecturer.repository.ts` | All SQL for this module; parameterised queries only |
| `lecturer.controller.ts` | HTTP in, HTTP out |
| `lecturer.routes.ts` | Router, mounted at `/lecturers` in `src/routes.ts` |
