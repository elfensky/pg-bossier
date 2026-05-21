> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). Storage is settled — `input_snapshot` is an opt-in column on `pgbossier.record`. This issue now decides only its shape and the app-hook write path.

## Purpose

Decide the structure and population API for the opt-in `input_snapshot` slot — a consumer-defined "what data did this job consume" manifest preserved alongside the job.

## Parent

Sub-issue of #1 (Goal 4 — Optional input-snapshot capture).

## Decisions to make

- **Column placement.** On the audit table (`pgbossier.job_audit.input_snapshot`) when Goal 1 is enabled, or on `pgboss.job.data` as a known sub-key when Goal 1 is not enabled. Confirm both paths.
- **Population API.** Per the API-shape principle in #1, prototype both:
  - (a) Overload `boss.send(queue, data, opts)` to accept `opts.inputSnapshot`.
  - (b) New `bossier.recordInputSnapshot(jobId, snapshot)` called by the worker at job start.
  Document the trade-off and pick one.
- **Typed reader.** `bossier.getInputSnapshot(jobId)` returns `unknown` (consumer decides shape) or `T extends JsonValue` (typed via generics).
- **Indexing.** GIN index on the JSONB column for arbitrary-shape queries, expression indexes on common consumer-defined fields, or no indexing (consumer-owned)?
- **Size limits.** What if a consumer tries to store a 10MB snapshot? Hard limit, warn, or unbounded with documentation note?

## Out of scope

- The semantics of *what* the snapshot should contain — that's consumer-owned (intentional non-goal in #1).
- pg-bossier auto-capture of consumed data — explicit non-goal.
- The audit table existence (Goal 1).

