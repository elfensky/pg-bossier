# Opus critique — Round 1

I co-authored this spec, so I am holding myself to a strict standard:
challenge every load-bearing claim, surface concrete failure modes, and
nominate changes I would push back on a teammate to make before merging.

## 1. LISTEN/NOTIFY transport choice

The transport is right *for the substrate that exists* — the trigger already
runs on every transition, `pg_notify` from inside it is genuinely the
minimum-extra-code answer. But the spec **silently hides four operational
constraints** that bite real deployments:

- **PgBouncer in transaction-pool mode silently breaks LISTEN.** This is the
  single most common Postgres deployment shape behind a Prisma-using app.
  In transaction mode, every transaction can land on a different backend, so
  `LISTEN` on one transaction's backend is invisible to the next backend that
  receives a NOTIFY. The subscriber sees zero events and no error. **The spec
  does not mention PgBouncer at all.** Given the primary consumer is
  descent-app (Prisma + production), this is the biggest production gotcha
  in the design, and it must be called out prominently.
- **NOTIFY is not delivered across streaming or logical replication.** Hot
  standby readers and logical replicas will never see events. Subscribers
  must connect to the primary, and after a failover they must rediscover
  the new primary — the fixed 1s reconnect against an unchanged endpoint
  doesn't address this.
- **The cluster-wide NOTIFY async queue can fill.** Default ~8 GB shared
  across all listeners. A slow consumer holding a LISTEN connection
  backpressures `pg_notify` publishers cluster-wide — eventually publishers
  fail. Not a v1 implementation change, but the spec should at least
  acknowledge the failure mode in the Risks table.
- **One dedicated connection per live subscriber, forever.** The spec says
  this in one line. It should also say: a four-replica web tier subscribing
  for live updates costs four pool connections, *plus* a worker tier, *plus*
  any operator dashboard. Add it to README sizing guidance, not just the
  design.

## 2. At-most-once + gap signal — the catch-up race is real

This is the single most important issue I'm raising. The spec claims
"durable replay is available — by reading the audit table" but **does not
describe a correct cursor pattern, and no cursor pattern using only the
shipped schema is actually correct.**

Concrete failure sequence:

1. T=100 — subscriber receives event for `(jobA, attempt=1, state=completed)`. `captured_at = '2026-05-23 12:34:56.789'`.
2. T=101–110 — connection drops. Several events fire during the gap.
3. T=111 — subscriber auto-reconnects, runs `LISTEN`, emits `'error'`.
4. T=112 — live events for `(jobC, …)`, `(jobD, …)` arrive.
5. T=113 — consumer tries to catch up with `SELECT … FROM pgbossier.record WHERE captured_at > '2026-05-23 12:34:56.789' ORDER BY captured_at`. This catch-up read **may return `jobC` and `jobD` too** — because they committed before the read ran, even though the consumer has already received them live.

Two compounding problems:

- `captured_at` is `now()` from inside the trigger — it has microsecond resolution but **no uniqueness guarantee**. Multiple rows can share the same value. So `>` may miss rows; `>=` may double-count.
- The 'error' event is emitted *after* re-LISTEN, which means live events can race the catch-up SELECT in both directions.

A correct catch-up requires a monotonically increasing per-row sequence
that's stable, unique, and comparable. `pgbossier.record` does not have one
today.

**Recommended change:** add `seq BIGSERIAL` (or `BIGINT GENERATED ALWAYS AS
IDENTITY`) to `pgbossier.record`. Include it in the NOTIFY payload. Ship
`getEventsSince(seq)` as the canonical catch-up read. The consumer's pattern
becomes:

```ts
let lastSeq: bigint = 0n;
events.on('job', e => { lastSeq = e.seq; handle(e); });
events.on('error', async () => {
  const missed = await client.getEventsSince(lastSeq);
  for (const e of missed) { lastSeq = e.seq; handle(e); }
});
```

This adds **one column + one method + ~20 lines of catch-up logic** the
consumer would otherwise have to write incorrectly. The spec already
defines `'error'` as the gap signal — pairing it with a real cursor is what
makes that signal useful.

