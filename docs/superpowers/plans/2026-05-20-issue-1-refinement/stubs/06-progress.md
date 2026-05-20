> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). Storage is settled — `progress` is a column on `pgbossier.record`. This issue now decides only the write path and retry-resume semantics.

## Purpose

Decide the storage location, write API, and read API for pg-bossier's persistent progress slot. One mechanism that supports both resumable-job and non-resumable-job usage patterns (consumer chooses semantics).

## Parent

Sub-issue of #1 (Goal 6 — Persistent job progress).

## Decisions to make

- **Storage location.** Survives pg-boss's DELETE+re-INSERT retry path. Candidates:
  - Sidecar table `pgbossier.job_progress` keyed by `(queue, original_job_id)` so it survives the per-attempt INSERT churn.
  - Audit table column updated by each attempt.
  - `pgboss.job.output` — but note this survives the retry `DELETE`+`INSERT` only because pg-boss's `failJobs` SQL is currently templated to carry `output` forward; it is one upstream SQL change from silently dropping progress. Weigh this against the sidecar option.
  - Extension to pg-boss via `touch()` carrying a `data` parameter (architectural alternative — see #1's API-shape principle).
- **Write API.** Per API-shape principle in #1, prototype both:
  - (a) Overload `boss.touch(jobId, opts)` to accept `opts.progress`.
  - (b) New `bossier.setProgress(jobId, progress)` called by the worker.
  Document trade-off, pick one.
- **Shape.** JSONB, consumer-defined. Document the resumable / non-resumable usage patterns from #1 with examples.
- **Retry-resume semantics.** On retry, what does the worker see when calling `getProgress(jobId)`? The previous attempt's value? The root attempt's value? The most recent value across all attempts in the chain?
- **Cleanup.** When a job reaches a terminal state (`completed` / `failed` / etc.), is the progress slot retained, cleared, or moved to the audit table? Trade-off: storage vs forensic continuity.

## Out of scope

- The audit table existence (Goal 1).
- Retry-history reconstruction (Goal 3).
- TypeScript generics surface for the progress payload (cross-cutting sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
