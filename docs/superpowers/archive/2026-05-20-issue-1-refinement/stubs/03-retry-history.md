> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). Retry history is `SELECT … ORDER BY attempt` over `pgbossier.record` — no link columns. This issue now decides only the `getRetryHistory` return shape and the dead-letter / supersession edge cases.

## Purpose

Decide how a job's retry history is reconstructed and exposed. A job keeps a single stable `id` for its entire life: pg-boss's retry path (`failJobs`) is a `DELETE`+`INSERT` that **reuses the same id** (verified against pg-boss 12.18.2). Retry history is therefore not a chain of linked ids — it is the ordered sequence of row-versions of one id.

## Parent

Sub-issue of #1 (Goal 3 — Retry history tracking).

## Corrected model (verified against pg-boss 12.18.2)

- A job's `id` is stable from creation through every retry to its terminal state.
- Each attempt is a row-version of that id; pg-boss's `retry_count` (0, 1, 2, …) orders them.
- pg-boss destroys the prior attempt's row on each retry (`failJobs` = `DELETE` + `INSERT` with the same id), so per-attempt history exists only if pg-bossier captures each row-version before pg-boss discards it — that capture is the `pgbossier.job_chronicle` table (Goal 1 / #2).
- There are **no parent/successor link columns**. Retry history is `SELECT * FROM pgbossier.job_chronicle WHERE job_id = $1 ORDER BY attempt`.

## Decisions to make

- **`getRetryHistory(jobId)` return shape.** A time-ordered array of attempt records (each = one chronicle row). Confirm the field set returned per attempt.
- **Dead-letter lineage.** Dead-lettering is the *one* case that produces a genuinely new `id` — pg-boss `INSERT`s a fresh job into the dead-letter queue with a new id and records no link back to the source. Decide whether pg-bossier records a `dead_letter_source_id` link or treats the DLQ job as unrelated.
- **Singleton supersession.** When a singleton job is displaced by a newer job, decide how the relationship is represented — a marker in `terminal_detail` (see Goal 2 / #3), an explicit link, or nothing.
- **Reschedule.** Confirm whether reschedules need distinct representation or are simply ordinary row-versions of the same id.

## Out of scope

- The `pgbossier.job_chronicle` table schema and capture mechanism (Goal 1 / #2).
- The `terminal_detail` shape (Goal 2 / #3).
- Worker identity tracking (Goal 5 / `getActiveWorkers`).

