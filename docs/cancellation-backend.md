# OA request existence and cancellation backend

Implementation/testing uses sanitized offline fixtures only. No remote booking, retract, or delete was performed. No API routes/frontend are owned by this module.

## Wiring contract

`server/src/cancellation.js` exports:

- `configureCancellationService(dependencies)` once at server startup.
- `cancelApplication(trustedTask)` → `{ ok, state: 'cancelled'|'unknown'|'ineligible', requestId, message, stage, replayBlocked? }`.
- `createCancellationService(dependencies)` → reusable `.cancelApplication(trustedTask)`; optional second dependencies argument to the named function is also supported for isolated tests.

The route must require explicit confirmation and obtain `trustedTask` through a fresh own-portal list lookup by exact `id`; never construct it from client-provided ownership or requestId. Main owns routing and `server/src/portal.js` owns portal authentication/listing.

Required dependencies:

```js
configureCancellationService({
  listPendingApplications, // async own portal list, not local booking history
  getOwnApplicantId,       // async authenticated OA userid from trusted session/profile
})
```

The normalized own pending rows must have `{ id, requestId, title, status: 'pending' }`, with title prefix `学生和教工场馆借用申请-`. The portal provider must verify initiatorId against its authenticated userAccount; student number is not an OA numeric userid. Do not fabricate applicantId/workflowId on portal rows: the subsequent live OA read verifies those authoritatively. `getOwnApplicantId` may obtain fields.field31876 via the existing readonly `fetchFormFields()` helper. Neither a client title prefix nor client `f_weaver_belongto_userid` authenticates ownership. `taskId` is accepted as an internal row alias. The module rechecks the list even if the route already checked it.

Tests inject `transport`, `journal`, and `persist`. Production transport authenticates via existing `ensureSession()`, uses manual redirects/timeouts, and never retries. Do not wrap injected transport in retry middleware.

## Submission existence

`server/src/oa-request.js` verifies requestId extracted only from actual submit response navigation/View/WorkflowDirection, not a guessed/latest task or the availability tree. `submitBooking()` GETs ViewRequest and bounded same-request readonly wrapper/iframe pages. Success requires actual request/workflow/applicant and venue/date/slot/site controls matching the submitted payload. Arbitrary 200 scaffolds and literal success alerts without verified existence are unknown. Explicit submission failure wins even if a draft exists. Approval remains separate/unknown.

Unknown HTML layouts, display-only fields without machine identity, unsupported dynamic frame URLs, auth/error/deleted pages, and mismatched identity are not evidence of existence. This conservative implementation may return unknown on an unrecognized genuine request. No live OA fixture was fetched for this implementation.

## Cancellation sequence

1. Server pending-task authorization and authenticated own userid.
2. Fresh ViewRequest + readonly frames: known venue workflow family `14862` / `43364` (and form `-248` when present), own applicant and venue identity. The fresh edit/delete form must preserve the exact live workflow version. The fresh own portal RUNNING status establishes pending; the OA title can instead be `提交校园服务中心审核`. Require a native retract onclick action without standard HTML disabled, no live completed/archive indication, and exact native retract target carrying `flag=rb`, explicit requestId and own identity context. Merely seeing a CSS/custom disabled marker is not a permission decision.
3. Persist unknown intent **before** a single state-changing GET to `/workflow/workflow/wfFunctionManageLink.jsp`. Never prefetch or retry.
4. Follow only bounded same-request allowlisted request pages. Require a fresh native editable POST form targeting RequestOperation.jsp, own applicant/workflow/request identity, creator node type, and native delete handler evidence. Serialize successful controls including duplicate fields, textarea content, checked controls and selected options. Force one `src=delete`; send one POST, no retry.
5. Fresh ViewRequest must show the visible exact Chinese marker `对不起，该流程已经被删除！请返回或者进入不同的页面`, or redirect to same-origin `/notice/Deleted.jsp?showtype=wf` followed by GET with that visible marker. A 302 alone, deletion alert, retract success, or missing tree entry is insufficient.

A stale own pending portal row whose initial ViewRequest already meets deletion proof returns confirmed cancelled without mutation and reconciles local history. Ownership in that case necessarily relies on the trusted own portal identity because a deleted page no longer exposes applicant fields.

Unknown outcomes record the stage, block blind replay, and require manual/read-only reconciliation. `server/data/cancellation-attempts.json` durably records intent/results; a process-wide request mutex blocks concurrent calls. The journal is single-process, not a distributed lock; do not run multiple mutation workers without a shared transactional lock. There is deliberately no public journal reset/retry endpoint. Journal/local persistence failures are fail-closed or unknown, with no raw exception/payload/cookie exposed.

Local bookings retain history plus `cancellation: { state, step, requestId, at, ... }`. Only confirmed `cancelled` records are excluded from the local quota hint. This is **not** evidence that OA frees daily quota, releases a court, or cancels any independent venue business record. No tree query is used in the cancellation decision.

Readonly navigation includes `/workflow/request/ViewRequestIframe.jsp` with the same strict request parameter allowlist as ViewRequest; arbitrary iframe URLs remain forbidden. Visible deletion markers tolerate whitespace inserted by HTML layout.

The form parser deliberately excludes disabled fieldsets entirely (including their first legend), file controls, and unclicked buttons; unrecognized form variants fail closed. Native permission handling and OA business effects have not been live-tested. Unknowns must not trigger automatic fallback mutations.
