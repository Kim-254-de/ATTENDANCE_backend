# quality-assurance module

Internal Quality Assurance (IQA): a standards catalog, checklist-driven
internal audits of a department, findings against each checklist
item, corrective action plans (CAPA) tracked to verified closure, and a KPI
dashboard that rolls findings up by standard/category and pulls in the
attendance-rate figures the rest of this system already captures. Every
list/report can be exported as PDF or CSV.

External Quality Assurance (EQA) — the national regulator/accreditor — gets
**no account in this phase**. EQA reviewers only ever see what IQA exports as
PDF; see "Not built" below.

## Scoping

Unlike `department`, this module is **not auto-scoped to the caller**: a QA
officer's remit is the whole institution (`qa_profiles` has no department
FK), so every list endpoint takes explicit `targetDepartmentId`/date-range
filters instead of
resolving one from the signed-in officer's own row.

## Sub-resources

- **Standards** (`standards.*`) — the catalog an audit is assessed against.
  No delete; deactivate via `isActive`.
- **Checklist templates** (`checklist.*`) — a named, ordered list of items,
  each item mapped to one standard. An item cannot be removed once any audit
  has recorded a finding against it (409).
- **Audits + findings** (`audit.*`) — one audit targets exactly one
  department (`qa_audits.target_department_id`, required; faculties play no
  part since `039_no_faculties.sql`), against one checklist template. Status is forward-only
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
scheduled_start_at)`, each session under the department that owns its unit. A department's QA-dashboard figure therefore reconciles
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
| `GET` | `/api/v1/quality-assurance/dashboard` | `?targetDepartmentId=&from=&to=&groupBy=week\|month` |
| `GET` | `/api/v1/quality-assurance/dashboard/export.{csv,pdf}` | Dashboard report |
| `GET` | `/api/v1/quality-assurance/departments` | `{id, name}[]` — every department, for the audit-target picker |
| `GET`/`PUT` | `/api/v1/quality-assurance/attendance-policy` | The minimum attendance to sit exams, and the at-risk margin; PUT is audited |
| `GET` | `/api/v1/quality-assurance/eligibility` | `?departmentId=&all=true` — exam eligibility, institution-wide unless narrowed |
| `GET`/`POST` | `/api/v1/quality-assurance/evaluations` | Student course evaluation rounds |
| `GET`/`PATCH`/`DELETE` | `/api/v1/quality-assurance/evaluations/:id` | One round; questions fixed (409) and DELETE refused (409) once anyone has answered |
| `POST` | `/api/v1/quality-assurance/evaluations/:id/close` | Ends the round now |
| `GET` | `/api/v1/quality-assurance/evaluations/:id/results` | `?departmentId=` |

Every route requires `requireAuth('QA')`.

## Exam eligibility

Each Senate sets its own minimum attendance to sit an exam: two-thirds at
some universities, 75% at others. So the minimum is one institution-wide
setting, `attendance_policy` (`db/migrations/034_attendance_policy.sql`),
rather than a constant. It defaults to 75% with a 10-point at-risk margin.
QA edits it, every signed-in user reads it at `GET /attendance-policy`, and
each change is audited as `ATTENDANCE_POLICY_UPDATED` with before and after.

Each active (student, unit) pair is judged separately against the classes
held so far: below the minimum is `NOT_ELIGIBLE`, below minimum + margin is
`AT_RISK`, anything higher is `ELIGIBLE`, and a unit with no classes yet is
`NOT_YET_MEASURED`. The comparison uses the unrounded ratio. Department
officers get the same report for their own department
(`/departments/eligibility`). The code is in
`src/modules/eligibility`.

## Course evaluations

QA opens a **round**: a title, a window (`opensAt`–`closesAt`), a minimum
number of responses, and questions that are either a 1–5 `RATING` or a free
`TEXT` comment. While a round is open, each student evaluates each unit they
are actively on, once (`GET`/`POST /students/me/evaluations...`). QA sees
every result. A department officer sees their department's, matched on the
department that owned the unit when the student answered
(`/departments/evaluations`).
Officers cannot see rounds that have not opened yet.

Anonymity is built into the schema (`db/migrations/035_qa_course_evaluations.sql`):

- `qa_evaluation_submissions` records only that a student evaluated a unit,
  which is what stops a second submission.
- The responses and answers have no student column and no timestamp, so
  they cannot be joined back to a submission by id or by time.
- Comments come back in alphabetical order, never in the order they were
  written.
- A unit's ratings and comments stay hidden until it has the round's
  `minResponses` responses (default 3). The scope-wide `overall` figures
  follow the same rule.

Once anyone has answered, a round's questions are fixed, because changing a
question would change what the earlier answers mean. Such a round can only
be closed, not deleted.

## Not built

No EQA account type — see "Scoping" above. No program/self-assessment reviews, accreditation tracker, document repository, or QA
committee meeting minutes: those are a later phase, deliberately left off
this one.

No self-registration for the QA role, the same reasoning as
`department`: there is no ERP record to verify an officer against.
For local work: `npm run dev:seed-qa` (also seeds a default standards catalog
and one default checklist template).
