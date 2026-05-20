> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). Reads are single-source (`pgbossier.record`). This issue decides the read-method signatures and adds a `search()` method across the JSONB columns.

## Purpose

Decide the exact signatures, return types, and surface of pg-bossier's new operational read methods. These replace the raw SQL queries descent-app currently runs against `pgboss.*`.

## Parent

Sub-issue of #1 (Goal 5 — New APIs).

## Decisions to make

- **Method signatures.** Confirm or refine names, parameters, return types for each:
  - `peek(queue: string, opts?: { limit?: number }) → Promise<Job<TInput>[]>` — show queued jobs without dequeuing
  - `findById<TInput, TOutput>(id: string) → Promise<Job<TInput, TOutput> | null>`
  - `listActive(opts?: { queue?: string, limit?: number, offset?: number }) → Promise<Job[]>`
  - `listStalled(opts?: { queue?: string, beyond?: number }) → Promise<Job[]>` — jobs past visibility timeout
  - `getRetryHistory(jobId: string) → Promise<AuditRow[]>` — full retry / supersession chain
  - `getActiveWorkers(opts?: { queue?: string }) → Promise<WorkerInfo[]>`
  - `count(queue: string, state?: JobState) → Promise<number>` / state-bucket counts
- **Overlap with pg-boss built-ins — name each method's differentiator.** pg-boss 12 already ships partial coverage; "always new APIs" is not true:
  - `findById` vs pg-boss `findJobs(name, opts)` — pg-boss can look up by id but *requires the queue name*. pg-bossier's `findById(jobId)` resolves across queues; the cross-queue lookup is the value-add.
  - state-bucket counts vs pg-boss `getQueueStats` / `getQueues` — pg-boss returns `deferred` / `queued` / `active` / `total` per queue, but no `failed` / `completed` counts and no cross-queue rollup. pg-bossier completes the set.
  - `getActiveWorkers` vs pg-boss `getWipData()` — pg-boss exposes worker WIP, but only for the *current Node process*. pg-bossier's value-add is real only if it gives cross-instance visibility — commit to that or drop the method.
  - `listStalled` — pg-boss now *resolves* stalled jobs itself (`heartbeatSeconds` + `failJobsByHeartbeat`) but exposes no read API for "what is stuck right now". The read shape is net-new; the resolution mechanism is upstream's.
  - `peek`, `getRetryHistory` — fully net-new; pg-boss has nothing comparable.
- **TS generics surface.** Where do `TInput` / `TOutput` types come from? Registered per-queue, inferred from a worker's handler, declared inline at call site? (Coordinate with the cross-cutting TS-generics sub-issue.)
- **Worker identity model.** What is a "worker" for `getActiveWorkers()` — pg-boss's internal `workId` UUIDs, OS process info, custom registration via pg-bossier hooks?
- **Pagination shape.** `limit`+`offset`, cursor-based, or first-class page tokens? Trade-off: simplicity vs scale.
- **Live vs historical reads.** Does `findById` read from `pgboss.job`, fall back to `pgbossier.job_audit`? (pg-boss 12 has no `archive` table.) Define the lookup order and what counts as "found".
- **Connection pooling.** Reuse pg-boss's pool, take its own, both?

## Out of scope

- Write-side methods — terminal_detail (Goal 2), input_snapshot (Goal 4), progress (Goal 6), and lifecycle event subscription (Goal 7) are decided in their own goals.
- The audit table schema (Goal 1).

## Blocked by

#1 — pending agreement on the refined scope.