## 3. Thin payload + follow-up read — defensible default, but document the math

1 event = 1 NOTIFY + (optionally) 1 SELECT. The SELECT is *only* triggered
when the consumer wants detail. Most consumers handle `'failed'` and
`'completed'` differently — `'completed'` rarely needs detail, `'failed'`
often does. So real read amplification is roughly `failure-rate ×
events-per-second`, which is small for most apps.

The 8 KB NOTIFY cap is a hard ceiling regardless of design preference. A
fatter payload that *sometimes* fits and sometimes doesn't is the worst of
both worlds (intermittent silent truncation or refusal). Stick with thin in
v1. Mark "selective inline `terminal_detail` when ≤ 1 KB" as a Goal 2
follow-up; it's a payload-shape choice that belongs there.

## 4. `pg_notify` inside trigger — atomicity holds, but two edge cases worth naming

The trigger placement IS atomic in the common case (NOTIFY queues on
commit, savepoint rollback drops the queued message). But:

- **2PC (`PREPARE TRANSACTION`)**: NOTIFY is held until `COMMIT PREPARED`.
  If the prepared transaction is rolled back, the notification is dropped.
  Consistent semantics — but the spec should say so explicitly because
  Prisma-using consumers occasionally use 2PC for distributed writes.
- **Streaming replication**: NOTIFY is *not* part of WAL. Standbys don't
  see it. After a failover, subscribers connected to the old primary see
  events stop with no error (the old primary becomes a standby). The
  reconnect loop reconnects to the same endpoint — which is now a standby
  serving no notifications. **The 1s fixed-delay reconnect doesn't detect
  this.** Document the failover behavior; recommend driver-level
  primary-discovery (`?target_session_attrs=read-write` in PG ≥ 14).

These belong in the Risks table at minimum.

## 5. Fixed 1s reconnect forever — a small but real anti-pattern

A 30-minute outage = 1,800 connection attempts per subscriber. Per
*replica*. At a four-replica web tier + one worker tier, that's 9,000
attempts during a single outage. Not DoS-scale, but exactly the wrong
pressure on a DB that's already in trouble.

Two-line fix in v1: exponential backoff with cap (1s → 2s → 4s → 8s → 16s
→ 30s) plus ±20 % jitter. This is six extra lines and it's the kind of
detail consumers absolutely expect from a library, not a footnote in a v2
issue. Worth pushing into v1.

A circuit breaker is genuinely YAGNI — `close()` plus user observability
on the `'error'` event covers it.

## 6. `EventEmitter` API shape — solid, with one ergonomic gap

