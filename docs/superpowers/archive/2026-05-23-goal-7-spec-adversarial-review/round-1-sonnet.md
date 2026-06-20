# Sonnet critique — Round 1

---

## 1. LISTEN/NOTIFY transport choice

The spec acknowledges the dedicated connection cost ("each live subscriber holds one pool connection") but understates two real risks:

**PgBouncer transaction mode.** The spec is silent on this. PgBouncer in `transaction` mode — the default for most managed Postgres services and high-throughput deployments — silently breaks `LISTEN`. The connection succeeds, `LISTEN pgbossier_job` appears to execute, but notifications are never delivered because the connection is returned to the pool between requests. The consumer sees no error, no gap signal, and no events. The spec's failure table ("Connection lifecycle and reconnect") lists network blips, Postgres restarts, and handler throws — but not "LISTEN silently broken by pool proxy." For descent-app, which almost certainly sits behind PgBouncer or a managed proxy (AWS RDS Proxy, Cloud SQL Auth Proxy, etc.), this is not a hypothetical.

**Failover and hot standby.** The spec states "No new pg-boss surface dependency... `pg_notify` and `LISTEN` are documented Postgres features" and lists no failover risk. But `NOTIFY` is not replicated to standbys — it is a primary-only facility. After a primary failover, the subscriber reconnects to the new primary successfully (no error, no gap signal until events arrive), but any notifies that fired on the old primary during its final transactions are gone. The spec's "One `'error'` per gap" reconnect signal will not fire here — the reconnect to the new primary succeeds cleanly. The consumer sees the reconnect as clean when it was actually lossy.

