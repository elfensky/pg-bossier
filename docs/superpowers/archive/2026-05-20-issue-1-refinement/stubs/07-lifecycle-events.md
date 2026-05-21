> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). Events can be emitted from the same capture points (the trigger and app-hook). This issue decides the mechanism and payload schema.

## Purpose

Decide the publication mechanism and event payload schema for pg-bossier's lifecycle events. Consumers subscribe to job state transitions (`created` / `started` / `completed` / `failed` / `cancelled` / `retried` — mapped to pg-boss's actual six-state machine; `expired` / `superseded` are derived refinements in the payload, not separate event types) instead of polling.

## Parent

Sub-issue of #1 (Goal 7 — Lifecycle event API).

## Note on prior art

Verified against pg-boss 12.18.2 source: pg-boss does NOT use Postgres LISTEN/NOTIFY (workers poll). pg-boss's "pub/sub" API is queue fan-out, not real-time events. pg-boss#570 (request for job lifecycle events upstream) was declined `not planned`. This sub-issue's solution will be net-new. pg-boss's `persistWarnings` option (emit + optionally persist to a `warning` table) is the closest prior-art pattern. The maintainer's stated concerns when declining #570 — events are instance-bound (don't cross Node processes) and an internal event table can bottleneck high-volume job processing — directly shape the mechanism and performance-budget decisions below.

## Decisions to make

- **Mechanism.** In-process EventEmitter, Postgres `LISTEN/NOTIFY` on pg-bossier-owned channels, or both.
  - Trade-off: in-process is simplest, single-process only; LISTEN/NOTIFY enables cross-process subscribers but requires long-lived connections.
- **Channel namespacing** (if LISTEN/NOTIFY chosen). Must be `pgbossier_*` prefix per constraint in #1.
- **Event names and payload schema.** Tagged union per event type, or one event with `type` field? Payload fields per type (`job_id`, `queue`, `terminal_state`, `terminal_detail`, etc.).
- **Subscription API.** `bossier.on('job.failed', handler)` event-name strings, or typed `bossier.events.failed.subscribe(handler)`? Trade-off: discoverability vs type-safety.
- **At-least-once vs at-most-once semantics.** If a subscriber is offline when an event fires, is it lost? (Goal 1 enabled → recoverable from audit table; without Goal 1 → ephemeral.)
- **Ordering guarantees.** Are events delivered in causal order? Per-job order is required; cross-job ordering may not be.

## Out of scope

- The audit table (Goal 1) — events fire regardless.
- Whether to ship OpenTelemetry exporters (explicit non-goal in #1).
- The shape of `terminal_detail` carried in `failed` events (Goal 2).

