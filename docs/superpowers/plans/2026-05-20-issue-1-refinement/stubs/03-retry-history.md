## Purpose

Decide the column shapes that link related job attempts (retries, reschedules, singleton supersession) into a reconstructable history. This enables `getRetryHistory(jobId)` to walk the chain across pg-boss's DELETE+INSERT retry path.

## Parent

Sub-issue of #1 (Goal 3 — Retry history tracking).

## Decisions to make

- **Link columns.** Names, types, nullability. Candidates:
  - `parent_attempt_id` UUID — immediately previous attempt, NULL for first
  - `root_job_id` UUID — original job in the chain, self-referential for first
  - `superseded_by_job_id` UUID — set on the older row when singleton supersession occurs
- **Population rules.** When pg-boss retries, pg-bossier's capture hook must read the previous row and set `parent_attempt_id` / inherit `root_job_id`. Confirm the hook timing (pre-INSERT vs post-INSERT trigger semantics; or app-side wrap).
- **Supersession semantics.** When a singleton job is replaced, what happens to the older row?
  - Mark with `superseded_by_job_id`, leave state as-is (e.g., `created`)?
  - Or set `terminal_state = 'superseded'` and add `terminal_detail.supersededByJobId`?
  - Trade-off: redundancy vs missing-information when only one is populated.
- **Reconstruction query.** Recursive CTE walking `parent_attempt_id` to root. Confirm performance characteristics with realistic data sizes (a job with 10 retries shouldn't trigger a table scan).
- **`getRetryHistory(jobId)` return shape.** Array of audit rows? Tree structure? Time-ordered list? (Affects Goal 5 method-signature decision.)

## Out of scope

- The audit table itself (Goal 1).
- `terminal_detail.supersededByJobId` shape (Goal 2 sub-issue, if we go that route).
- Worker identity tracking across retries (Goal 5 / `getActiveWorkers` sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
