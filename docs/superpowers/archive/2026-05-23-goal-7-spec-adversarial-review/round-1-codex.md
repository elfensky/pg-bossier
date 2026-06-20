Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/andrei/Developer/github/pg-bossier
model: gpt-5.4
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/andrei/.codex/memories]
reasoning effort: none
reasoning summaries: none
session id: 019e51b8-4bc2-73c2-84f4-39177d454b93
--------
user
# Adversarial review — Round 1

You are participating in a 4-way adversarial review of a software design spec
for pg-bossier — a JS/TS library that layers on top of pg-boss (a Postgres job
queue) to provide an operational data plane.

**Your role: ADVERSARIAL CHALLENGER.** Find real problems. Be technically
concrete. Cite specific sections or quotes from the spec. Surface real risks,
not hypothetical ones.

## Read the spec first

The spec under review is at:

`/Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md`

Read the whole file before you write a single critique line.

## Project charter constraints (issue #1, load-bearing — NON-NEGOTIABLE)

- **Audit writes are fail-open** — pg-bossier failures NEVER block pg-boss operations.
- **Per-event overhead has a published budget** (still being decided in #12) — exceeding the budget blocks release.
- **API-shape principle: composition, not replacement.** Read methods are new pg-bossier methods, not overloads of pg-boss methods. Write extensions are explicit per-feature decisions.
- **pg-boss compatibility tiers** — *Stable* (public JS API), *Transitional* (`pgboss.job` table reads), *Forbidden* (pg-boss internals — NEVER depend on).
- **Symmetric uninstall** — `DROP SCHEMA pgbossier CASCADE` must leave zero remnants.
- **Non-goals**: no UI, no REST, no fork of pg-boss, no scheduling, no workflow engine, no queue runtime mutation, no observability platform, no automatic handler introspection, no ORM, no bounded retention tooling.
- **Primary consumer**: descent-app (Prisma-using app with ~45 raw `pgboss.*` queries today).

## Attack vectors — address each in order

1. **LISTEN/NOTIFY transport choice.** Hidden costs at scale (long-poll connection per subscriber, NOTIFY delivery semantics under high write throughput, async commit interactions, replication corner cases like logical replication / hot standby / failover)?

2. **At-most-once contract + gap signal.** Does the proposed reconnect-and-emit-`'error'` path actually let consumers do a CORRECT catch-up read against `pgbossier.record`? Specifically: between the catch-up `SELECT` and the resumed live stream, is there a window where events can be missed OR double-counted? How would a consumer write the catch-up correctly given only `captured_at` (a timestamp with no uniqueness)?

3. **Thin payload + follow-up read pattern.** 1 event = 1 NOTIFY + 1 SELECT. Is that read amplification acceptable at high event rates (say 1000 events/sec across all consumers)? Could a slightly fatter payload (e.g. inline `data` when small, or `terminal_detail` when small) be a better default?

4. **`pg_notify`-inside-trigger placement.** Does it really commit-or-rollback atomically with the audit row INSERT in every PL/pgSQL edge case? Prepared transactions (2PC) — does NOTIFY survive `PREPARE TRANSACTION`? Advisory locks held across the notify? Streaming replication: NOTIFY is not replicated to standbys — what happens after a primary failover? Subtransactions inside the trigger?

5. **Auto-reconnect with fixed 1s delay forever.** Hidden DoS vector against the consumer's own DB during sustained outage? If DB is hard-down for 30 minutes, that's 1800 connection attempts per subscriber. Hard limit needed, jitter, exponential backoff, circuit breaker?

6. **`BossierEvents extends EventEmitter` API shape.** Does the typed-overload pattern survive pino/debug/general listener-counting tooling? Does it work with `getMaxListeners` / `setMaxListeners`? Is `close(): Promise<void>` aligned with idiomatic Node async cleanup (vs `AbortSignal`, vs `Symbol.asyncDispose`)?

7. **State→event mapping in JS, not SQL.** Does carrying both `event` and `state` in the payload create a source-of-truth problem if a future pg-boss version adds a new state value the JS mapping doesn't know? Cite the failure mode the consumer would see.

8. **Issue #1 violations.** Anything in this design that quietly violates a non-goal or a load-bearing constraint? Be specific — name the constraint and the line in the spec.

9. **Test plan false confidence.** Does "kill the backend with `pg_terminate_backend`" actually reproduce the production failure modes a real consumer will hit? What about: TLS handshake failure mid-stream, IDLE-IN-TRANSACTION timeouts, PgBouncer in transaction-mode (which silently breaks LISTEN), replication failover changing the primary, slow consumer with backpressure (notifications queueing in Postgres' async queue, eventual `NOTIFY queue is full`)?

10. **Anything missing from v1 entirely** that the spec doesn't even mention but probably needs.

## Deliverable

A critique addressing each numbered vector. Be concise but technically rigorous. Cite the spec.

End with exactly one of:
- **SHIP AS-IS** — if you find nothing material
- **SHIP WITH NAMED CHANGES** — list each change as `CHANGE: <description>` with a one-line rationale
- **BLOCK UNTIL <X>** — only if you believe a hard blocker exists

Identify yourself by name in your response header (e.g. `# Codex critique — Round 1`).
codex
Reviewing the lifecycle-events spec end to end first, then I’ll map each critique point to specific sections and quotes before writing conclusions.
exec
/bin/zsh -lc 'wc -l docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md' in /Users/andrei/Developer/github/pg-bossier
exec
/bin/zsh -lc 'cat docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
     440 docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md

 succeeded in 0ms:
# Goal 7 — Lifecycle event API: design

**Date:** 2026-05-22
**Sub-issue:** [#8](https://github.com/elfensky/pg-bossier/issues/8)
**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
**Status:** Design — pre-implementation. Builds on the storage substrate (PR #15) and the unified client (2026-05-22). No code yet.

---

## Summary

pg-bossier ships a job-lifecycle event API. Every state transition that the
already-shipped capture trigger writes to `pgbossier.record` is also published
as a Postgres `NOTIFY` on a single pg-bossier-owned channel. Consumers
subscribe via `await bossier.subscribe()`, which returns a typed Node
`EventEmitter` (`BossierEvents`) carrying a thin identity payload — `jobId`,
`queue`, `attempt`, `state`, plus a friendly `event` name and `capturedAt`.
The subscriber auto-reconnects on connection drop and emits an `'error'`
event to signal the gap; full detail for any event is read from
`pgbossier.record` via the already-shipped Goal 5 read API. Delivery contract
is **at most once, with gap signalling** — durable replay is available by
reading the audit table.

---

## Context — what is already built

- **`pgbossier.record`** — the chronicle table, one row per `(job_id, attempt)`. Goal 1 (#2), delivered.
- **`pgbossier.capture()` trigger function + `pgbossier_capture` trigger** on `pgboss.job`, fires `AFTER INSERT OR UPDATE OF state`. Writes the record row inside a `BEGIN…EXCEPTION WHEN OTHERS` block so a pg-bossier failure can never block the underlying pg-boss op (fail-open per issue #1).
- **`install(pool)` / `uninstall(pool)`** — idempotent install (schema + table + indexes + trigger function + trigger + backfill); uninstall is `DROP SCHEMA pgbossier CASCADE`.
- **`bossier({ boss, pool })` client** — a `Proxy` over the pg-boss instance exposing pg-boss's full API plus pg-bossier's own methods on one flat surface. The proxy forwards `.on()` to pg-boss's EventEmitter — meaning pg-bossier's event subscription must live somewhere other than `.on()` to avoid collision.
- **Goal 5 read API** (merged in PR #17) — `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning`. These are the durable read path that backs the at-most-once delivery contract.
- **Goal 6 progress API** — `setProgress` / `getProgress`. Independent of this design; mentioned only as recent prior art for how a goal layers onto the client.

---

## Goals and non-goals

### What this design ships

1. A Postgres-`NOTIFY`-based transport that fires on every job state transition the existing trigger already captures.
2. A subscription API on the `bossier` client: `await bossier.subscribe()` → typed `BossierEvents`.
3. Six job-event types (`created` / `started` / `completed` / `failed` / `cancelled` / `retried`) plus a catch-all `'job'` and a subscriber-level `'error'`.
4. Auto-reconnect with a one-`'error'`-per-gap signal so consumers can tell when an event stream was interrupted.
5. Integration tests covering the six event types, the catch-all, cross-subscriber broadcast, reconnect after a forced backend termination, idempotent `close()`, and the trigger's fail-open path.

### What this design deliberately does NOT ship

- **`terminal_detail` / `expired` / `superseded` markers in the event payload.** That is Goal 2 (#3) territory. The event payload stays the minimal identity-and-state envelope in v1; consumers needing failure detail call `findById(jobId)`.
- **Server-side filtering at subscribe time** (e.g. `subscribe({ queue: 'sync' })`). Consumers filter inside the handler — one line.
- **OpenTelemetry exporters or any observability layer.** Explicit non-goal in issue #1.
- **Automatic catch-up replay on reconnect.** The contract is at-most-once; replay belongs to the consumer using `pgbossier.record`. Rationale in the "Connection-gap handling" decision below.

---

## Locked decisions

### Mechanism — Postgres `LISTEN/NOTIFY` transport with a local typed `EventEmitter` API

The trigger calls `pg_notify` as it writes each record row. `bossier.subscribe()`
opens a dedicated `pg` connection, runs `LISTEN pgbossier_job`, and re-surfaces
incoming notifications as a typed Node `EventEmitter`.

**Why not in-process EventEmitter only?** An in-process emitter fed by call
interception in the proxy cannot see every transition. The proxy only sees
calls the consumer makes (`complete`, `fail`). It does not see
`created`→`active` when a worker fetches a job, the retry `DELETE`+`INSERT`,
or pg-boss's maintenance expiring a stalled job. Catching those would mean
reaching into pg-boss internals — the **Forbidden** compatibility tier.
In-process also fails the cross-process requirement: a web UI process never
sees worker events, which is the primary consumer's actual shape.

**Why not "both"?** "Both" collapses into this approach. The friendly
in-process surface a "both" design would expose *is* the `EventEmitter`
returned by `subscribe()` — it just happens to be fed by NOTIFY rather than by
call interception. Shipping a second, structurally-incomplete mechanism would
be a strictly-worse second code path.

### Connection-gap handling — at-most-once with auto-reconnect and gap signal

When the subscriber's connection drops, the events that fired during the gap
are not redelivered by Postgres. The subscriber **auto-reconnects** and
**emits one `'error'`** so the consumer knows a gap happened. Durable replay
is available — by reading `pgbossier.record` — but pg-bossier does not perform
it automatically.

**Why not automatic replay?** Automatic replay would need a monotonic
sequence column on `pgbossier.record` (none today — `captured_at` is a
timestamp with no uniqueness guarantee), would need cursor tracking, would
need dedup against live events arriving simultaneously, and would weaken the
delivery contract to at-least-once with idempotent-handler requirements. All
real complexity, all already addressable by the consumer reading the audit
table on the rare gap.

**Why not manual control?** "Expose start/stop/state, no auto-reconnect"
pushes the reconnect loop into every consumer. Most will skip it; a fragile
event stream pushes consumers back toward polling — directly against issue
#1 success criterion #3.

### Channel — one channel, `pgbossier_job`

Single channel, all six event types share it. Per-channel `LISTEN` is
essentially free in Postgres, but each new channel means a new line on every
subscriber. The JS side fans out by reading the payload's `state` field.

Channel name `pgbossier_*` prefix satisfies issue #1's namespacing constraint
and preserves Goal 9's symmetric uninstall (`DROP SCHEMA pgbossier CASCADE`
removes the trigger function, which cascades to drop the trigger, which stops
the notifications).

### Subscription API — `await bossier.subscribe()` returning a typed EventEmitter

A new method on the `bossier` client. Async because it opens a connection
and runs `LISTEN`. Returns a `BossierEvents` — a typed wrapper around Node
`EventEmitter` with `on` / `once` / `off` and a `close()` method.

**Why not `bossier.on('job.failed', …)`?** The `bossier` client is a `Proxy`
over the pg-boss instance, which is itself an `EventEmitter`. The proxy
forwards `.on()` to pg-boss. Adding a namespaced overload would either
require intercepting `.on()` in the proxy (fragile — two emitters
masquerading as one with magic strings) or fundamentally change what
`.on()` means depending on the string. A separate object (`subscribe()`)
keeps each EventEmitter doing one job.

**Why not a typed-subscriber-object** (`bossier.events.failed.subscribe(h)`)?
It reinvents `EventEmitter` for no real gain. The Node `EventEmitter` contract
is well-understood, has a typed overload pattern, and integrates naturally
with `process.on('SIGINT', …)`-style cleanup.

### Payload — thin JSON identity envelope

```json
{ "job_id": "…uuid…", "queue": "sync", "attempt": 2,
  "state": "failed", "captured_at": "2026-05-22T22:34:11.123Z" }
```

~150 bytes typical, well under the ~8000-byte NOTIFY cap. No `data`, no
`output`, no `terminal_detail`, no `progress` — those live in
`pgbossier.record` and are read on demand via the Goal 5 read API.

**Why thin?** Postgres caps a NOTIFY payload at ~8000 bytes total. Real
jobs can carry multi-KB `data` / `output` blobs that would routinely exceed
the cap. A thin envelope keeps the per-event SQL cost negligible (relevant
to issue #12's per-event budget) and aligns with the existing "audit row +
typed read" pattern.

### State→event mapping — done in JS, not SQL

The trigger emits the raw pg-boss `state` (`created` / `active` / `retry` /
`completed` / `failed` / `cancelled`). The JS subscriber maps `active`→`started`
and `retry`→`retried` (the other four are identity) via a single TS constant.

**Why JS, not SQL?** Keeps the trigger minimal — no `CASE` expression — and
puts the naming vocabulary in one TypeScript constant that is easy to read
and code-review. The raw `state` field is still in the payload so consumers
correlating events to records have it.

---

## Architecture and data flow

```
pg-boss op (e.g. boss.complete(jobId))
    └─→ UPDATE pgboss.job (state column changes)
          └─→ trigger pgbossier_capture fires (already shipped)
                └─→ pgbossier.capture() runs inside the pg-boss op's transaction:
                      ├── INSERT/UPDATE pgbossier.record      ← already shipped
                      └── pg_notify('pgbossier_job', payload) ← new in Goal 7
                            └─→ on transaction COMMIT, Postgres delivers
                                  └─→ subscriber's LISTENing connection receives it
                                        └─→ pg driver emits 'notification'
                                              └─→ JS parses, maps state→event
                                                    └─→ emits on the EventEmitter
                                                          └─→ consumer's
                                                              events.on('failed', h) runs
```

Properties that fall out of this shape:

- **One capture point.** The audit row write and the notify both live in the same trigger and the same transaction — they commit or roll back together. The event stream cannot claim a transition that didn't actually happen.
- **No new pg-boss surface dependency.** Goal 7 depends on Postgres' documented `pg_notify` and `LISTEN` — *not* on any pg-boss surface. No `COMPATIBILITY.md` tier change.
- **Idempotent install.** `CREATE OR REPLACE FUNCTION` in `install()` upgrades the trigger function in place on existing installs. No data migration.
- **Symmetric uninstall.** `DROP SCHEMA pgbossier CASCADE` drops the function; the trigger that depends on it cascades away too. No regression vs Goal 9.

---

## SQL side — trigger change

The change to `pgbossier.capture()` is one `PERFORM pg_notify(...)` inside
the existing `BEGIN…EXCEPTION WHEN OTHERS` block, placed *after* the record
INSERT/UPDATE.

```sql
CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO pgbossier.record
      (job_id, queue, attempt, state, data, output,
       created_on, started_on, completed_on, captured_at)
    VALUES
      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
       NEW.created_on, NEW.started_on, NEW.completed_on, now())
    ON CONFLICT (job_id, attempt) DO UPDATE SET
      state        = EXCLUDED.state,
      data         = EXCLUDED.data,
      output       = EXCLUDED.output,
      created_on   = EXCLUDED.created_on,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on;

    -- NEW: publish a thin lifecycle event.
    PERFORM pg_notify(
      'pgbossier_job',
      json_build_object(
        'job_id',      NEW.id,
        'queue',       NEW.name,
        'attempt',     NEW.retry_count,
        'state',       NEW.state,
        'captured_at', now()
      )::text
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pgbossier: capture failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
```

Three notes:

1. **Order.** `pg_notify` after the INSERT. If `pg_notify` were to fail (vanishingly unlikely with a ~150-byte payload — only payload-too-long is realistic), PL/pgSQL's implicit savepoint rolls back the INSERT too. So: either both the record row and the event happen, or neither does.
2. **Fail-open.** Any failure inside the inner `BEGIN` is caught by the existing `EXCEPTION WHEN OTHERS` block. The pg-boss op proceeds unaffected. Same contract Goal 1 already promises.
3. **Same transaction.** `pg_notify` queues the notification; Postgres only sends it on commit. A rolled-back pg-boss op produces no event, exactly like it produces no audit row.

---

## JS side — API surface

### Public types (exported from `src/index.ts`)

```ts
export type JobEventName =
  | 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'retried';

export interface JobEvent {
  event: JobEventName;          // friendly event name
  jobId: string;                // matches pgbossier.record.job_id
  queue: string;
  attempt: number;
  state: JobState;              // raw pg-boss state — mirrors JobRecord.state
  capturedAt: Date;             // parsed from the payload's captured_at
}

export interface BossierEvents extends EventEmitter {
  on<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void
  ): this;
  once<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void
  ): this;
  off<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void
  ): this;
  /** Stops reconnecting, releases the dedicated connection. Idempotent. */
  close(): Promise<void>;
}

interface BossierEventsMap {
  created:   [JobEvent];
  started:   [JobEvent];
  completed: [JobEvent];
  failed:    [JobEvent];
  cancelled: [JobEvent];
  retried:   [JobEvent];
  job:   [JobEvent];   // catch-all — every transition
  error: [Error];      // subscriber-level — connection drop, parse error, handler throw
}
```

### Client method

```ts
// in BossierMethods (src/client.ts)
/**
 * Open a subscription to job-lifecycle events. Holds one dedicated
 * pool connection until close() is called. Auto-reconnects on
 * connection drop and emits 'error' to signal the gap; durable replay
 * is available by reading pgbossier.record.
 */
subscribe(): Promise<BossierEvents>;
```

### Typical usage

```ts
const client = bossier({ boss, pool });
const events = await client.subscribe();

events.on('failed', e => log.warn(`job ${e.jobId} failed on attempt ${e.attempt}`));
events.on('job',    e => metrics.transition.inc({ event: e.event, queue: e.queue }));
events.on('error',  err => log.warn({ err }, 'event-stream gap or parse error'));

// graceful shutdown
process.on('SIGINT', async () => { await events.close(); await boss.stop(); });
```

---

## Connection lifecycle and reconnect

- **Connection acquisition.** `pool.connect()` returns a dedicated `PoolClient`; the subscriber holds it for its lifetime. Documented in the README: each live subscriber holds one pool connection, size pools accordingly.
- **Listen.** On connect, register a `'notification'` handler, then run `LISTEN pgbossier_job`.
- **Reconnect loop.** If the underlying client emits `'error'` or `'end'` and `close()` has not been called: `release(err)` the dead client → wait a fixed `1000ms` → `pool.connect()` again → re-`LISTEN`. After a successful re-LISTEN, emit one `'error'` so the consumer knows a gap happened. Retry forever until either it succeeds or `close()` is called.
- **`close()`.** Sets a `closed` flag (prevents further reconnection), releases the live client back to the pool, resolves once the connection is fully released. Idempotent — calling `close()` twice resolves immediately.

| Event | What pg-bossier does | What the consumer sees |
|---|---|---|
| Network blip / client drop | Auto-reconnect after 1s, re-LISTEN | One `'error'` per gap |
| Postgres restart | Auto-reconnect when DB is back | One `'error'`, then events resume |
| Handler throws | Caught, routed to `'error'` if a listener is registered | `'error'` with the thrown value |
| Malformed notification JSON | Logged + `'error'`, drop that one, stream continues | `'error'` with parse error |
| `close()` called | Stop reconnecting, release client | Nothing further |

**Why fixed 1s delay, not exponential backoff?** YAGNI in v1. A subscriber
holds one connection; a hard reconnect storm against a single pool from a
single subscriber is not a real risk. If real-world experience surfaces a
need, exponential backoff is a small follow-up that doesn't break the API.

---

## Error handling and fail-open boundaries

Three failure surfaces, three rules:

1. **Inside the trigger (SQL side).** Caught by the existing `EXCEPTION WHEN OTHERS` block. `RAISE WARNING`, swallowed. *Non-negotiable per issue #1.*
2. **Inside the subscriber (JS side, library code).** Connection drops, re-`LISTEN` failures, JSON parse errors → emit `'error'`, never throw.
3. **Inside the consumer's handler.** Follow Node `EventEmitter`'s contract: a thrown handler is routed to the `'error'` listener if one is registered; otherwise it propagates (Node-standard). README strongly recommends registering an `'error'` listener.

Clean rule that falls out: *pg-bossier never breaks pg-boss, never silently
throws in the consumer's process, never hides what went wrong from a consumer
who chooses to listen.*

---

## Testing strategy

`test/events.test.ts` — `vitest` + `@testcontainers/postgresql`, real
Postgres + pg-boss 12.18.2, no mocks. Continues the existing pattern.

1. **Happy path.** Subscribe; submit and complete a job via pg-boss; assert `'started'` then `'completed'` arrive with expected `jobId`/`queue`/`attempt`/`state`/`event`.
2. **All six event types.** One test per `created` / `started` / `completed` / `failed` / `cancelled` / `retried`. `failed` + `retried` use a worker that throws on a job configured with retries.
3. **Catch-all `'job'` event.** A single `'job'` listener sees all six transitions for a job.
4. **Cross-subscriber broadcast.** Two `subscribe()` instances on the same pool both receive every event (stand-in for the multi-process case — sufficient because Postgres NOTIFY broadcasts to every LISTENer).
5. **`close()` is clean.** No further events after `close()`; the pool's connection count returns to its pre-subscribe value; calling `close()` twice doesn't throw.
6. **Reconnect after drop.** Use `pg_terminate_backend(pid)` from a second connection to kill the subscriber's backend; assert one `'error'` fires; assert events flow once reconnected; assert no events leak from the dead connection.
7. **Trigger fail-open.** Provoke a `pg_notify` failure path (an out-of-band oversized payload via a separate test-only `PERFORM`) and confirm the pg-boss op still succeeds.
8. **No Forbidden imports.** A static-grep test asserts `src/events.ts` imports only from `pg` and Node built-ins (`node:events`), never from `pg-boss/src/*`.

**Performance probe (informational, not a release gate).** Submit N jobs
(say N=1000) and measure per-transition wall-clock with and without
pg-bossier installed. Lands as a number alongside issue #12.

---

## File layout

**New**
- `src/events.ts` — `BossierEvents` class, `JobEvent` type, `subscribe(pool)` factory, state→event map, reconnect loop.
- `test/events.test.ts` — integration tests above.

**Changed**
- `src/sql.ts` — `CAPTURE_FUNCTION_SQL` gains the `pg_notify(...)` `PERFORM`.
- `src/install.ts` — no code change. `CREATE OR REPLACE FUNCTION` already upgrades the trigger function idempotently on re-install.
- `src/client.ts` — `BossierMethods` gains `subscribe()`; methods map adds it.
- `src/index.ts` — re-exports `BossierEvents`, `JobEvent`, `JobEventName`.
- `CHANGELOG.md` — entry under `## [Unreleased]` → `Added`.
- `CLAUDE.md` — project-status paragraph notes Goal 7 delivered, #8 closed.
- `COMPATIBILITY.md` — no tier change; document `pgbossier_job` as a published channel name (for consumers who want to LISTEN themselves outside JS, e.g. from a non-Node service).
- `README.md` — new section under "Operational API" describing `subscribe()` and the events.

---

## Compatibility tier impact

No change to `COMPATIBILITY.md`. Goal 7 introduces no new pg-boss surface
dependency:

- `pg_notify` and `LISTEN` are documented Postgres features (effectively "Stable" Postgres surface — analogous to the Stable tier for pg-boss).
- The trigger function is in the `pgbossier` schema, owned by pg-bossier.
- The channel name `pgbossier_job` is pg-bossier-owned per issue #1's namespacing constraint.

The `pg-boss` API surface used by pg-bossier is unchanged from the substrate.

---

## Out of v1 (deliberately, with reasons)

- **`terminal_detail` / `expired` / `superseded` markers in payloads.** Goal 2 (#3) territory. v1 payload stays the identity envelope; consumers needing failure detail call `findById(jobId)`. When Goal 2 ships, the payload can grow inside the 8KB cap.
- **Server-side filtering** (`subscribe({ queue: 'sync' })`). Consumers filter inside the handler with one line — `if (e.queue !== 'sync') return;`. YAGNI in v1.
- **Automatic catch-up replay** on reconnect. Decided in the locked-decisions section above. Available to the consumer today via `pgbossier.record`.
- **Exponential backoff** on reconnect. Fixed 1s delay in v1. Trivial to add later without breaking the API.
- **OpenTelemetry exporters or any observability stack.** Explicit non-goal in issue #1; consumers build observability on top of the event substrate.

---

## Open dependencies (cross-cutting issues)

- **#12 — per-event performance budget.** Goal 7 adds one `pg_notify(text, text)` call per transition to the existing trigger. The performance probe in the testing section produces a measurement for #12 to argue from. This design does not block on #12 — it produces the number #12 needs.
- **#13 — TypeScript generics surface.** `JobEvent` here is **not** parameterized on `TInput` / `TOutput`, because the payload deliberately omits `data` / `output`. When #13 settles the generics pattern, the *follow-up read* (`findById`) is the typed surface; the event remains the identity envelope.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Real-world `pg_notify` payload exceeds 8KB | Very low — payload is bounded ~150 bytes by construction | Static envelope shape; no consumer-controlled fields enter the payload |
| Subscriber's pool exhausted by held connection | Low — one connection per live subscriber | Documented in README; tests verify connection count returns to baseline on `close()` |
| Handler throws and crashes the consumer's process | Medium — Node default if no `'error'` listener | Strongly documented; tests verify `'error'` routing |
| Reconnect storm against Postgres | Low — single subscriber, single connection | Fixed 1s delay; exponential backoff as a future-compatible extension |
| Future addition of more channels collides with pg-boss | Low — `pgbossier_*` prefix is reserved | Channel-name convention documented in `COMPATIBILITY.md` |
| Consumer counts on at-least-once delivery | Medium — common misunderstanding of NOTIFY | README explicitly documents at-most-once + gap signal; `'error'` listener strongly recommended |

---

## Open question for the implementation plan

- Should `subscribe()` accept an optional `signal: AbortSignal` for cancellation, instead of (or in addition to) `close()`? Modern Node API surfaces frequently take `AbortSignal`. Defer to the implementation plan; doesn't affect the spec.

---

## Related

- [Storage substrate design (2026-05-20)](./2026-05-20-storage-architecture-design.md)
- [Goal 6 progress design (2026-05-21)](./2026-05-21-goal-6-progress-api-design.md)
- [pg-boss#570](https://github.com/timgit/pg-boss/issues/570) — declined upstream request for job lifecycle events
- [Postgres docs — NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- [node-postgres — async notifications](https://node-postgres.com/features/notifications)

codex
I’ve read the full spec. Pulling line references now so each objection is anchored to concrete text rather than general concern.
exec
/bin/zsh -lc 'nl -ba docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
     1	# Goal 7 — Lifecycle event API: design
     2	
     3	**Date:** 2026-05-22
     4	**Sub-issue:** [#8](https://github.com/elfensky/pg-bossier/issues/8)
     5	**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
     6	**Status:** Design — pre-implementation. Builds on the storage substrate (PR #15) and the unified client (2026-05-22). No code yet.
     7	
     8	---
     9	
    10	## Summary
    11	
    12	pg-bossier ships a job-lifecycle event API. Every state transition that the
    13	already-shipped capture trigger writes to `pgbossier.record` is also published
    14	as a Postgres `NOTIFY` on a single pg-bossier-owned channel. Consumers
    15	subscribe via `await bossier.subscribe()`, which returns a typed Node
    16	`EventEmitter` (`BossierEvents`) carrying a thin identity payload — `jobId`,
    17	`queue`, `attempt`, `state`, plus a friendly `event` name and `capturedAt`.
    18	The subscriber auto-reconnects on connection drop and emits an `'error'`
    19	event to signal the gap; full detail for any event is read from
    20	`pgbossier.record` via the already-shipped Goal 5 read API. Delivery contract
    21	is **at most once, with gap signalling** — durable replay is available by
    22	reading the audit table.
    23	
    24	---
    25	
    26	## Context — what is already built
    27	
    28	- **`pgbossier.record`** — the chronicle table, one row per `(job_id, attempt)`. Goal 1 (#2), delivered.
    29	- **`pgbossier.capture()` trigger function + `pgbossier_capture` trigger** on `pgboss.job`, fires `AFTER INSERT OR UPDATE OF state`. Writes the record row inside a `BEGIN…EXCEPTION WHEN OTHERS` block so a pg-bossier failure can never block the underlying pg-boss op (fail-open per issue #1).
    30	- **`install(pool)` / `uninstall(pool)`** — idempotent install (schema + table + indexes + trigger function + trigger + backfill); uninstall is `DROP SCHEMA pgbossier CASCADE`.
    31	- **`bossier({ boss, pool })` client** — a `Proxy` over the pg-boss instance exposing pg-boss's full API plus pg-bossier's own methods on one flat surface. The proxy forwards `.on()` to pg-boss's EventEmitter — meaning pg-bossier's event subscription must live somewhere other than `.on()` to avoid collision.
    32	- **Goal 5 read API** (merged in PR #17) — `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning`. These are the durable read path that backs the at-most-once delivery contract.
    33	- **Goal 6 progress API** — `setProgress` / `getProgress`. Independent of this design; mentioned only as recent prior art for how a goal layers onto the client.
    34	
    35	---
    36	
    37	## Goals and non-goals
    38	
    39	### What this design ships
    40	
    41	1. A Postgres-`NOTIFY`-based transport that fires on every job state transition the existing trigger already captures.
    42	2. A subscription API on the `bossier` client: `await bossier.subscribe()` → typed `BossierEvents`.
    43	3. Six job-event types (`created` / `started` / `completed` / `failed` / `cancelled` / `retried`) plus a catch-all `'job'` and a subscriber-level `'error'`.
    44	4. Auto-reconnect with a one-`'error'`-per-gap signal so consumers can tell when an event stream was interrupted.
    45	5. Integration tests covering the six event types, the catch-all, cross-subscriber broadcast, reconnect after a forced backend termination, idempotent `close()`, and the trigger's fail-open path.
    46	
    47	### What this design deliberately does NOT ship
    48	
    49	- **`terminal_detail` / `expired` / `superseded` markers in the event payload.** That is Goal 2 (#3) territory. The event payload stays the minimal identity-and-state envelope in v1; consumers needing failure detail call `findById(jobId)`.
    50	- **Server-side filtering at subscribe time** (e.g. `subscribe({ queue: 'sync' })`). Consumers filter inside the handler — one line.
    51	- **OpenTelemetry exporters or any observability layer.** Explicit non-goal in issue #1.
    52	- **Automatic catch-up replay on reconnect.** The contract is at-most-once; replay belongs to the consumer using `pgbossier.record`. Rationale in the "Connection-gap handling" decision below.
    53	
    54	---
    55	
    56	## Locked decisions
    57	
    58	### Mechanism — Postgres `LISTEN/NOTIFY` transport with a local typed `EventEmitter` API
    59	
    60	The trigger calls `pg_notify` as it writes each record row. `bossier.subscribe()`
    61	opens a dedicated `pg` connection, runs `LISTEN pgbossier_job`, and re-surfaces
    62	incoming notifications as a typed Node `EventEmitter`.
    63	
    64	**Why not in-process EventEmitter only?** An in-process emitter fed by call
    65	interception in the proxy cannot see every transition. The proxy only sees
    66	calls the consumer makes (`complete`, `fail`). It does not see
    67	`created`→`active` when a worker fetches a job, the retry `DELETE`+`INSERT`,
    68	or pg-boss's maintenance expiring a stalled job. Catching those would mean
    69	reaching into pg-boss internals — the **Forbidden** compatibility tier.
    70	In-process also fails the cross-process requirement: a web UI process never
    71	sees worker events, which is the primary consumer's actual shape.
    72	
    73	**Why not "both"?** "Both" collapses into this approach. The friendly
    74	in-process surface a "both" design would expose *is* the `EventEmitter`
    75	returned by `subscribe()` — it just happens to be fed by NOTIFY rather than by
    76	call interception. Shipping a second, structurally-incomplete mechanism would
    77	be a strictly-worse second code path.
    78	
    79	### Connection-gap handling — at-most-once with auto-reconnect and gap signal
    80	
    81	When the subscriber's connection drops, the events that fired during the gap
    82	are not redelivered by Postgres. The subscriber **auto-reconnects** and
    83	**emits one `'error'`** so the consumer knows a gap happened. Durable replay
    84	is available — by reading `pgbossier.record` — but pg-bossier does not perform
    85	it automatically.
    86	
    87	**Why not automatic replay?** Automatic replay would need a monotonic
    88	sequence column on `pgbossier.record` (none today — `captured_at` is a
    89	timestamp with no uniqueness guarantee), would need cursor tracking, would
    90	need dedup against live events arriving simultaneously, and would weaken the
    91	delivery contract to at-least-once with idempotent-handler requirements. All
    92	real complexity, all already addressable by the consumer reading the audit
    93	table on the rare gap.
    94	
    95	**Why not manual control?** "Expose start/stop/state, no auto-reconnect"
    96	pushes the reconnect loop into every consumer. Most will skip it; a fragile
    97	event stream pushes consumers back toward polling — directly against issue
    98	#1 success criterion #3.
    99	
   100	### Channel — one channel, `pgbossier_job`
   101	
   102	Single channel, all six event types share it. Per-channel `LISTEN` is
   103	essentially free in Postgres, but each new channel means a new line on every
   104	subscriber. The JS side fans out by reading the payload's `state` field.
   105	
   106	Channel name `pgbossier_*` prefix satisfies issue #1's namespacing constraint
   107	and preserves Goal 9's symmetric uninstall (`DROP SCHEMA pgbossier CASCADE`
   108	removes the trigger function, which cascades to drop the trigger, which stops
   109	the notifications).
   110	
   111	### Subscription API — `await bossier.subscribe()` returning a typed EventEmitter
   112	
   113	A new method on the `bossier` client. Async because it opens a connection
   114	and runs `LISTEN`. Returns a `BossierEvents` — a typed wrapper around Node
   115	`EventEmitter` with `on` / `once` / `off` and a `close()` method.
   116	
   117	**Why not `bossier.on('job.failed', …)`?** The `bossier` client is a `Proxy`
   118	over the pg-boss instance, which is itself an `EventEmitter`. The proxy
   119	forwards `.on()` to pg-boss. Adding a namespaced overload would either
   120	require intercepting `.on()` in the proxy (fragile — two emitters
   121	masquerading as one with magic strings) or fundamentally change what
   122	`.on()` means depending on the string. A separate object (`subscribe()`)
   123	keeps each EventEmitter doing one job.
   124	
   125	**Why not a typed-subscriber-object** (`bossier.events.failed.subscribe(h)`)?
   126	It reinvents `EventEmitter` for no real gain. The Node `EventEmitter` contract
   127	is well-understood, has a typed overload pattern, and integrates naturally
   128	with `process.on('SIGINT', …)`-style cleanup.
   129	
   130	### Payload — thin JSON identity envelope
   131	
   132	```json
   133	{ "job_id": "…uuid…", "queue": "sync", "attempt": 2,
   134	  "state": "failed", "captured_at": "2026-05-22T22:34:11.123Z" }
   135	```
   136	
   137	~150 bytes typical, well under the ~8000-byte NOTIFY cap. No `data`, no
   138	`output`, no `terminal_detail`, no `progress` — those live in
   139	`pgbossier.record` and are read on demand via the Goal 5 read API.
   140	
   141	**Why thin?** Postgres caps a NOTIFY payload at ~8000 bytes total. Real
   142	jobs can carry multi-KB `data` / `output` blobs that would routinely exceed
   143	the cap. A thin envelope keeps the per-event SQL cost negligible (relevant
   144	to issue #12's per-event budget) and aligns with the existing "audit row +
   145	typed read" pattern.
   146	
   147	### State→event mapping — done in JS, not SQL
   148	
   149	The trigger emits the raw pg-boss `state` (`created` / `active` / `retry` /
   150	`completed` / `failed` / `cancelled`). The JS subscriber maps `active`→`started`
   151	and `retry`→`retried` (the other four are identity) via a single TS constant.
   152	
   153	**Why JS, not SQL?** Keeps the trigger minimal — no `CASE` expression — and
   154	puts the naming vocabulary in one TypeScript constant that is easy to read
   155	and code-review. The raw `state` field is still in the payload so consumers
   156	correlating events to records have it.
   157	
   158	---
   159	
   160	## Architecture and data flow
   161	
   162	```
   163	pg-boss op (e.g. boss.complete(jobId))
   164	    └─→ UPDATE pgboss.job (state column changes)
   165	          └─→ trigger pgbossier_capture fires (already shipped)
   166	                └─→ pgbossier.capture() runs inside the pg-boss op's transaction:
   167	                      ├── INSERT/UPDATE pgbossier.record      ← already shipped
   168	                      └── pg_notify('pgbossier_job', payload) ← new in Goal 7
   169	                            └─→ on transaction COMMIT, Postgres delivers
   170	                                  └─→ subscriber's LISTENing connection receives it
   171	                                        └─→ pg driver emits 'notification'
   172	                                              └─→ JS parses, maps state→event
   173	                                                    └─→ emits on the EventEmitter
   174	                                                          └─→ consumer's
   175	                                                              events.on('failed', h) runs
   176	```
   177	
   178	Properties that fall out of this shape:
   179	
   180	- **One capture point.** The audit row write and the notify both live in the same trigger and the same transaction — they commit or roll back together. The event stream cannot claim a transition that didn't actually happen.
   181	- **No new pg-boss surface dependency.** Goal 7 depends on Postgres' documented `pg_notify` and `LISTEN` — *not* on any pg-boss surface. No `COMPATIBILITY.md` tier change.
   182	- **Idempotent install.** `CREATE OR REPLACE FUNCTION` in `install()` upgrades the trigger function in place on existing installs. No data migration.
   183	- **Symmetric uninstall.** `DROP SCHEMA pgbossier CASCADE` drops the function; the trigger that depends on it cascades away too. No regression vs Goal 9.
   184	
   185	---
   186	
   187	## SQL side — trigger change
   188	
   189	The change to `pgbossier.capture()` is one `PERFORM pg_notify(...)` inside
   190	the existing `BEGIN…EXCEPTION WHEN OTHERS` block, placed *after* the record
   191	INSERT/UPDATE.
   192	
   193	```sql
   194	CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
   195	LANGUAGE plpgsql AS $$
   196	BEGIN
   197	  BEGIN
   198	    INSERT INTO pgbossier.record
   199	      (job_id, queue, attempt, state, data, output,
   200	       created_on, started_on, completed_on, captured_at)
   201	    VALUES
   202	      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
   203	       NEW.created_on, NEW.started_on, NEW.completed_on, now())
   204	    ON CONFLICT (job_id, attempt) DO UPDATE SET
   205	      state        = EXCLUDED.state,
   206	      data         = EXCLUDED.data,
   207	      output       = EXCLUDED.output,
   208	      created_on   = EXCLUDED.created_on,
   209	      started_on   = EXCLUDED.started_on,
   210	      completed_on = EXCLUDED.completed_on;
   211	
   212	    -- NEW: publish a thin lifecycle event.
   213	    PERFORM pg_notify(
   214	      'pgbossier_job',
   215	      json_build_object(
   216	        'job_id',      NEW.id,
   217	        'queue',       NEW.name,
   218	        'attempt',     NEW.retry_count,
   219	        'state',       NEW.state,
   220	        'captured_at', now()
   221	      )::text
   222	    );
   223	  EXCEPTION WHEN OTHERS THEN
   224	    RAISE WARNING 'pgbossier: capture failed for job %: %', NEW.id, SQLERRM;
   225	  END;
   226	  RETURN NULL;
   227	END;
   228	$$;
   229	```
   230	
   231	Three notes:
   232	
   233	1. **Order.** `pg_notify` after the INSERT. If `pg_notify` were to fail (vanishingly unlikely with a ~150-byte payload — only payload-too-long is realistic), PL/pgSQL's implicit savepoint rolls back the INSERT too. So: either both the record row and the event happen, or neither does.
   234	2. **Fail-open.** Any failure inside the inner `BEGIN` is caught by the existing `EXCEPTION WHEN OTHERS` block. The pg-boss op proceeds unaffected. Same contract Goal 1 already promises.
   235	3. **Same transaction.** `pg_notify` queues the notification; Postgres only sends it on commit. A rolled-back pg-boss op produces no event, exactly like it produces no audit row.
   236	
   237	---
   238	
   239	## JS side — API surface
   240	
   241	### Public types (exported from `src/index.ts`)
   242	
   243	```ts
   244	export type JobEventName =
   245	  | 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'retried';
   246	
   247	export interface JobEvent {
   248	  event: JobEventName;          // friendly event name
   249	  jobId: string;                // matches pgbossier.record.job_id
   250	  queue: string;
   251	  attempt: number;
   252	  state: JobState;              // raw pg-boss state — mirrors JobRecord.state
   253	  capturedAt: Date;             // parsed from the payload's captured_at
   254	}
   255	
   256	export interface BossierEvents extends EventEmitter {
   257	  on<K extends keyof BossierEventsMap>(
   258	    name: K, listener: (...args: BossierEventsMap[K]) => void
   259	  ): this;
   260	  once<K extends keyof BossierEventsMap>(
   261	    name: K, listener: (...args: BossierEventsMap[K]) => void
   262	  ): this;
   263	  off<K extends keyof BossierEventsMap>(
   264	    name: K, listener: (...args: BossierEventsMap[K]) => void
   265	  ): this;
   266	  /** Stops reconnecting, releases the dedicated connection. Idempotent. */
   267	  close(): Promise<void>;
   268	}
   269	
   270	interface BossierEventsMap {
   271	  created:   [JobEvent];
   272	  started:   [JobEvent];
   273	  completed: [JobEvent];
   274	  failed:    [JobEvent];
   275	  cancelled: [JobEvent];
   276	  retried:   [JobEvent];
   277	  job:   [JobEvent];   // catch-all — every transition
   278	  error: [Error];      // subscriber-level — connection drop, parse error, handler throw
   279	}
   280	```
   281	
   282	### Client method
   283	
   284	```ts
   285	// in BossierMethods (src/client.ts)
   286	/**
   287	 * Open a subscription to job-lifecycle events. Holds one dedicated
   288	 * pool connection until close() is called. Auto-reconnects on
   289	 * connection drop and emits 'error' to signal the gap; durable replay
   290	 * is available by reading pgbossier.record.
   291	 */
   292	subscribe(): Promise<BossierEvents>;
   293	```
   294	
   295	### Typical usage
   296	
   297	```ts
   298	const client = bossier({ boss, pool });
   299	const events = await client.subscribe();
   300	
   301	events.on('failed', e => log.warn(`job ${e.jobId} failed on attempt ${e.attempt}`));
   302	events.on('job',    e => metrics.transition.inc({ event: e.event, queue: e.queue }));
   303	events.on('error',  err => log.warn({ err }, 'event-stream gap or parse error'));
   304	
   305	// graceful shutdown
   306	process.on('SIGINT', async () => { await events.close(); await boss.stop(); });
   307	```
   308	
   309	---
   310	
   311	## Connection lifecycle and reconnect
   312	
   313	- **Connection acquisition.** `pool.connect()` returns a dedicated `PoolClient`; the subscriber holds it for its lifetime. Documented in the README: each live subscriber holds one pool connection, size pools accordingly.
   314	- **Listen.** On connect, register a `'notification'` handler, then run `LISTEN pgbossier_job`.
   315	- **Reconnect loop.** If the underlying client emits `'error'` or `'end'` and `close()` has not been called: `release(err)` the dead client → wait a fixed `1000ms` → `pool.connect()` again → re-`LISTEN`. After a successful re-LISTEN, emit one `'error'` so the consumer knows a gap happened. Retry forever until either it succeeds or `close()` is called.
   316	- **`close()`.** Sets a `closed` flag (prevents further reconnection), releases the live client back to the pool, resolves once the connection is fully released. Idempotent — calling `close()` twice resolves immediately.
   317	
   318	| Event | What pg-bossier does | What the consumer sees |
   319	|---|---|---|
   320	| Network blip / client drop | Auto-reconnect after 1s, re-LISTEN | One `'error'` per gap |
   321	| Postgres restart | Auto-reconnect when DB is back | One `'error'`, then events resume |
   322	| Handler throws | Caught, routed to `'error'` if a listener is registered | `'error'` with the thrown value |
   323	| Malformed notification JSON | Logged + `'error'`, drop that one, stream continues | `'error'` with parse error |
   324	| `close()` called | Stop reconnecting, release client | Nothing further |
   325	
   326	**Why fixed 1s delay, not exponential backoff?** YAGNI in v1. A subscriber
   327	holds one connection; a hard reconnect storm against a single pool from a
   328	single subscriber is not a real risk. If real-world experience surfaces a
   329	need, exponential backoff is a small follow-up that doesn't break the API.
   330	
   331	---
   332	
   333	## Error handling and fail-open boundaries
   334	
   335	Three failure surfaces, three rules:
   336	
   337	1. **Inside the trigger (SQL side).** Caught by the existing `EXCEPTION WHEN OTHERS` block. `RAISE WARNING`, swallowed. *Non-negotiable per issue #1.*
   338	2. **Inside the subscriber (JS side, library code).** Connection drops, re-`LISTEN` failures, JSON parse errors → emit `'error'`, never throw.
   339	3. **Inside the consumer's handler.** Follow Node `EventEmitter`'s contract: a thrown handler is routed to the `'error'` listener if one is registered; otherwise it propagates (Node-standard). README strongly recommends registering an `'error'` listener.
   340	
   341	Clean rule that falls out: *pg-bossier never breaks pg-boss, never silently
   342	throws in the consumer's process, never hides what went wrong from a consumer
   343	who chooses to listen.*
   344	
   345	---
   346	
   347	## Testing strategy
   348	
   349	`test/events.test.ts` — `vitest` + `@testcontainers/postgresql`, real
   350	Postgres + pg-boss 12.18.2, no mocks. Continues the existing pattern.
   351	
   352	1. **Happy path.** Subscribe; submit and complete a job via pg-boss; assert `'started'` then `'completed'` arrive with expected `jobId`/`queue`/`attempt`/`state`/`event`.
   353	2. **All six event types.** One test per `created` / `started` / `completed` / `failed` / `cancelled` / `retried`. `failed` + `retried` use a worker that throws on a job configured with retries.
   354	3. **Catch-all `'job'` event.** A single `'job'` listener sees all six transitions for a job.
   355	4. **Cross-subscriber broadcast.** Two `subscribe()` instances on the same pool both receive every event (stand-in for the multi-process case — sufficient because Postgres NOTIFY broadcasts to every LISTENer).
   356	5. **`close()` is clean.** No further events after `close()`; the pool's connection count returns to its pre-subscribe value; calling `close()` twice doesn't throw.
   357	6. **Reconnect after drop.** Use `pg_terminate_backend(pid)` from a second connection to kill the subscriber's backend; assert one `'error'` fires; assert events flow once reconnected; assert no events leak from the dead connection.
   358	7. **Trigger fail-open.** Provoke a `pg_notify` failure path (an out-of-band oversized payload via a separate test-only `PERFORM`) and confirm the pg-boss op still succeeds.
   359	8. **No Forbidden imports.** A static-grep test asserts `src/events.ts` imports only from `pg` and Node built-ins (`node:events`), never from `pg-boss/src/*`.
   360	
   361	**Performance probe (informational, not a release gate).** Submit N jobs
   362	(say N=1000) and measure per-transition wall-clock with and without
   363	pg-bossier installed. Lands as a number alongside issue #12.
   364	
   365	---
   366	
   367	## File layout
   368	
   369	**New**
   370	- `src/events.ts` — `BossierEvents` class, `JobEvent` type, `subscribe(pool)` factory, state→event map, reconnect loop.
   371	- `test/events.test.ts` — integration tests above.
   372	
   373	**Changed**
   374	- `src/sql.ts` — `CAPTURE_FUNCTION_SQL` gains the `pg_notify(...)` `PERFORM`.
   375	- `src/install.ts` — no code change. `CREATE OR REPLACE FUNCTION` already upgrades the trigger function idempotently on re-install.
   376	- `src/client.ts` — `BossierMethods` gains `subscribe()`; methods map adds it.
   377	- `src/index.ts` — re-exports `BossierEvents`, `JobEvent`, `JobEventName`.
   378	- `CHANGELOG.md` — entry under `## [Unreleased]` → `Added`.
   379	- `CLAUDE.md` — project-status paragraph notes Goal 7 delivered, #8 closed.
   380	- `COMPATIBILITY.md` — no tier change; document `pgbossier_job` as a published channel name (for consumers who want to LISTEN themselves outside JS, e.g. from a non-Node service).
   381	- `README.md` — new section under "Operational API" describing `subscribe()` and the events.
   382	
   383	---
   384	
   385	## Compatibility tier impact
   386	
   387	No change to `COMPATIBILITY.md`. Goal 7 introduces no new pg-boss surface
   388	dependency:
   389	
   390	- `pg_notify` and `LISTEN` are documented Postgres features (effectively "Stable" Postgres surface — analogous to the Stable tier for pg-boss).
   391	- The trigger function is in the `pgbossier` schema, owned by pg-bossier.
   392	- The channel name `pgbossier_job` is pg-bossier-owned per issue #1's namespacing constraint.
   393	
   394	The `pg-boss` API surface used by pg-bossier is unchanged from the substrate.
   395	
   396	---
   397	
   398	## Out of v1 (deliberately, with reasons)
   399	
   400	- **`terminal_detail` / `expired` / `superseded` markers in payloads.** Goal 2 (#3) territory. v1 payload stays the identity envelope; consumers needing failure detail call `findById(jobId)`. When Goal 2 ships, the payload can grow inside the 8KB cap.
   401	- **Server-side filtering** (`subscribe({ queue: 'sync' })`). Consumers filter inside the handler with one line — `if (e.queue !== 'sync') return;`. YAGNI in v1.
   402	- **Automatic catch-up replay** on reconnect. Decided in the locked-decisions section above. Available to the consumer today via `pgbossier.record`.
   403	- **Exponential backoff** on reconnect. Fixed 1s delay in v1. Trivial to add later without breaking the API.
   404	- **OpenTelemetry exporters or any observability stack.** Explicit non-goal in issue #1; consumers build observability on top of the event substrate.
   405	
   406	---
   407	
   408	## Open dependencies (cross-cutting issues)
   409	
   410	- **#12 — per-event performance budget.** Goal 7 adds one `pg_notify(text, text)` call per transition to the existing trigger. The performance probe in the testing section produces a measurement for #12 to argue from. This design does not block on #12 — it produces the number #12 needs.
   411	- **#13 — TypeScript generics surface.** `JobEvent` here is **not** parameterized on `TInput` / `TOutput`, because the payload deliberately omits `data` / `output`. When #13 settles the generics pattern, the *follow-up read* (`findById`) is the typed surface; the event remains the identity envelope.
   412	
   413	---
   414	
   415	## Risks and mitigations
   416	
   417	| Risk | Likelihood | Mitigation |
   418	|---|---|---|
   419	| Real-world `pg_notify` payload exceeds 8KB | Very low — payload is bounded ~150 bytes by construction | Static envelope shape; no consumer-controlled fields enter the payload |
   420	| Subscriber's pool exhausted by held connection | Low — one connection per live subscriber | Documented in README; tests verify connection count returns to baseline on `close()` |
   421	| Handler throws and crashes the consumer's process | Medium — Node default if no `'error'` listener | Strongly documented; tests verify `'error'` routing |
   422	| Reconnect storm against Postgres | Low — single subscriber, single connection | Fixed 1s delay; exponential backoff as a future-compatible extension |
   423	| Future addition of more channels collides with pg-boss | Low — `pgbossier_*` prefix is reserved | Channel-name convention documented in `COMPATIBILITY.md` |
   424	| Consumer counts on at-least-once delivery | Medium — common misunderstanding of NOTIFY | README explicitly documents at-most-once + gap signal; `'error'` listener strongly recommended |
   425	
   426	---
   427	
   428	## Open question for the implementation plan
   429	
   430	- Should `subscribe()` accept an optional `signal: AbortSignal` for cancellation, instead of (or in addition to) `close()`? Modern Node API surfaces frequently take `AbortSignal`. Defer to the implementation plan; doesn't affect the spec.
   431	
   432	---
   433	
   434	## Related
   435	
   436	- [Storage substrate design (2026-05-20)](./2026-05-20-storage-architecture-design.md)
   437	- [Goal 6 progress design (2026-05-21)](./2026-05-21-goal-6-progress-api-design.md)
   438	- [pg-boss#570](https://github.com/timgit/pg-boss/issues/570) — declined upstream request for job lifecycle events
   439	- [Postgres docs — NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
   440	- [node-postgres — async notifications](https://node-postgres.com/features/notifications)

web search: 
web search: PostgreSQL NOTIFY prepared transaction not allowed official docs
web search: 
web search: site:postgresql.org NOTIFY not replicated standby official docs
web search: 
web search: https://www.pgbouncer.org/features.html
codex
# Codex critique — Round 1

1. **LISTEN/NOTIFY transport choice**
   The spec underplays the scaling cost of “one dedicated `pg` connection” per subscriber ([lines 60-62](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L60), [313-315](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L313)). That is fine for a few workers, but bad for fleets, CLIs, and sidecars. It also ignores two real deployment traps: `LISTEN` is incompatible with PgBouncer transaction pooling, and notifications are not a replicated durable stream, so primary failover loses in-flight notifications and all session-local `LISTEN` registrations.

2. **At-most-once contract + gap signal**
   This is the biggest design hole. The spec says gaps are recoverable by reading `pgbossier.record` ([lines 81-93](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L81)), but `pgbossier.record` is “one row per `(job_id, attempt)`” ([line 28](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L28)) and the trigger does `ON CONFLICT ... DO UPDATE` on that row ([lines 198-210](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L198)). So a missed `started` event is overwritten by `completed`; there is no durable per-transition log to replay from. Even ignoring that, the consumer has no correct cursor: `captured_at` is explicitly non-unique ([lines 87-90](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L87)), and the reconnect path emits `'error'` only *after* re-`LISTEN` succeeds ([line 315](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L315)), so there is no unambiguous lower/upper bound for catch-up.

3. **Thin payload + follow-up read pattern**
   The spec normalizes “consumers needing failure detail call `findById(jobId)`” ([line 49](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L49), [137-145](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L137)). That is not just read amplification; it is semantically lossy. Because the backing row is mutable per attempt, a follow-up read can observe a later state than the notification that triggered it. At 1000 events/sec, “1 NOTIFY + 1 SELECT per consumer event” becomes a fan-out multiplier on the same database the queue already depends on. A slightly fatter payload for small immutable fields like `terminal_detail` would reduce both load and race exposure.

4. **`pg_notify` inside trigger placement**
   The claim that the row insert and notify “commit or roll back together” ([lines 180, 233-235](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L180)) is too absolute. A transaction that executed `NOTIFY` cannot be prepared for 2PC, so this design introduces an undocumented incompatibility with prepared transactions. After failover, notifications generated on the old primary are not replayed to listeners on the new primary, so the “same transaction” property does not translate into cluster-level delivery semantics. The spec also never discusses the listener-side rule that notifications are only delivered between transactions, so a consumer using the same connection incorrectly can delay receipt indefinitely.

5. **Auto-reconnect with fixed 1s delay forever**
   The spec says “Retry forever” with a fixed 1000ms delay ([line 315](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L315)) and dismisses storm risk as “not a real risk” ([lines 326-329](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L326)). That is not credible once there are multiple subscribers or multiple crashed pods. A 30-minute outage is 1800 attempts per subscriber. This needs exponential backoff, jitter, and a terminal state/health signal.

6. **`BossierEvents extends EventEmitter` API shape**
   The TypeScript surface is only partially typed: `on`/`once`/`off` are overloaded, but `addListener`, `removeListener`, `prependListener`, `rawListeners`, and tooling that interacts through the broader `EventEmitter` API are not ([lines 256-279](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L256)). More seriously, the spec misstates Node semantics: “Handler throws | Caught, routed to `'error'`” ([line 322](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L322)) is not how ordinary `EventEmitter` listeners behave. Either the implementation departs from standard `EventEmitter`, or the spec is wrong. `close(): Promise<void>` is workable, but the open question at [line 430](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L430) is real: `AbortSignal` or `Symbol.asyncDispose` would compose better with modern Node cleanup.

7. **State→event mapping in JS, not SQL**
   Carrying both raw `state` and derived `event` splits authority ([lines 149-156](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L149), [247-253](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L247)). If a future pg-boss version introduces a new state, the subscriber’s TS constant has no defined behavior. The consumer will see one of three bad outcomes: the event is dropped, `'job'` is emitted with `event: undefined`, or the mapper throws and the library emits `'error'` for a valid database state. That is a source-of-truth bug, not just naming convenience.

8. **Issue #1 violations**
   The spec quietly violates the load-bearing performance constraint. The charter says the per-event budget is a release gate; this spec says the performance probe is “informational, not a release gate” ([lines 361-363](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L361)) and “does not block on #12” ([line 410](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L410)). That directly conflicts with the stated charter constraint. Also, claiming durable replay from `pgbossier.record` while storing only the latest row per attempt is materially misleading for an “operational data plane”.

9. **Test plan false confidence**
   `pg_terminate_backend` tests only one failure mode: abrupt backend death on a healthy primary ([line 357](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L357)). It does not cover PgBouncer transaction pooling, failover to a new primary, a subscriber stuck in a long transaction delaying delivery, reconnect storms, or notification-queue saturation where `NOTIFY` starts failing at commit. The proposed cross-subscriber test is also too weak: “same pool” is not a stand-in for real deployment boundaries when the whole design depends on session semantics ([line 355](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L355)).

10. **Missing from v1**
   v1 is missing four things the rest of the design implicitly needs:
   1. A durable monotonic event cursor if gap recovery is going to be advertised at all.
   2. An explicit unsupported-environments section for PgBouncer transaction pooling, standbys, and failover semantics.
   3. A bounded reconnect policy with jitter/backoff and observable subscriber state.
   4. A payload/versioning rule for forward compatibility when pg-boss state names evolve.

External checks: [PostgreSQL `LISTEN`](https://www.postgresql.org/docs/18/sql-listen.html), [PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html), [PostgreSQL `PREPARE TRANSACTION`](https://www.postgresql.org/docs/current/static/sql-prepare-transaction.html), [PgBouncer feature matrix](https://www.pgbouncer.org/features.html)

BLOCK UNTIL the design defines a correct durable replay boundary for gaps, stops treating #12 as informational, and documents the transport’s unsupported/failover semantics explicitly
tokens used
54,446
# Codex critique — Round 1

1. **LISTEN/NOTIFY transport choice**
   The spec underplays the scaling cost of “one dedicated `pg` connection” per subscriber ([lines 60-62](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L60), [313-315](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L313)). That is fine for a few workers, but bad for fleets, CLIs, and sidecars. It also ignores two real deployment traps: `LISTEN` is incompatible with PgBouncer transaction pooling, and notifications are not a replicated durable stream, so primary failover loses in-flight notifications and all session-local `LISTEN` registrations.

2. **At-most-once contract + gap signal**
   This is the biggest design hole. The spec says gaps are recoverable by reading `pgbossier.record` ([lines 81-93](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L81)), but `pgbossier.record` is “one row per `(job_id, attempt)`” ([line 28](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L28)) and the trigger does `ON CONFLICT ... DO UPDATE` on that row ([lines 198-210](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L198)). So a missed `started` event is overwritten by `completed`; there is no durable per-transition log to replay from. Even ignoring that, the consumer has no correct cursor: `captured_at` is explicitly non-unique ([lines 87-90](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L87)), and the reconnect path emits `'error'` only *after* re-`LISTEN` succeeds ([line 315](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L315)), so there is no unambiguous lower/upper bound for catch-up.

3. **Thin payload + follow-up read pattern**
   The spec normalizes “consumers needing failure detail call `findById(jobId)`” ([line 49](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L49), [137-145](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L137)). That is not just read amplification; it is semantically lossy. Because the backing row is mutable per attempt, a follow-up read can observe a later state than the notification that triggered it. At 1000 events/sec, “1 NOTIFY + 1 SELECT per consumer event” becomes a fan-out multiplier on the same database the queue already depends on. A slightly fatter payload for small immutable fields like `terminal_detail` would reduce both load and race exposure.

4. **`pg_notify` inside trigger placement**
   The claim that the row insert and notify “commit or roll back together” ([lines 180, 233-235](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L180)) is too absolute. A transaction that executed `NOTIFY` cannot be prepared for 2PC, so this design introduces an undocumented incompatibility with prepared transactions. After failover, notifications generated on the old primary are not replayed to listeners on the new primary, so the “same transaction” property does not translate into cluster-level delivery semantics. The spec also never discusses the listener-side rule that notifications are only delivered between transactions, so a consumer using the same connection incorrectly can delay receipt indefinitely.

5. **Auto-reconnect with fixed 1s delay forever**
   The spec says “Retry forever” with a fixed 1000ms delay ([line 315](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L315)) and dismisses storm risk as “not a real risk” ([lines 326-329](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L326)). That is not credible once there are multiple subscribers or multiple crashed pods. A 30-minute outage is 1800 attempts per subscriber. This needs exponential backoff, jitter, and a terminal state/health signal.

6. **`BossierEvents extends EventEmitter` API shape**
   The TypeScript surface is only partially typed: `on`/`once`/`off` are overloaded, but `addListener`, `removeListener`, `prependListener`, `rawListeners`, and tooling that interacts through the broader `EventEmitter` API are not ([lines 256-279](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L256)). More seriously, the spec misstates Node semantics: “Handler throws | Caught, routed to `'error'`” ([line 322](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L322)) is not how ordinary `EventEmitter` listeners behave. Either the implementation departs from standard `EventEmitter`, or the spec is wrong. `close(): Promise<void>` is workable, but the open question at [line 430](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L430) is real: `AbortSignal` or `Symbol.asyncDispose` would compose better with modern Node cleanup.

7. **State→event mapping in JS, not SQL**
   Carrying both raw `state` and derived `event` splits authority ([lines 149-156](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L149), [247-253](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L247)). If a future pg-boss version introduces a new state, the subscriber’s TS constant has no defined behavior. The consumer will see one of three bad outcomes: the event is dropped, `'job'` is emitted with `event: undefined`, or the mapper throws and the library emits `'error'` for a valid database state. That is a source-of-truth bug, not just naming convenience.

8. **Issue #1 violations**
   The spec quietly violates the load-bearing performance constraint. The charter says the per-event budget is a release gate; this spec says the performance probe is “informational, not a release gate” ([lines 361-363](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L361)) and “does not block on #12” ([line 410](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L410)). That directly conflicts with the stated charter constraint. Also, claiming durable replay from `pgbossier.record` while storing only the latest row per attempt is materially misleading for an “operational data plane”.

9. **Test plan false confidence**
   `pg_terminate_backend` tests only one failure mode: abrupt backend death on a healthy primary ([line 357](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L357)). It does not cover PgBouncer transaction pooling, failover to a new primary, a subscriber stuck in a long transaction delaying delivery, reconnect storms, or notification-queue saturation where `NOTIFY` starts failing at commit. The proposed cross-subscriber test is also too weak: “same pool” is not a stand-in for real deployment boundaries when the whole design depends on session semantics ([line 355](file:///Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md#L355)).

10. **Missing from v1**
   v1 is missing four things the rest of the design implicitly needs:
   1. A durable monotonic event cursor if gap recovery is going to be advertised at all.
   2. An explicit unsupported-environments section for PgBouncer transaction pooling, standbys, and failover semantics.
   3. A bounded reconnect policy with jitter/backoff and observable subscriber state.
   4. A payload/versioning rule for forward compatibility when pg-boss state names evolve.

External checks: [PostgreSQL `LISTEN`](https://www.postgresql.org/docs/18/sql-listen.html), [PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html), [PostgreSQL `PREPARE TRANSACTION`](https://www.postgresql.org/docs/current/static/sql-prepare-transaction.html), [PgBouncer feature matrix](https://www.pgbouncer.org/features.html)

BLOCK UNTIL the design defines a correct durable replay boundary for gaps, stops treating #12 as informational, and documents the transport’s unsupported/failover semantics explicitly
