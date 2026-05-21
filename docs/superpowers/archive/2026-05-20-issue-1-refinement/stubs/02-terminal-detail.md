> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). Storage is settled — `terminal_detail` is a column on `pgbossier.record`. This issue now decides only the discriminated-union shape and the app-hook write path.

## Purpose

Decide the structure of `terminal_detail`, the worker signaling protocol for populating it, and the enforcement of the `class` field for failed jobs.

## Parent

Sub-issue of #1 (Goal 2 — Typed terminal-state detail capture).

## Decisions to make

- **Discriminated-union shape per `terminal_state`.** `terminal_state` carries only pg-boss's three real terminal values — `completed` / `cancelled` / `failed` (pg-boss 12 has no `expired` / `superseded` state). Confirm or refine:
  - `completed` → typically empty or `{ summary?: string }`
  - `failed` → `{ class: 'transient' | 'non_retryable', message?, where?, code?, [k]: unknown }` — `class` is mandated. When the failure was a timeout, also carry a pg-bossier-derived `expired` marker, e.g. `{ class, expired: true, deadlineMs?, exceededByMs? }`.
  - `cancelled` → `{ cancelledBy?, reason? }`. When a singleton was displaced by a newer job, carry a pg-bossier-derived `superseded` marker, e.g. `{ reason: 'superseded', supersededByJobId }`.
- **Deriving `expired` / `superseded`.** These are not pg-boss states — pg-bossier reconstructs them from pg-boss columns (timeout markers; singleton policy + the presence of a successor job). Decide the detection rules.
- **Worker signaling protocol.** Per the API-shape principle in #1, prototype both:
  - (a) Overload `boss.fail(id, err, opts)` to accept `opts.detail` / `opts.class`.
  - (b) New `bossier.recordTerminalDetail(id, detail)` method called alongside `boss.fail(id, err)`.
  Document the trade-off and pick one.
- **Storage location** when Goal 1 is not enabled. `pgboss.job.output` JSONB extension, or sidecar `pgbossier.terminal_detail`. Trade-off: `pgboss.job.output` is removed when pg-boss deletes the job row (`deletion_seconds`) and survives the retry `DELETE`+`INSERT` only because pg-boss's SQL is currently templated to carry it forward; sidecar requires pg-bossier-owned storage but is not exposed to that risk.
- **Validation strictness.** What does pg-bossier do when a worker calls `fail()` without a `class`? Reject (throws), warn (logs and stores `class: 'unknown'`), or quietly default to one value?
- **TypeScript surface.** How does the discriminated union appear to consumers reading audit rows? Tagged union, parsed JSONB with type guards, etc.

## Out of scope

- The audit table column for `terminal_detail` (Goal 1 sub-issue decides whether it lives there).
- Whether failures across the retry chain reuse the same `terminal_detail` or each attempt gets its own (Goal 3 sub-issue).
- TS generics surface for `Job<TInput, TOutput>` more broadly (cross-cutting sub-issue).

