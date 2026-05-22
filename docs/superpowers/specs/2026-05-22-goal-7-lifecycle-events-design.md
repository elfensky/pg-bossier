# Goal 7 — Lifecycle event API: design

**Date:** 2026-05-22 (v1) · 2026-05-23 (v2)
**Sub-issue:** [#8](https://github.com/elfensky/pg-bossier/issues/8)
**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
**Status:** Design **v2** — pre-implementation. Incorporates findings from the
2026-05-23 4-way adversarial review (Codex / Gemini / Sonnet / Opus);
synthesis and raw critiques live in
[`docs/superpowers/debates/2026-05-23-goal-7-spec-adversarial-review/`](../debates/2026-05-23-goal-7-spec-adversarial-review/).
Builds on the storage substrate (PR #15) and the unified client (2026-05-22).
No code yet.

---

## Revisions

- **v2 (2026-05-23)** — Adversarial-review pass. Material changes:
  - Added `seq BIGINT` monotonic event sequence to `pgbossier.record` (advanced on every INSERT *and* every UPDATE via `nextval` from a dedicated sequence). Included in the NOTIFY payload. New `getEventsSince(seq)` catch-up read method on the `bossier` client.
  - Honestly scoped "durable replay" to **final-state-per-attempt recovery**. The `ON CONFLICT (job_id, attempt) DO UPDATE` upsert overwrites intermediate state transitions within a single attempt — the audit table is a current-state table, not a transition log.
  - PgBouncer transaction-pool mode named as an **unsupported** topology — it silently breaks `LISTEN`.
  - Reconnect changed from fixed 1 s to **exponential backoff** (1 s → 30 s cap) with **±20 % jitter**.
  - `'error'` event carries `{ reason: 'gap' | 'parse' | 'handler', error: unknown, at: Date }`.
  - `'error'` listener typed `[unknown]`, not `[Error]`.
  - New **`'connected'` event** on every successful `LISTEN` — silent-failure canary for PgBouncer / failover.
  - New **`'warning'` event** (distinct from `'error'`) — fires once per previously-unseen pg-boss state value. Carries `{ unknownState, jobId }`.
  - Unknown-`state` fallback specified: `event = state` pass-through, emit on the `'job'` catch-all only, fire `'warning'` once per unknown state value.
  - Performance probe becomes a **conditional release gate** tied to #12, not "informational."
  - SQL-side `pg_notify` silent-gap class documented in the Risks table.
  - `attempt` semantics per event type documented with worked examples.
  - Per-type events fire **before** `'job'` for the same transition (ordering specified).
  - Reconnect `closed`-race locked down — wait is cancellable; `closed` check between wait and `pool.connect()`.
  - Added `AbortSignal` to `subscribe({ signal })` and `Symbol.asyncDispose` on `BossierEvents`.
  - Backfill behavior named: `install()` backfill goes directly into `pgbossier.record`, bypassing the trigger — so no events fire for historical rows on first install.
  - Failover behavior + `target_session_attrs=read-write` recommendation in `COMPATIBILITY.md`.
- **v1 (2026-05-22)** — Initial design. Locked the mechanism (LISTEN/NOTIFY transport + typed `EventEmitter` API), the at-most-once delivery contract, the thin-payload + follow-up-read pattern, and the subscription API home on the `bossier` client.

---

## Summary

pg-bossier ships a job-lifecycle event API. Every state transition the
already-shipped capture trigger writes to `pgbossier.record` is also
published as a Postgres `NOTIFY` on a single pg-bossier-owned channel.
Each notification carries a thin identity envelope plus a monotonic
`seq` value advanced on every transition. Consumers subscribe via
`await bossier.subscribe()`, which returns a typed Node `EventEmitter`
(`BossierEvents`) emitting per-event-type listeners plus a `'job'`
catch-all, `'connected'`, `'warning'`, and `'error'`. The subscriber
auto-reconnects with exponential backoff + jitter and emits `'error'`
with `{ reason: 'gap' | 'parse' | 'handler', error, at }` to signal
gaps. Catch-up after a gap is performed by reading
`pgbossier.record WHERE seq > <last_seen>` (or via the
`getEventsSince(seq)` helper). Delivery contract is **at most once,
with gap signalling**; durable replay is available for the
**final state of each attempt** — not for intermediate transitions
within an attempt (the audit table upserts each `(job_id, attempt)`).

---

## Context — what is already built

- **`pgbossier.record`** — chronicle table, one row per `(job_id, attempt)`. Goal 1 (#2), delivered. **v2 adds:** `seq BIGINT NOT NULL` populated from a dedicated sequence on every INSERT and every UPDATE; indexed for cursor reads.
- **`pgbossier.capture()` trigger function + `pgbossier_capture` trigger** on `pgboss.job`, fires `AFTER INSERT OR UPDATE OF state`. Writes the record row inside a `BEGIN…EXCEPTION WHEN OTHERS` block so a pg-bossier failure never blocks the underlying pg-boss op (fail-open per issue #1). **v2 extends:** the same trigger publishes a `NOTIFY` carrying the post-upsert `seq`.
- **`install(pool)` / `uninstall(pool)`** — idempotent install (schema + sequence + table + indexes + trigger function + trigger + backfill); uninstall is `DROP SCHEMA pgbossier CASCADE`. **v2 adds:** sequence creation + `ALTER TABLE … ADD COLUMN IF NOT EXISTS seq` for existing installs.
- **`bossier({ boss, pool })` client** — `Proxy` over the pg-boss instance exposing pg-boss's full API plus pg-bossier's own methods on one flat surface. The proxy forwards `.on()` to pg-boss's `EventEmitter`, so pg-bossier's event subscription lives on a separate `subscribe()` method.
- **Goal 5 read API** (PR #17) — `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning`. The durable read path that backs the catch-up contract. **v2 extends with:** `getEventsSince(seq)`.
- **Goal 6 progress API** — `setProgress` / `getProgress`. Independent; mentioned only as prior art.

---

## Goals and non-goals

### What this design ships (v2)

1. A Postgres-`NOTIFY`-based transport that fires on every job state transition the existing trigger captures.
2. A subscription API on the `bossier` client: `await bossier.subscribe({ signal? })` → typed `BossierEvents`.
3. Six job-event types — `created` / `started` / `completed` / `failed` / `cancelled` / `retried` — plus a catch-all `'job'`, a silent-failure-canary `'connected'`, a forward-compat `'warning'`, and a discriminated `'error'`.
4. Auto-reconnect with **exponential backoff + jitter** and a per-gap `'error'` signal carrying `{ reason, error, at }`.
5. A monotonic `seq` column on `pgbossier.record` and a `getEventsSince(seq)` catch-up read method.
6. Idempotent install + symmetric uninstall preserved (no Goal 9 regression).
7. Integration tests covering every event type, the catch-all, cross-subscriber broadcast, reconnect under multiple failure modes, idempotent `close()`, fail-open SQL path, idle-session timeouts, notification flood, and forward-compat unknown-state behavior.

### What this design deliberately does NOT ship

- **`terminal_detail` / `expired` / `superseded` markers in the event payload.** Goal 2 (#3) territory. Payload stays the identity-plus-`seq` envelope; consumers needing failure detail call `findById(jobId)`.
- **Reconstruction of intermediate state transitions within an attempt after a gap.** The audit table upserts each `(job_id, attempt)` — when a gap is followed by a catch-up read, only the *latest* state per attempt is recoverable. A `created → active → completed` sequence that fired entirely during a gap is recoverable as "this attempt is completed"; the `created` and `active` intermediate moments are not in the audit table. (Live events deliver all transitions; this limitation applies only to catch-up after a gap.)
- **Server-side filtering at subscribe time** (e.g. `subscribe({ queue: 'sync' })`). Consumers filter inside the handler.
- **Channel-name parameterization for multi-tenancy.** pg-boss itself doesn't support multi-instance-per-database; one `pgbossier` install per database.
- **OpenTelemetry exporters or any observability layer.** Explicit non-goal in issue #1.

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
returned by `subscribe()` — it just happens to be fed by NOTIFY rather than
by call interception.

### Connection-gap handling — at-most-once with auto-reconnect, gap signal, and `seq`-cursor catch-up

When the subscriber's connection drops, events that fired during the gap are
not redelivered by Postgres. The subscriber **auto-reconnects** with
exponential backoff and emits `'error'` with `reason: 'gap'` so the consumer
knows a gap happened. **Durable replay** is performed by the consumer via
`getEventsSince(seq)` — which reads `pgbossier.record WHERE seq > <last_seen>`
ordered by `seq`. The consumer maintains a `lastSeq` cursor across events.

**Replay scope (v2 honest framing).** The audit table is a **current-state
table**, not a transition log: each `(job_id, attempt)` is one row,
upserted in place on every transition. So `getEventsSince(seq)` recovers
the *latest* state of every attempt whose row was touched after the
cursor — *not* the full sequence of states a single attempt passed
through. If a gap occurs while a job goes `created → active → completed`
within one attempt, the catch-up surfaces "this attempt is completed"
but cannot reconstruct the `created` and `active` moments. Live events
deliver all transitions; this scope applies only to catch-up after a
gap.

A v2.x follow-up sub-issue (not v1 scope) can revisit append-only
schema if real consumers surface a need for intermediate-transition
replay.

**Why not full automatic replay?** Automatic replay would conflict with
the at-most-once contract (live events arriving during the catch-up read
would race the replay set), and would require dedup state pg-bossier
doesn't own. The consumer-driven `getEventsSince(seq)` pattern lets the
consumer dedup against their own state, which is the only place they can.

### Channel — one channel, `pgbossier_job`

Single channel; all six event types share it. The JS side fans out by
reading the payload's `state` field. `pgbossier_*` prefix satisfies issue
#1's namespacing constraint and preserves Goal 9's symmetric uninstall.

### Subscription API — `await bossier.subscribe({ signal? })` returning a typed EventEmitter

A new method on the `bossier` client. Async because it opens a connection
and runs `LISTEN`. Returns a `BossierEvents` — a typed `EventEmitter` with
`on` / `once` / `off`, `close()`, and `Symbol.asyncDispose` for
`await using` syntax. Accepts an optional `AbortSignal` whose abort
triggers `close()`.

**Why not `bossier.on('job.failed', …)`?** The `bossier` client is a `Proxy`
over the pg-boss instance, which is itself an `EventEmitter`. The proxy
forwards `.on()` to pg-boss. A separate `subscribe()` keeps each
EventEmitter doing one job.

### Payload — thin JSON identity envelope plus `seq`

```json
{ "job_id": "…uuid…", "queue": "sync", "attempt": 2,
  "state": "failed", "seq": 1734829,
  "captured_at": "2026-05-23T10:14:33.456Z" }
```

~160 bytes typical, well under the ~8000-byte NOTIFY cap. No `data`, no
`output`, no `terminal_detail`, no `progress` — those live in
`pgbossier.record` and are read on demand via the Goal 5 read API. The
`seq` field is the cursor for `getEventsSince`.

### State→event mapping — done in JS, with explicit unknown-state fallback

The trigger emits the raw pg-boss `state` (`created` / `active` / `retry` /
`completed` / `failed` / `cancelled`). The JS subscriber maps
`active`→`started` and `retry`→`retried` (the other four are identity)
via a single TS constant.

**Unknown-state fallback.** If a future pg-boss minor adds a state value
the JS mapping doesn't know:

- The `JobEvent` is emitted on the `'job'` catch-all only (no per-type listener fires).
- The `event` field passes through with the raw state string (e.g. `event: 'paused'`).
- The first time each unknown state value is seen, a separate **`'warning'`** event fires with `{ unknownState: state, jobId, at: Date }`. Subsequent occurrences of the same unknown state are silent.

This keeps pg-boss minor bumps absorbable per success criterion #5,
without silently swallowing transitions or crashing the consumer.

### `attempt` semantics per event type

Verified against pg-boss 12.18.2's observed behavior (see `test/capture.test.ts`).
pg-boss's `failed` state is the **terminal** failure marker (no retries
remaining); `retry` is a transitional state on the OLD attempt's row
meaning "this attempt failed and a retry has been scheduled." After the
trigger fires for the `retry` state on the old row, pg-boss INSERTs a
new row for the next attempt with `state = 'created'`.

- **`created`** — fires when a new attempt row is inserted. `attempt`: the new attempt's number. `0` for the first attempt of a freshly-sent job; `1` for the first retry; etc.
- **`started`** — fires when an attempt is fetched (`active`). `attempt`: the attempt that just started.
- **`completed`** — fires on terminal `completed`. `attempt`: the attempt that succeeded.
- **`failed`** — fires on **terminal** `failed` (retries exhausted). `attempt`: the attempt that failed terminally.
- **`cancelled`** — fires on terminal `cancelled`. `attempt`: the attempt active at cancellation.
- **`retried`** — fires when an attempt fails but a retry is still budgeted (pg-boss flips the OLD attempt row to `state = 'retry'`). `attempt`: the attempt that just failed (the OLD attempt). It is immediately followed by a `created` event for the new attempt row pg-boss inserts.

For a job that fails once and then succeeds (retryLimit = 1), the consumer sees:
`created(0)` → `started(0)` → `retried(0)` → `created(1)` → `started(1)` → `completed(1)`.

For a job with no retries that fails (retryLimit = 0):
`created(0)` → `started(0)` → `failed(0)`.

### Event ordering — per-type fires before `'job'`

For a single transition (e.g. a `completed` state change), the per-type
listener fires first, then the catch-all `'job'` listener. Consumers can
rely on this order: `events.once('failed', markDead);
events.on('job', updateMetrics);` will see `markDead` run before
`updateMetrics` for the same event.

### Failover and primary-discovery

`NOTIFY` is not replicated to standbys. After a primary failover, a
subscriber connected by IP or DNS to the old primary (now a demoted
standby) will reconnect successfully but receive zero events. The spec
recommends `target_session_attrs=read-write` in the connection string
(libpq ≥ 14, supported by `pg`) so the driver discovers the writable
primary on reconnect.

### PgBouncer compatibility

PgBouncer in **transaction-pool mode** silently breaks `LISTEN` — the
connection is technically alive but notifications never arrive because
the backend is reused between transactions. **PgBouncer transaction
mode is an unsupported topology for the subscriber connection.** Three
viable consumer options:

1. Route the subscriber's connection through PgBouncer **session-pool mode**.
2. Use a separate Postgres connection (not through PgBouncer) for the subscriber.
3. Connect directly to Postgres (bypassing PgBouncer entirely) for `subscribe()`.

The subscriber emits `'connected'` on every successful `LISTEN`, so
consumers can implement a "no `'connected'` within N seconds of
`subscribe()` ⇒ alert" health check to catch misconfigured pool modes.

---

## Architecture and data flow

```
pg-boss op (e.g. boss.complete(jobId))
    └─→ UPDATE pgboss.job (state column changes)
          └─→ trigger pgbossier_capture fires (already shipped)
                └─→ pgbossier.capture() runs inside the pg-boss op's transaction:
                      ├── new_seq := nextval('pgbossier.record_seq')        ← v2
                      ├── INSERT/UPDATE pgbossier.record (… seq = new_seq)  ← v2 advances seq
                      └── pg_notify('pgbossier_job', payload with seq)
                            └─→ on transaction COMMIT, Postgres delivers
                                  └─→ subscriber's LISTENing connection receives it
                                        └─→ pg driver emits 'notification'
                                              └─→ JS parses, maps state→event, handles unknown
                                                    └─→ emits per-type then 'job'
                                                          └─→ consumer's
                                                              events.on('failed', h) runs
```

Properties:

- **One capture point.** Audit row write and notify in the same trigger, same transaction — commit or roll back together.
- **No new pg-boss surface dependency.** Goal 7 depends on Postgres' documented `pg_notify` / `LISTEN` and a private `pgbossier.record_seq` sequence — *not* on any pg-boss surface. No `COMPATIBILITY.md` tier change for pg-boss.
- **Idempotent install / upgrade.** `CREATE SEQUENCE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION` cover new installs *and* existing installs upgrading from v1.
- **Symmetric uninstall.** `DROP SCHEMA pgbossier CASCADE` drops the sequence, table, function, and trigger together.

---

## SQL side — trigger and schema changes

### Sequence and column (new in v2)

```sql
CREATE SEQUENCE IF NOT EXISTS pgbossier.record_seq;

-- New install: include seq column in CREATE TABLE
-- (RECORD_TABLE_SQL in src/sql.ts gains:)
--     seq BIGINT NOT NULL DEFAULT nextval('pgbossier.record_seq'),
-- and an index:
CREATE INDEX IF NOT EXISTS record_seq_idx ON pgbossier.record (seq);

-- Existing install upgrade: add the column idempotently.
ALTER TABLE pgbossier.record
  ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('pgbossier.record_seq');
```

For existing installs, `ADD COLUMN … DEFAULT nextval(...)` assigns a
unique `seq` to each existing row at upgrade time (the order is
heap-scan order, which is approximately insert order; the exact order
of pre-upgrade rows doesn't matter — only forward-going monotonicity
does).

### Updated trigger function

```sql
CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_seq bigint;
BEGIN
  BEGIN
    new_seq := nextval('pgbossier.record_seq');

    INSERT INTO pgbossier.record
      (job_id, queue, attempt, state, data, output,
       created_on, started_on, completed_on, captured_at, seq)
    VALUES
      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
       NEW.created_on, NEW.started_on, NEW.completed_on, now(), new_seq)
    ON CONFLICT (job_id, attempt) DO UPDATE SET
      state        = EXCLUDED.state,
      data         = EXCLUDED.data,
      output       = EXCLUDED.output,
      created_on   = EXCLUDED.created_on,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on,
      seq          = new_seq;

    PERFORM pg_notify(
      'pgbossier_job',
      json_build_object(
        'job_id',      NEW.id,
        'queue',       NEW.name,
        'attempt',     NEW.retry_count,
        'state',       NEW.state,
        'seq',         new_seq,
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

Notes:

1. **Order and atomicity.** `nextval` → INSERT/UPDATE → `pg_notify`. All three inside the inner `BEGIN` so a failure on any line rolls them all back via PL/pgSQL's implicit savepoint. The pg-boss operation proceeds either way.
2. **Same transaction.** `pg_notify` queues the notification; Postgres delivers on commit. Rolled-back pg-boss ops produce no event and no audit row.
3. **Why advance `seq` on UPDATE too?** The audit row gets one final row per attempt, but the live event stream and the catch-up cursor need to be monotonic across transitions. Advancing `seq` on every upsert keeps the cursor correct: `WHERE seq > $1 ORDER BY seq` returns rows whose latest transition is newer than the cursor.
4. **Fail-open silent gap.** If `pg_notify` ever fails (vanishingly rare with a thin bounded payload), the `EXCEPTION WHEN OTHERS` block rolls back the savepoint — the audit row write is also lost, and the JS subscriber receives no signal because no notification was delivered. See the Risks table.

---

## JS side — API surface

### Public types (exported from `src/index.ts`)

```ts
export type JobEventName =
  | 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'retried';

export interface JobEvent {
  event: JobEventName | string;  // string for forward-compat unknown states
  jobId: string;
  queue: string;
  attempt: number;
  state: JobState | string;      // raw pg-boss state; string for unknown
  seq: bigint;                   // monotonic per-transition cursor
  capturedAt: Date;
}

export type ErrorReason = 'gap' | 'parse' | 'handler';

export interface BossierErrorEvent {
  reason: ErrorReason;
  error: unknown;                 // thrown values aren't guaranteed Error
  at: Date;
}

export interface BossierWarningEvent {
  unknownState: string;
  jobId: string;
  at: Date;
}

interface BossierEventsMap {
  created:   [JobEvent];
  started:   [JobEvent];
  completed: [JobEvent];
  failed:    [JobEvent];
  cancelled: [JobEvent];
  retried:   [JobEvent];
  job:       [JobEvent];                 // catch-all — every transition (incl. unknown states)
  connected: [];                         // every successful LISTEN
  warning:   [BossierWarningEvent];      // first occurrence of each unknown state
  error:     [BossierErrorEvent];        // gap / parse / handler
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
  /** Modern Node `await using` integration. Calls close(). */
  [Symbol.asyncDispose](): Promise<void>;
}
```

### Client methods

```ts
// in BossierMethods (src/client.ts)
/** Open a subscription to job-lifecycle events. */
subscribe(options?: { signal?: AbortSignal }): Promise<BossierEvents>;

/** Replay rows from pgbossier.record whose seq is greater than `since`,
 *  ordered ascending. Returns the latest state of every attempt whose row
 *  was touched after the cursor — NOT the full transition sequence
 *  (the audit table is a current-state table). Used for catch-up after a gap. */
getEventsSince<TInput = unknown, TOutput = unknown>(
  since: bigint,
  opts?: { limit?: number }
): Promise<JobRecord<TInput, TOutput>[]>;
```

### Typical usage with cursor catch-up

```ts
const client = bossier({ boss, pool });
const ac = new AbortController();
const events = await client.subscribe({ signal: ac.signal });

let lastSeq = 0n;

events.on('connected', () => log.info('event stream live'));
events.on('job', e => { lastSeq = e.seq; });           // track every event
events.on('failed', e => log.warn(`job ${e.jobId} failed on attempt ${e.attempt}`));
events.on('warning', w => log.warn({ w }, 'unknown pg-boss state — pg-bossier may need an upgrade'));
events.on('error',  async ev => {
  if (ev.reason === 'gap') {
    const missed = await client.getEventsSince(lastSeq);
    for (const m of missed) { lastSeq = m.seq; handleCatchUp(m); }
  } else {
    log.warn({ ev }, 'event handler or parse error');
  }
});

process.on('SIGINT', async () => {
  ac.abort();            // triggers events.close()
  await boss.stop();
});
```

---

## Connection lifecycle and reconnect

- **Connection acquisition.** `pool.connect()` returns a dedicated `PoolClient`; the subscriber holds it for its lifetime. Documented: each live subscriber holds one pool connection — size pools accordingly. Recommend `target_session_attrs=read-write` in the connection string for failover-aware primary discovery.
- **Listen.** On connect, register the `'notification'` handler, then `LISTEN pgbossier_job`. Emit a `'connected'` event after the `LISTEN` returns.
- **Reconnect loop with exponential backoff.** If the client emits `'error'` or `'end'` and `close()` has not been called:
  1. Release the dead client with `release(err)`.
  2. Wait for `min(2^n × 1s, 30s) × jitter(0.8, 1.2)` where `n` is the consecutive-failure count starting at 0; the wait is **cancellable** via the close signal.
  3. After the wait resolves, check `closed` *before* `pool.connect()` — if `closed`, return without reconnecting.
  4. `pool.connect()` and re-`LISTEN`. On success: reset `n` to 0, emit `'connected'`, emit `'error'` with `reason: 'gap'` so the consumer can catch up.
  5. On failure: increment `n`, loop back to step 2.
- **`close()` and `AbortSignal`.** Either path stops reconnection, cancels any pending wait, releases the live client, resolves once the connection is fully released. Idempotent.

| Event | What pg-bossier does | What the consumer sees |
|---|---|---|
| Network blip / client drop | Auto-reconnect with backoff, re-LISTEN | `'error'` with `reason: 'gap'`, then `'connected'` |
| Postgres restart | Auto-reconnect when DB is back | `'error'` with `reason: 'gap'`, then `'connected'`, then events resume |
| **Primary failover (subscriber reconnects to old primary, now standby)** | Reconnect succeeds at TCP level, `LISTEN` returns; but no events flow | One `'connected'`, then silence until consumer's heartbeat catches it. Recommend `target_session_attrs=read-write`. |
| **PgBouncer transaction-pool mode (misconfigured)** | LISTEN appears to succeed but notifications never delivered | One `'connected'` then silence. Detect via the "no events within N s" health check; document as unsupported topology. |
| Handler throws | Caught, routed to `'error'` with `reason: 'handler'` | `'error'` with `{ reason: 'handler', error, at }` |
| Malformed notification JSON | Logged + `'error'` with `reason: 'parse'`, drop that one, stream continues | `'error'` with `{ reason: 'parse', error, at }` |
| Unknown `state` from future pg-boss | Emit on `'job'` only with `event = state`; one-time `'warning'` per unknown state | `'job'` event + (first time) `'warning'` |
| `close()` / `signal.abort()` | Stop reconnecting, release client | Nothing further |

---

## Error handling and fail-open boundaries

Three failure surfaces, three rules:

1. **Inside the trigger (SQL side).** Caught by the existing `EXCEPTION WHEN OTHERS` block. `RAISE WARNING`, swallowed. *Non-negotiable per issue #1.* Trade-off: if `pg_notify` itself ever fails (vanishingly rare with a bounded payload), the savepoint rolls back the audit row write too. This is a **silent gap** — no JS `'error'` fires because no notification was delivered. Documented in the Risks table.
2. **Inside the subscriber (JS side, library code).** Connection drops, re-`LISTEN` failures, JSON parse errors → emit `'error'` with the appropriate `reason`; never throw. The subscriber's job is to keep going.
3. **Inside the consumer's handler.** The library **catches thrown handler values** and re-emits them as `'error'` with `reason: 'handler'`. This is deliberately non-standard compared to bare `EventEmitter` (which would let the throw propagate and likely crash the process on the `'error'` channel) — the rationale is that the subscriber's stream must survive any single consumer-code bug. Consumers who want raw `EventEmitter` semantics can throw inside the handler and *not* register an `'error'` listener — the rerouted error then becomes an unhandled `'error'` event per Node's default.

---

## Testing strategy

`test/events.test.ts` — `vitest` + `@testcontainers/postgresql`, real
Postgres + pg-boss 12.18.2, no mocks. Continues the existing pattern.

1. **Happy path.** Subscribe; submit and complete a job; assert `'connected'`, then `'started'` then `'completed'` arrive with expected `jobId` / `queue` / `attempt` / `state` / `event` / `seq`.
2. **All six event types.** One test per `created` / `started` / `completed` / `failed` / `cancelled` / `retried`. `failed` + `retried` use a worker that throws on a job configured with retries; assert the expected `attempt` values (0 for the first attempt, 1 for the first retry, etc.).
3. **Catch-all `'job'` event.** A single `'job'` listener sees all six transitions for a job; per-type listeners fire before `'job'` for the same transition.
4. **Cross-subscriber broadcast.** Two `subscribe()` instances on the same pool both receive every event.
5. **`close()` is clean.** No further events after `close()`; pool's connection count returns to its pre-subscribe value; calling `close()` twice doesn't throw; `AbortSignal.abort()` triggers the same path as `close()`.
6. **Reconnect after drop.** Use `pg_terminate_backend(pid)` from a second connection to kill the subscriber's backend; assert `'error'` with `reason: 'gap'` fires, then `'connected'`, then events flow.
7. **Reconnect uses exponential backoff.** Force three consecutive connect failures (e.g. via a stub pool); assert delays roughly 1s → 2s → 4s with jitter (allow ±20 % window).
8. **`closed` race.** Call `close()` during the backoff wait; assert no `pool.connect()` is attempted after `close()`.
9. **`seq` is monotonic.** Submit 100 jobs; assert every event's `seq` is strictly greater than the previous one received on a single subscriber.
10. **`getEventsSince` returns final state.** Submit a job that transitions `created → active → completed`; record the `seq` after `created`; call `getEventsSince(seq)`; assert it returns one row with `state = completed` (the audit table holds final state, not the full sequence).
11. **Unknown-state fallback.** Manually `pg_notify` a payload with `state = 'paused'`; assert the consumer receives a `'job'` event with `event = 'paused'` plus a one-time `'warning'`; second notification with the same unknown state does NOT re-emit `'warning'`.
12. **`'error'` discriminant.** Trigger gap, parse error (bad JSON via test-only `pg_notify`), and handler throw; assert each produces an `'error'` with the correct `reason`.
13. **Backfill produces no events.** On a fresh install with existing `pgboss.job` rows, run `install()`; subscribe; assert no events fire for the historical rows (the BACKFILL SQL bypasses the trigger).
14. **Idle-session timeout.** Set `idle_session_timeout = '2s'` server-side; hold the LISTEN connection idle; assert reconnect + `'connected'` re-emission.
15. **Notification flood.** Submit 10 000 jobs in a tight loop; assert the subscriber receives all 60 000 expected transitions in order, with no drops, within a reasonable wall-clock budget.
16. **Trigger fail-open.** Provoke a `pg_notify` failure path (an out-of-band oversized payload via a separate test-only `PERFORM`) and confirm the pg-boss op still succeeds; assert no audit row exists for that transition.
17. **No Forbidden imports.** Static-grep test asserts `src/events.ts` imports only from `pg` and Node built-ins (`node:events`), never from `pg-boss/src/*`.

**Performance probe — conditional release gate.** Submit N jobs (say
N = 1000) and measure per-transition wall-clock with and without
pg-bossier installed. The probe runs as a test. **If issue #12 has
landed and the measured overhead exceeds its budget, the test fails
and shipping is blocked** — aligns with issue #1's "exceeding the
budget blocks release." Until #12 lands, the probe runs and produces
the input number for that decision.

---

## File layout

**New**
- `src/events.ts` — `BossierEvents` class, `JobEvent` / `BossierErrorEvent` / `BossierWarningEvent` types, `subscribe(pool, opts)` factory, state→event map with unknown-state handling, exponential-backoff-with-jitter reconnect loop, cancellable wait.
- `src/cursor.ts` (or inside `read.ts`) — `getEventsSince(pool, since, opts)` implementation.
- `test/events.test.ts` — integration tests above.

**Changed**
- `src/sql.ts` — `RECORD_TABLE_SQL` gains the `seq` column; new `SEQUENCE_SQL` constant + new `ALTER_TABLE_ADD_SEQ_SQL` constant for upgrade path; `CAPTURE_FUNCTION_SQL` gains the `nextval` + updated payload; new index for `seq`.
- `src/install.ts` — runs `CREATE SEQUENCE IF NOT EXISTS pgbossier.record_seq`, then the existing table SQL, then the `ALTER TABLE … ADD COLUMN IF NOT EXISTS seq` upgrade, then function + trigger. Order matters (sequence must exist before the table default references it).
- `src/client.ts` — `BossierMethods` gains `subscribe()` and `getEventsSince()`; methods map adds them.
- `src/index.ts` — re-exports `BossierEvents`, `JobEvent`, `JobEventName`, `BossierErrorEvent`, `BossierWarningEvent`, `ErrorReason`.
- `CHANGELOG.md` — entry under `## [Unreleased]` → `Added`.
- `CLAUDE.md` — project-status paragraph notes Goal 7 delivered, #8 closed.
- `COMPATIBILITY.md` — **new "Unsupported topologies" section** covering PgBouncer transaction-pool mode and standby connections; recommendation to use `target_session_attrs=read-write`; documents `pgbossier_job` as a published channel name.
- `README.md` — new "Lifecycle events" section under "Operational API" describing `subscribe()`, the event types, the cursor pattern with `getEventsSince`, and the PgBouncer caveat.

---

## Compatibility tier impact

No change to `pg-boss` compatibility tiers. Goal 7 introduces no new
pg-boss surface dependency:

- `pg_notify`, `LISTEN`, `nextval` are documented Postgres features.
- The trigger function and sequence are in the `pgbossier` schema, owned by pg-bossier.
- The channel name `pgbossier_job` is pg-bossier-owned per issue #1's namespacing constraint.

`COMPATIBILITY.md` gains a **new "Unsupported topologies"** subsection
listing PgBouncer transaction-pool mode and standby subscriber
connections as unsupported, with the documented workarounds.

---

## Out of v1 (deliberately, with reasons)

- **`terminal_detail` / `expired` / `superseded` markers in payloads.** Goal 2 (#3) territory.
- **Intermediate-state-within-attempt replay after a gap.** Requires append-only audit table — schema change on a shipped table. Deferred as a v2.x sub-issue if real consumers surface a need.
- **Server-side filtering** (`subscribe({ queue: 'sync' })`). YAGNI; consumers filter in-handler.
- **Channel-name parameterization for multi-tenancy.** pg-boss itself doesn't support multi-instance-per-database; YAGNI.
- **OpenTelemetry exporters.** Explicit non-goal in issue #1.

---

## Open dependencies (cross-cutting issues)

- **#12 — per-event performance budget.** Goal 7 adds `nextval` + one `pg_notify(text, text)` per transition. The performance probe in the test plan is now a **conditional release gate** keyed to #12's budget number.
- **#13 — TypeScript generics surface.** `JobEvent` is **not** parameterized on `TInput` / `TOutput` because the payload deliberately omits `data` / `output`. `getEventsSince` returns `JobRecord<TInput, TOutput>[]` and inherits whatever generics #13 settles on for `JobRecord`.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| PgBouncer transaction-pool mode silently breaks LISTEN | **High** for default Prisma deployments | Documented as unsupported in COMPATIBILITY.md; `'connected'` event + "no events within N s" health check lets consumers detect it |
| Primary failover to a not-yet-promoted standby produces clean reconnect but no events | Medium | Recommend `target_session_attrs=read-write`; documented in COMPATIBILITY.md |
| SQL-side `pg_notify` failure rolls back audit row, no JS `'error'` fires | Very low — payload bounded ~160 bytes | Documented; the pg-boss op still succeeds; consumer's catch-up reads cover the rare row gap |
| Subscriber's pool exhausted by held connection | Low — one per live subscriber | Documented in README; tests verify connection count returns to baseline on `close()` |
| Handler throws and crashes the consumer's process | Low — library catches and re-emits as `'error'` `reason: 'handler'` | Documented; tests verify routing |
| Reconnect storm against Postgres during sustained outage | Low — exponential backoff with jitter caps load | Implementation enforces backoff |
| Consumer counts on intermediate-state-within-attempt replay | Medium — common misunderstanding | README explicitly documents "final-state-per-attempt" replay scope |
| Real-world `pg_notify` payload exceeds 8 KB | Very low — payload is bounded by construction | Static envelope shape; no consumer-controlled fields enter the payload |
| Notification queue full under extreme write throughput | Low — depends on slow consumers blocking the queue cluster-wide | Documented in Risks; notification-flood test exercises the path |
| `MaxListenersExceededWarning` from many `'job'` listeners | Low — Node default 10 listeners | README notes `events.setMaxListeners(0)` for metrics use cases |
| pg-boss adds a new state in a minor version | Medium | Pass-through unknown-state mapping + one-time `'warning'` event; tests verify no crash |

---

## Related

- [Storage substrate design (2026-05-20)](./2026-05-20-storage-architecture-design.md)
- [Goal 6 progress design (2026-05-21)](./2026-05-21-goal-6-progress-api-design.md)
- [Goal 7 adversarial review synthesis (2026-05-23)](../debates/2026-05-23-goal-7-spec-adversarial-review/99-synthesis.md)
- [pg-boss#570](https://github.com/timgit/pg-boss/issues/570) — declined upstream request for job lifecycle events
- [Postgres docs — NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- [node-postgres — async notifications](https://node-postgres.com/features/notifications)
