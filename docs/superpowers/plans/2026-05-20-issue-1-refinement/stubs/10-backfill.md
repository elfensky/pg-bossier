## Purpose

Decide how the audit table populates when pg-bossier is installed on an existing pg-boss instance that already has millions of historical jobs. Affects Goal 1's adoption story for descent-app and similar consumers.

## Parent

Sub-issue of #1 (cross-cutting — affects Goal 1 implementation).

## Decisions to make

- **Default strategy.** Three candidates:
  - **Capture-from-now.** Audit table starts empty; only state changes after install are captured. Simplest. Forensic queries for pre-install jobs return empty.
  - **Best-effort backfill.** Read `pgboss.job` at install time (pg-boss 12 has no `archive` table), populate audit rows for pre-existing jobs (with sentinel `backfilled: true` in `terminal_detail`). May be slow on large databases. Note: pre-install jobs already removed by pg-boss's `deletion_seconds` cleanup are unrecoverable — backfill only sees rows still present in `pgboss.job`.
  - **Toggleable.** Default to capture-from-now; expose a `bossier.backfill()` method consumers call when they want it.
- **Backfill semantics.** When backfilling, what's the `terminal_state` for jobs pg-boss hasn't fully resolved yet (`created` / `active` / `retry`)? Live state, or "as-of install time"?
- **Backfill performance.** Streaming inserts vs batch? Throttle / chunk size? Lock impact on `pgboss.job` during backfill?
- **User communication.** Docs, CLI output, or migration log about what happened during install (especially how much was backfilled).
- **Interaction with Goal 8 perf budget.** Backfill is one-time; should it count against the per-event budget, or is it exempted?

## Out of scope

- The audit table schema (Goal 1 sub-issue).
- pg-bossier upgrade migrations between versions (Goal 9 sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