**High-throughput NOTIFY queue.** Postgres uses a per-backend async notification queue. If a LISTENing connection is slow to drain (event handler is slow, or the consumer's event loop is saturated), Postgres can fill its internal notification queue and begin dropping notifications silently. The spec does not document this ceiling or how to detect it.

---

## 2. At-most-once contract + gap signal

The gap signal mechanism has a structural flaw that makes correct consumer catch-up impossible without additional schema work.

The spec says: "durable replay is available — by reading `pgbossier.record`" and "emit one `'error'` so the consumer knows a gap happened." The implied consumer recovery is:

```
on 'error': SELECT * FROM pgbossier.record WHERE captured_at > <last_seen>
```

The spec itself admits this does not work: "Automatic replay would need a monotonic sequence column on `pgbossier.record` (none today — `captured_at` is a timestamp with no uniqueness guarantee)." This is not just an automatic-replay concern — it is the same problem for a manually-triggered catch-up. Two rows with the same `captured_at` (common at millisecond resolution under any real load) cannot be ordered. A consumer using `captured_at` as a cursor will either:

- Miss rows if they query `WHERE captured_at > :last_seen` (rows at the boundary timestamp are excluded),
- Or double-count rows if they query `WHERE captured_at >= :last_seen` (boundary rows are re-read on every reconnect).

There is no way for a consumer to write a correct catch-up query with only `captured_at` as a cursor. The spec documents the gap signal as a feature ("durable replay is available") but provides no mechanism for consumers to actually execute that replay correctly. This is a broken promise, not a deferred feature.

The fix is small: add a `BIGSERIAL` or `generated always as identity` column to `pgbossier.record` (call it `seq`), expose it in the payload, and document `WHERE seq > :last_seq` as the catch-up pattern. This is a schema change on an already-shipped table — it needs to happen before Goal 7 ships, not after.

---

## 3. Thin payload + follow-up read pattern

The spec says: "full detail for any event is read from `pgbossier.record` via the already-shipped Goal 5 read API." This is stated as a design virtue (thin payload = negligible per-event cost). But the consequence is mandatory read amplification.

For a consumer doing anything beyond logging — metrics aggregation, dead-letter routing, alerting — a `failed` event without `output` or any error signal is not actionable without an immediate follow-up `findById`. That is 1 NOTIFY + 1 SELECT per failure event, for every consumer process subscribed. Across three app processes subscribing to a single queue with 50 failures/second, that is 150 additional reads per second that exist only because the payload carries no actionable signal.

The spec's rationale for the thin payload is correct for `data` and `output` — those can be multi-KB. But `state` is already in the payload. The incremental cost of adding a `has_output: boolean` or `error_message: string | null` field is zero bytes in the common case (no output, no error) and tiny in the failure case. This single-bit field would eliminate the majority of mandatory follow-up reads without breaking the thin-payload argument.

This is a design choice worth revisiting before the API is frozen, not a blocker.

---

## 4. `pg_notify`-inside-trigger placement

The spec says: "either both the record row and the event happen, or neither does" (SQL side, note 1). This is accurate under the normal case. Two real edge cases are not addressed:

**2PC (prepared transactions).** `NOTIFY` inside a prepared transaction (`PREPARE TRANSACTION`) is explicitly disallowed by Postgres — it raises `ERROR: cannot use subtransactions during a two-phase commit`. If the pg-boss operation ever runs inside a 2PC context (unlikely for pg-boss itself, but possible if a consumer wraps pg-boss operations in a distributed transaction), the trigger will throw inside the inner `BEGIN`, be caught by `EXCEPTION WHEN OTHERS`, and the event will be silently lost while the audit row write succeeds. This creates a situation where `pgbossier.record` has a row but no event was emitted — breaking the "they commit or roll back together" property claimed in "One capture point."

**Subtransaction interaction.** If the pg-boss operation is wrapped in a subtransaction (e.g., `SAVEPOINT` in the caller's code), the inner `BEGIN...EXCEPTION` block in the trigger introduces an additional implicit savepoint. A `pg_notify` inside a subtransaction is valid and queued, but if the outer subtransaction rolls back (not the main transaction), the `NOTIFY` is still delivered on main transaction commit even though the job state change was rolled back. The spec's "A rolled-back pg-boss op produces no event" claim is only true for main transaction rollbacks, not for subtransaction rollbacks.

The 2PC case is low-probability for pg-boss consumers. The subtransaction case is more realistic (ORMs like Prisma use savepoints under the hood for nested transactions). Both should be documented in the compatibility section.

---

## 5. Auto-reconnect with fixed 1s delay forever

The spec dismisses the reconnect storm concern: "A subscriber holds one connection; a hard reconnect storm against a single pool from a single subscriber is not a real risk." This is correct if there is one subscriber. It is not correct for descent-app's actual topology.

descent-app runs multiple processes. If 10 app servers each call `bossier.subscribe()` once, and the DB goes down for 5 minutes, that is 10 processes × 300 attempts × connection overhead per attempt = 3000 failed `pool.connect()` attempts hitting the DB simultaneously when it comes back up. The pool itself may have connection limits that make this self-limiting, but the reconnect loop as specified will saturate the pool's `max` on every retry cycle until connections start succeeding.

More concretely: the reconnect loop as specified does not check `closed` status between the `1000ms` wait and the `pool.connect()` call. If `close()` is called during the wait period, the implementation must not proceed with the connect attempt. The spec describes the loop as "Retry forever until either it succeeds or `close()` is called" — this implies the closed check happens at the top of the loop, but the implementation plan needs to be explicit about this race condition.

The YAGNI justification ("a small follow-up that doesn't break the API") is accurate. The actual ask is: add a cap of N retries (or a max total wait time) that the caller can configure, with the default being forever. The API surface does not change.

---

## 6. `BossierEvents extends EventEmitter` API shape

The typed-overload pattern (`on<K extends keyof BossierEventsMap>`) has one concrete TypeScript problem: the overloaded signatures do not cover the base `EventEmitter` signatures. Any code that calls `events.on('newListener', ...)` or `events.on('removeListener', ...)` (both standard Node EventEmitter events) will fail to type-check because those keys are not in `BossierEventsMap`. Tools like pino or debug that instrument EventEmitter methods via `getMaxListeners` / `setMaxListeners` / `eventNames()` will work at runtime (they go through the class instance, not the interface), but TypeScript consumers calling `events.eventNames()` will get `string | symbol[]` rather than `(keyof BossierEventsMap)[]` — a minor friction point, not a blocker.

The more concrete issue: `BossierEventsMap` has `error: [Error]` but the spec says "a thrown handler is routed to the `'error'` listener if one is registered; otherwise it propagates (Node-standard)." The type `[Error]` is wrong for the handler-throws case — a thrown handler value is not necessarily an `Error` instance; it can be a string, a plain object, or anything. The type should be `[unknown]` with a runtime narrowing in the handler. This is a small bug in the type spec.

`close(): Promise<void>` is fine. `AbortSignal` support is noted as an open question — it should be answered before shipping, not deferred. Once `close()` ships without `AbortSignal`, adding it later is backward-compatible, but the "open question" label implies it might not be in v1 at all.

---

## 7. State→event mapping in JS, not SQL

The spec says the JS subscriber maps `active`→`started` and `retry`→`retried`. The payload carries both `state` (raw pg-boss value) and `event` (friendly name). This creates two failure modes if pg-boss adds a new state:

**Failure mode A — new state not in the mapping.** If pg-boss 13 adds a `paused` state, the JS mapping has no entry for it. The spec does not say what `event` value is emitted. If the implementation `throw`s or returns `undefined`, the `job` catch-all listener silently stops receiving events for paused jobs, or crashes the stream. If the implementation passes the raw state as the event name (fallback), consumers get undocumented event names they never registered handlers for.

**Failure mode B — the `JobState` type is stale.** The `state: JobState` field on `JobEvent` is typed against the current pg-boss state enumeration. If pg-boss adds a new state, the TypeScript type will be wrong (the value will not be a member of `JobState`), but the runtime will still receive the string. TypeScript consumers with exhaustive switches (`switch (e.state) { ... default: assertNever(e.state) }`) will have TypeScript errors on the next pg-boss upgrade. This is a known cost of the design (the "Transitional" tier), but it should be documented explicitly in `COMPATIBILITY.md`.

The spec notes the raw `state` is "still in the payload so consumers correlating events to records have it" — the concern is about what happens to the `event` field for unknown states, which is not specified.

---

## 8. Issue #1 violations

One genuine tension with issue #1 constraints:

**"Audit writes are fail-open."** The spec correctly places `pg_notify` inside the `EXCEPTION WHEN OTHERS` block. But the spec also claims "either both the record row and the event happen, or neither does" (SQL side, note 1). These two statements are in tension. If `pg_notify` fails (admittedly rare), the `EXCEPTION` handler catches it, the INSERT is rolled back by PL/pgSQL's implicit savepoint, and the audit row is also lost. The spec is technically correct that neither happens — but the fail-open guarantee is supposed to mean pg-bossier failures never block or lose the pg-boss operation. Silently losing the audit row because `pg_notify` failed (even if vanishingly unlikely) is still a silent data loss path. This is a pre-existing tension in the trigger design (Goal 1), not new to Goal 7, but Goal 7 makes it worse by adding one more failure point inside the same savepoint scope.

**"No observability platform."** The spec stays on the right side of this line — it emits events, not metrics. No violation here.

**"Symmetric uninstall."** The `DROP SCHEMA pgbossier CASCADE` path is correct. But `COMPATIBILITY.md` now documents `pgbossier_job` as a published channel name for non-Node consumers. Those consumers' `LISTEN pgbossier_job` registrations are per-connection and disappear when the connection closes — no persistent state to clean up. No violation.

**"Per-event overhead has a published budget."** The spec correctly defers to issue #12 and commits to a measurement. The one gap: the performance probe is "informational, not a release gate." But issue #1 explicitly says "Exceeding the budget blocks release." If the probe shows the budget is exceeded, the spec provides no decision path. This should be a conditional gate, not just a measurement.

---

## 9. Test plan false confidence

The test plan covers the happy path and `pg_terminate_backend`. The following production failure modes are not covered and are not trivially equivalent:

**PgBouncer in transaction mode.** `pg_terminate_backend` tests the reconnect loop but not the silent-failure mode where the connection is alive but `LISTEN` is broken. There is no test for "subscriber connected through a transaction-mode proxy receives no events." This is the most common real-world failure mode and it produces no error, no gap signal, and no reconnect attempt.

**IDLE-IN-TRANSACTION timeout.** The subscriber's connection holds no open transaction, so `idle_in_transaction_session_timeout` does not apply. But `idle_session_timeout` (added in Postgres 14) will kill the subscriber's connection if no notification arrives within the timeout window. The reconnect test covers forced kills, not timeout-driven disconnects. Functionally equivalent, but the test comment should note this.

**Postgres `NOTIFY queue is full` (WAL-level).** At extreme throughput (>8000 pending notifications per session), Postgres begins dropping `NOTIFY` messages silently with a server-side warning (`NOTICE: NOTIFY queue is full`) that is not delivered to the subscriber. The slow-consumer + high-throughput scenario is not tested. The spec's performance probe at N=1000 total jobs (not 1000/sec) may not surface this.

**TLS mid-stream failure.** `pg_terminate_backend` terminates the TCP connection cleanly (FIN/RST). A TLS renegotiation failure or mid-stream TLS error produces a different error path in the `pg` driver — typically an `Error` on the `PoolClient` with a TLS error code rather than a clean `'end'` event. The reconnect loop handles `'error'` and `'end'` events — this should be fine, but it is worth a comment in the implementation.

**Test 4 (cross-subscriber broadcast) is insufficient** as a stand-in for multi-process. The spec notes: "Two `subscribe()` instances on the same pool both receive every event (stand-in for the multi-process case — sufficient because Postgres NOTIFY broadcasts to every LISTENer)." This is correct for NOTIFY broadcast semantics, but misses the PgBouncer connection-per-process concern noted in vector 1. The test does not validate that a second OS-process subscriber receives events.

---

## 10. Missing from v1

**No way to detect PgBouncer/proxy breakage.** The spec's biggest operational risk is also its most invisible failure. A health-check method (`events.isHealthy(): boolean` or a `'connected'` event) that confirms LISTEN is active on the underlying connection would let consumers detect silent failures. A minimal implementation: after each successful re-LISTEN, emit a `'connected'` event; consumers can set a timeout and alert if no `'connected'` fires after process start.

**No documented sequence field for catch-up.** As argued in vector 2, the gap signal is not actionable without a monotonic cursor. The spec points consumers toward `pgbossier.record` for catch-up but the table cannot support correct catch-up queries with `captured_at` alone. This needs to be resolved — either by adding `seq`, or by explicitly documenting "catch-up is not possible at the row level; use `captured_at` with `>=` and accept possible duplicates." The current spec implies catch-up is possible and leaves consumers to discover it is not.

**`error` event type is too coarse.** The `error` listener receives an `Error` for connection drops, parse errors, and handler throws — three semantically different situations that need different consumer responses. A connection drop → check audit table; a parse error → possible schema mismatch, needs investigation; a handler throw → consumer bug. The spec conflates them. A `reason: 'gap' | 'parse' | 'handler'` field on the emitted error object (or separate event types) would let consumers respond correctly without inspecting `err.message`.

**No documentation of what `attempt` means on a `created` event.** `attempt` is `NEW.retry_count` from the trigger. On job creation, `retry_count` in pg-boss is typically 0. The payload spec shows `"attempt": 2` for a `failed` event. Does a `created` event carry `attempt: 0`? Does a `retried` event carry the attempt number of the retry that was just created (i.e., 1 for first retry), or the attempt number of the attempt that just failed? This is unclear from the spec and will generate consumer bugs. It should be explicitly documented with examples.

---

## Verdict

SHIP WITH NAMED CHANGES

CHANGE: Add a `seq BIGSERIAL` (or equivalent) column to `pgbossier.record` and include it in the NOTIFY payload — without a monotonic cursor, the gap signal is a broken promise and consumers cannot perform correct catch-up reads.

CHANGE: Document PgBouncer transaction-mode incompatibility explicitly in the README and add a detectable health-check path (e.g., a `'connected'` event on successful LISTEN) so consumers can detect silent failures.

CHANGE: Tighten the `error` event to include a `reason` discriminant (`'gap' | 'parse' | 'handler'`) so consumers can respond correctly without parsing error messages.

CHANGE: Fix the `error` event type in `BossierEventsMap` from `[Error]` to `[unknown]` — thrown handler values are not guaranteed to be `Error` instances.

CHANGE: Specify explicitly what `event` value is emitted for an unknown/unrecognized `state` value from a future pg-boss version (fallback to raw state string, or drop the event, or emit on `'job'` only) — current spec leaves this undefined.

CHANGE: Clarify what `attempt` value is carried on `created` and `retried` events with a concrete example — the payload spec shows `"attempt": 2` only for `failed` without covering the edge cases.

CHANGE: Change the performance probe from "informational, not a release gate" to a conditional gate tied to issue #12's budget decision, consistent with issue #1's constraint that "exceeding the budget blocks release."
