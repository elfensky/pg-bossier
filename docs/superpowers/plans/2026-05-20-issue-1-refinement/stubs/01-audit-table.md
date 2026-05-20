> **Architecture update — 2026-05-20.** Issue #1 is agreed; the cross-cutting storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). This issue's full buildable design — the `pgbossier.record` DDL, the capture trigger, the install migration, and backfill — is specified in the [substrate spec](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-substrate-spec.md); implementation proceeds from there.

## Purpose

Decide pg-bossier's forensic audit table schema and capture mechanism. The table preserves every pg-boss state change forever, surviving pg-boss's in-place row deletion — the `deletion_seconds`-driven `DELETE` and the `DELETE`+`INSERT` cycle pg-boss runs on every retry.

## Parent

Sub-issue of #1 (Goal 1 — Permanent job history). Rubric for this issue is the goals / non-goals / constraints in #1.

## Decisions to make

- **Table schema.** Column set, types, indexes, constraints. Must accommodate `terminal_state` + `terminal_detail` (Goal 2), retry-history links (Goal 3), `input_snapshot` (Goal 4), and progress data (Goal 6).
- **Capture mechanism.** Postgres trigger on `pgboss.job` (database-side), app-level hook from pg-bossier's wrapping client (application-side), or both. Trade-off: trigger captures every state change including ones pg-bossier didn't initiate; app hook misses out-of-band changes but is easier to test.
- **Write semantics.** Confirmed in #1 as fail-open (audit failure never blocks pg-boss). This sub-issue confirms HOW — try-catch in app-side, defaults / exception suppression on trigger-side.
- **Transaction interaction.** pg-boss 12 lets consumers run a queue op inside an ORM transaction (`boss.send(q, data, { db: fromPrisma(tx) })`). "Fail-open / never block" implies the audit write happens *outside* that transaction — so a rolled-back op can still leave an audit row. Decide whether that inconsistency is acceptable or whether audit writes opt into the caller's transaction when one is supplied.
- **Forensic preservation.** The audit row must survive pg-boss's eventual DELETE of the source job. Verify no foreign-key from audit to `pgboss.job` (else CASCADE would defeat the purpose).
- **Indexes.** Likely indexes on `(job_id)`, `(queue, state, created_at)`, `(terminal_state)`. Confirm against expected query patterns from Goal 5.

## Out of scope

- The shape of `terminal_detail` (Goal 2 sub-issue).
- The retry-history column shapes (Goal 3 sub-issue).
- The exact backfill strategy (cross-cutting sub-issue).
- The numeric per-event performance budget (cross-cutting sub-issue).

## Blocked by

#1 — pending agreement on the refined scope. This stub exists for visibility.
