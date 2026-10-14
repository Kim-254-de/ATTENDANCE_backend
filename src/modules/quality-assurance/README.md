# quality-assurance module

Internal Quality Assurance (IQA): a standards catalog, checklist-driven
internal audits of a department or faculty, findings against each checklist
item, corrective action plans (CAPA) tracked to verified closure, and a KPI
dashboard that rolls findings up by standard/category and pulls in the
attendance-rate figures the rest of this system already captures. Every
list/report can be exported as PDF or CSV.

External Quality Assurance (EQA) — the national regulator/accreditor — gets
**no account in this phase**. EQA reviewers only ever see what IQA exports as
PDF; see "Not built" below.

## Scoping

Unlike `department`/`faculty`, this module is **not auto-scoped to the
caller**: a QA officer's remit is the whole institution (`qa_profiles` has no
department/faculty FK), so every list endpoint takes explicit
`targetDepartmentId`/`targetFacultyId`/date-range filters instead of
resolving one from the signed-in officer's own row.

## Sub-resources

- **Standards** (`standards.*`) — the catalog an audit is assessed against.
  No delete; deactivate via `isActive`.
- **Checklist templates** (`checklist.*`) — a named, ordered list of items,
  each item mapped to one standard. An item cannot be removed once any audit
  has recorded a finding against it (409).
- **Audits + findings** (`audit.*`) — one audit targets exactly one
  department *or* one faculty (`CHECK (num_nonnulls(...) = 1)` on
  `qa_audits`), against one checklist template. Status is forward-only
  (`PLANNED → IN_PROGRESS → COMPLETED`, `canTransitionAuditStatus` in
  `audit.service.ts`); `COMPLETED` is refused until every checklist item has
  a finding. Recording a finding (`PUT .../findings/:checklistItemId`) is a
  true upsert, backed by `qa_audit_findings`' `UNIQUE (audit_id,
  checklist_item_id)`.
- **Corrective actions / CAPA** (`capa.*`) — raised only against a
  `NON_COMPLIANT`/`PARTIAL` finding (400 otherwise). Status is forward-only
  (`OPEN → IN_PROGRESS → VERIFIED → CLOSED`, `canTransitionCapaStatus` in
  `capa.service.ts`); moving to `VERIFIED` stamps `verifiedByUserId`/
  `verifiedAt` from the authenticated caller — never from the request body —
  and that stamp is carried through, not overwritten, on the later
  `VERIFIED → CLOSED` move.
- **KPI dashboard** (`kpi.*`) — audit completion rate, compliance by
  standard/category, overdue CAPA count, and attendance-rate trend by
  department. The rating→score fallback (`COMPLIANT=100`, `PARTIAL=50`,
  `NON_COMPLIANT=0`, `NOT_APPLICABLE` excluded) and the averaging itself are
  plain functions in `kpi.service.ts` (`fallbackScoreFor`, `averageScore`),
  not SQL — unit-tested directly against synthetic finding arrays.
- **Exports** (`export.service.ts` / `export.controller.ts`) — CSV
  (hand-rolled, same convention as `reporting.service.ts`) and PDF (via
  `src/common/pdf/pdf-report.ts`'s shared cover page/footer) for every list
  above.

## Figures

The attendance-rate trend reuses `department.repository.ts`'s per-session
rate shape exactly (`attendance_records` ÷ `ACTIVE` `unit_allocations` per
session, averaged), widened from one officer's department to every
department or the filtered subset, bucketed by `date_trunc(groupBy,
scheduled_start_at)`. A department's QA-dashboard figure therefore reconciles
with what that department's own officer sees.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/api/v1/quality-assurance/standards[/:id]` | Standards catalog |
| `PATCH` | `/api/v1/quality-assurance/standards/:id` | Update, incl. `isActive` |
| `GET`/`POST` | `/api/v1/quality-assurance/checklist-templates[/:id]` | Checklist templates |
| `PATCH` | `/api/v1/quality-assurance/checklist-templates/:id` | Update template |
| `POST`/`PATCH`/`DELETE` | `/api/v1/quality-assurance/checklist-templates/:id/items[/:itemId]` | Manage items; DELETE 409s if findings exist |
| `GET`/`POST` | `/api/v1/quality-assurance/audits[/:id]` | Audits |
| `PATCH` | `/api/v1/quality-assurance/audits/:id` | Update fields / status transition |
| `GET` | `/api/v1/quality-assurance/audits/:id/checklist` | Items left-joined to existing findings — the "fill checklist" view |
| `GET` | `/api/v1/quality-assurance/audits/:id/findings` | Findings recorded so far |
| `PUT` | `/api/v1/quality-assurance/audits/:id/findings/:checklistItemId` | Upsert one finding |
| `GET` | `/api/v1/quality-assurance/audits/export.{csv,pdf}` | Audit register |
| `GET` | `/api/v1/quality-assurance/audits/:id/export.{csv,pdf}` | One audit's findings report |
| `GET`/`POST` | `/api/v1/quality-assurance/corrective-actions[/:id]` | CAPA |
| `PATCH` | `/api/v1/quality-assurance/corrective-actions/:id` | Update fields / status transition |
| `GET` | `/api/v1/quality-assurance/corrective-actions/export.{csv,pdf}` | CAPA register |
| `GET` | `/api/v1/quality-assurance/dashboard` | `?targetDepartmentId=&targetFacultyId=&from=&to=&groupBy=week\|month` |
| `GET` | `/api/v1/quality-assurance/dashboard/export.{csv,pdf}` | Dashboard report |

Every route requires `requireAuth('QA')`.

## Not built

No EQA account type — see "Scoping" above. No course evaluations, program/
self-assessment reviews, accreditation tracker, document repository, or QA
committee meeting minutes: those are a later phase, deliberately left off
this one.

No self-registration for the QA role, the same reasoning as
`department`/`faculty`: there is no ERP record to verify an officer against.
For local work: `npm run dev:seed-qa` (also seeds a default standards catalog
and one default checklist template).