Typed declaration-merging overloads on `EventEmitter` are a well-trodden
pattern, work with pino/debug (they don't read emitter types), and don't
interfere with `getMaxListeners`/`setMaxListeners`. One gotcha worth
documenting: a consumer who adds 10+ `'job'` listeners gets Node's default
MaxListenersExceededWarning. README should suggest `events.setMaxListeners`
or use the catch-all + internal dispatch.

`close(): Promise<void>` is fine. Two small ergonomic adds that **would**
land at zero cost:

- Accept `subscribe({ signal?: AbortSignal })` — abort signal triggers
  close. Modern Node convention.
- Implement `Symbol.asyncDispose` — Node 22+ supports `await using events =
  await client.subscribe();`. Two lines, future-friendly.

Both belong in v1. Neither blocks shipping.

## 7. State→event mapping in JS — fallback behavior is undefined

If pg-boss adds a state value in a minor release — historically they have —
the trigger emits the new value via `state`. The JS mapping doesn't know
it. The spec doesn't say what happens. Three plausible outcomes:

- Throw inside the notification handler → routed to `'error'` → consumer
  has no way to learn what state actually arrived.
- Silently drop → consumer doesn't know the event happened.
- Pass through with `event = state` → consumer can switch on it; old
  consumers ignore unknown values.

Pass-through is right. **Spec must say this.** Two-line change: in the
mapping function, default to `event = state` for unknown states, emit a
single `'warning'` event with `{ unknownState: state }`.

This is the kind of forward-compat detail that makes pg-boss minor bumps
absorbable per success criterion #5.

## 8. Issue #1 constraint check — no violations found

I went through each non-goal and each load-bearing constraint:

- Audit writes fail-open ✓ — preserved in the trigger's `EXCEPTION` block.
- Per-event budget ✓ — one `pg_notify(text, text)` call; produces the
  number #12 needs.
- API-shape principle (composition) ✓ — `subscribe()` is a new sibling
  method, not an overload.
- Forbidden tier ✓ — imports `pg` and `node:events` only.
- Symmetric uninstall ✓ — channel and trigger both go with the schema.
- Non-goal: observability platform ✓ — events emitted, no spans/exporters.
- Non-goal: queue runtime mutation ✓ — read-side only.

No quiet violation. Design holds.

## 9. Test plan — `pg_terminate_backend` is necessary but not sufficient

The test plan covers ~60% of real failure surfaces. Gaps that give false
confidence:

- **PgBouncer transaction-mode**. Cannot be reproduced in testcontainers
  with stock Postgres alone — would need a PgBouncer testcontainer or a
  manual integration test. At minimum, document it as a known-unsupported
  configuration in `COMPATIBILITY.md`.
- **`idle_in_transaction_session_timeout`**. The LISTEN connection is
  technically idle. If a consumer sets this server-side, the connection
  gets killed. Add a test: set `idle_in_transaction_session_timeout =
  '1s'`, hold the LISTEN connection idle, assert reconnect.
- **`tcp_keepalives_idle` mismatch with NAT timeout**. Common cloud
  network issue — silent connection death without `error` event firing for
  a long time. Add a `keepalive` recommendation to the README.
- **Notification flood (catch-up under load)**. Submit 10k jobs that
  complete in rapid succession; assert the subscriber keeps up; measure
  per-event JS-side latency. Probes the NOTIFY async-queue depth and the
  subscriber's parsing throughput.

The static-grep-test for Forbidden imports is good practice — keep it.

## 10. Missing from v1

In rough priority order:

1. **Monotonic sequence column** — see vector 2. Without this the durable
   replay promise is best-effort at best.
2. **PgBouncer compatibility note** — see vector 1.
3. **Streaming-replication / failover behavior** — see vectors 1 and 4.
4. **Unknown-state fallback** — see vector 7.
5. **Exponential backoff** — see vector 5.
6. **`AbortSignal` + `Symbol.asyncDispose`** — see vector 6.
7. **Ordering between per-type and `'job'` events** — spec doesn't say
   which fires first. Spec must say: per-type fires first, then `'job'`.
   (Implementation: emit `'created'` first, then `'job'`. One line.)
8. **Backfill behavior** — spec doesn't say (correct answer: backfill INSERTs
   into `pgbossier.record` directly, not via the `pgboss.job` trigger, so
   backfilled rows produce no events). Worth one sentence in the design.

## Verdict — Round 1

**SHIP WITH NAMED CHANGES.**

Blocking (must land before merge):

- CHANGE: Add `seq BIGSERIAL` column to `pgbossier.record`; include in NOTIFY payload; ship `getEventsSince(seq)` catch-up method. Without this the at-most-once-plus-replay contract is broken.
- CHANGE: Document PgBouncer transaction-mode incompatibility prominently in `COMPATIBILITY.md` and README. Probably the #1 production gotcha for the primary consumer.
- CHANGE: Replace fixed 1s reconnect with exponential backoff to 30 s cap + ±20 % jitter.
- CHANGE: Define unknown-`state` fallback (pass-through with `event = state`, emit `'warning'`).

Non-blocking (should land in v1, doesn't block):

- CHANGE: Add `AbortSignal` support to `subscribe()` and implement `Symbol.asyncDispose` on `BossierEvents`.
- CHANGE: Document streaming-replication / failover behavior in Risks table + COMPATIBILITY.md.
- CHANGE: Specify per-type vs `'job'` event ordering in spec.
- CHANGE: One sentence on backfill behavior.
- CHANGE: Add `idle_in_transaction_session_timeout` + keepalive notes to README.
- CHANGE: Add notification-flood test to the test plan.
