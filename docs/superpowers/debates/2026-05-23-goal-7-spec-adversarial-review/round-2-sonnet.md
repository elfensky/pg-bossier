# Sonnet critique — Round 2

---

## Concessions

**Codex: `pgbossier.record` is one row per `(job_id, attempt)` via `ON CONFLICT DO UPDATE` — intermediate states are overwritten**

Codex raised this explicitly in vector 2: "a missed `started` event is overwritten by `completed`; there is no durable per-transition log to replay from." I raised the cursor-correctness problem (no monotonic column, `captured_at` non-unique) in my Round 1 vector 2, but I did not push this far enough. The table schema means the "durable replay" promise is not just awkward-to-query — it is architecturally incomplete. A `started` transition that fired, was missed during a gap, and was then overwritten by `completed` before the catch-up query runs is gone from the audit table entirely. The catch-up SELECT cannot recover it because the row no longer carries the intermediate state. My Round 1 framed this as a cursor problem; Codex correctly frames it as a deeper structural problem: the audit table was not designed to be an event log, and the spec's claim that "durable replay is available" is overstated. I concede this. The `seq` column I proposed in Round 1 is necessary but not sufficient — it solves cursor ordering but not the overwritten-intermediate-state problem.

**Opus: ordering between per-type and `'job'` events is unspecified**

Opus raised in vector 10: "spec doesn't say which fires first. Spec must say: per-type fires first, then `'job'`." I did not catch this. It is a one-line spec fix, but without it the implementation is underdetermined and consumers writing code like `events.once('failed', markDead); events.on('job', updateMetrics)` cannot rely on ordering. Conceded.

**Codex: handler-throw behavior departs from standard `EventEmitter` contract**

Codex raised in vector 6: "the spec misstates Node semantics: 'Handler throws | Caught, routed to `'error'`' is not how ordinary `EventEmitter` listeners behave." This is correct. Standard `EventEmitter.emit()` does not wrap listener calls in try/catch. The spec's error table implies pg-bossier's implementation will catch thrown handlers and re-emit them as `'error'` — which means the implementation must explicitly wrap listener invocations, which is non-standard behavior that consumers may not expect. I called out the type mismatch (`[Error]` vs `[unknown]`) but did not challenge whether wrapping thrown handlers is even the right semantic. Codex is right that this needs explicit justification in the spec, not just an implementation note. Conceded on this being a spec gap that needs resolution.

**Opus: backfill behavior is unspecified**

Opus raised: "spec doesn't say (correct answer: backfill INSERTs into `pgbossier.record` directly, not via the `pgboss.job` trigger, so backfilled rows produce no events)." This is a real omission I missed. If `install()` backfills existing jobs through the trigger path, those backfill INSERTs fire `pg_notify` on install, which means a consumer that calls `subscribe()` shortly after `install()` could receive a flood of events for jobs that completed weeks ago. The spec says nothing about this. Conceded.

---

## Rebuttals

**Codex: "BLOCK UNTIL the design defines a correct durable replay boundary for gaps"**

The BLOCK verdict is too strong for this specific issue. The spec's at-most-once contract is stated explicitly and correctly: "Delivery contract is at most once, with gap signalling — durable replay is available by reading the audit table." The gap signal works — the consumer receives an `'error'` and knows a gap happened. The problem is that the catch-up read cannot be performed correctly against the current schema. But this is a documentation failure and a schema gap, not a design failure requiring a block. The fix is: add `seq`, add `getEventsSince(seq)`, and update the spec to honestly document what intermediate-state overwrite means for catch-up. The transport design, the subscription API, and the connection lifecycle are all sound. Blocking the entire design on the cursor problem overstates the blast radius.

Codex also issues a BLOCK for the performance gate issue. I agree the spec's "informational, not a release gate" language directly contradicts issue #1's "exceeding the budget blocks release" — I raised this in my Round 1. But this is a sentence fix in the spec, not an implementation blocker. The change is: remove "informational, not a release gate" and replace with "this number lands in issue #12; if it exceeds the budget agreed there, implementation is gated." That is a one-line spec edit, not a reason to block.

**Codex and Gemini (via the Round 1 Gemini file reference in round-1-gemini.md — the file is the Gemini critique): channel parameterization for multi-tenancy**

Codex argues in vector 10: "Hardcoding `pgbossier_job` prevents multiple environments (staging/prod) from sharing the same Postgres instance." This concern is real but out of scope for the stated design constraints. Issue #1 says symmetric uninstall is `DROP SCHEMA pgbossier CASCADE` — which assumes one pg-bossier install per database. Multiple pg-bossier environments sharing a single Postgres database is a configuration the library explicitly does not support. The channel name is namespaced with `pgbossier_*` per issue #1's namespacing constraint. The multi-tenancy argument assumes a deployment topology the spec does not claim to support. Rebutted.

**Codex and Opus: exponential backoff is a "must-have" for production**

Both Codex and Opus escalated the fixed-1s reconnect to a blocker or near-blocker. Opus writes: "A 30-minute outage is 1,800 connection attempts per subscriber. Per replica. At a four-replica web tier + one worker tier, that's 9,000 attempts during a single outage." The math is correct. But the spec's risk table already lists "Reconnect storm against Postgres" with "Low — single subscriber, single connection." The correct argument is not that the spec misidentifies the risk — it is that the risk assessment is wrong once you count subscribers across processes, which is not the same as "one subscriber." I raised this in my Round 1 vector 5. However, I still hold that this is a CHANGE, not a blocker. Exponential backoff with a cap does not change the API surface and does not block consumers from using the library. A BLOCK requires that the as-written design cannot ship — the reconnect storm risk is real but the library is usable without the fix; it just has worse behavior under extended outages. The correct verdict remains SHIP WITH NAMED CHANGES, with backoff in the must-land list.

**Opus: "Replace fixed 1s reconnect with exponential backoff... Worth pushing into v1"**

I agree with Opus's reasoning here and want to sharpen the priority: backoff belongs in the must-land list, not the nice-to-have list. Opus puts it as "must land before merge." I agree. The YAGNI dismissal in the spec is wrong once you accept that descent-app runs multiple replicas. Moving this to the must-land column.

**Codex: `addListener`, `removeListener`, `prependListener`, `rawListeners` are untyped**

This is a minor friction point, not a bug. TypeScript consumers using those methods through `BossierEvents` will fall back to the base `EventEmitter` signatures, which accept `string | symbol`. That is type-loss, not type-error. The practical impact is zero: no consumer should be calling `prependListener` on `BossierEvents` — that is an internal dispatch concern. Rebutted as not material.

---

## Escalations

**The `ON CONFLICT DO UPDATE` schema and the "durable replay" claim are jointly broken in a way none of us fully articulated**

Codex identified that intermediate states are overwritten. I identified that the cursor (`captured_at`) is non-unique. Opus identified that `seq` plus `getEventsSince` would fix the cursor. But combining these: even with a `seq` column, the audit table as designed cannot serve as a replay log for intermediate states because the `ON CONFLICT DO UPDATE` upsert overwrites the row in place. A job that transitions `created → active → failed` produces three `pg_notify` calls but only one final audit row (the `failed` row). A `getEventsSince(seq)` query would return only the final state row, not the three intermediate transitions. 

This means the spec's architectural claim — "durable replay is available by reading the audit table" — is only true for the *final state* of a job, not for the full transition sequence. A consumer that misses a `started` event during a gap cannot recover it from `pgbossier.record` even with `seq` and `getEventsSince`, because the row has been overwritten by the time the catch-up runs.

The correct fix has two mutually exclusive paths:
1. Change the audit table to be append-only (one row per transition, not per `(job_id, attempt)`) — this is a schema change on an already-shipped table.
2. Honestly document that "durable replay" means "you can find the final state of any job," not "you can reconstruct the full transition sequence," and remove any claim that intermediate transitions are recoverable from the audit table.

Path 2 is consistent with the existing schema and does not require a migration. Path 1 is the architecturally correct answer but conflicts with Goal 1's delivered schema. This tension needs an explicit decision in the spec, not silence.

**The `'error'` event carries three semantically different situations with no discriminant — and now I see a fourth**

In Round 1 I argued that connection drop, parse error, and handler throw are three different situations that need different consumer responses. Codex's critique adds a fourth that I missed: the spec says `pg_notify` failure inside the trigger is caught by `EXCEPTION WHEN OTHERS` and results in a `RAISE WARNING` — but this is a SQL-side failure that is completely invisible to the JS `'error'` subscriber. The JS consumer has no way to know that a `pg_notify` call inside the trigger failed and no event was emitted. This is correct behavior (fail-open), but it means there is a class of gaps that produce no `'error'` event at all: the trigger fires, the audit row is rolled back (see spec note 1: "PL/pgSQL's implicit savepoint rolls back the INSERT too"), but the pg-boss op succeeds and no subscriber-level `'error'` fires. The consumer has no way to detect this gap without polling the audit table independently.

The spec claims three failure surfaces with three rules, but the SQL-side failure surface produces a gap that the JS-side gap signal does not cover. This is not a new problem — it existed in Goal 1's design — but Goal 7's addition of `pg_notify` inside the same savepoint block makes the SQL-side silent-failure surface wider. The spec should document this explicitly: the `'error'` gap signal covers connection drops, not SQL-side capture failures.

**Failover + reconnect: the "successful reconnect" is not always clean**

Opus correctly identified that after a primary failover, the subscriber reconnects to what may now be a standby. But there is a further step neither of us articulated: after a successful reconnect (the `pool.connect()` call succeeds, `LISTEN` runs cleanly), the spec emits one `'error'` to signal the gap. But if the subscriber reconnected to a standby that is now serving as the primary (primary failover completed), `LISTEN` on the new primary works and events will flow. If the subscriber reconnected to a standby that has not yet been promoted, `LISTEN` runs cleanly but zero events will arrive because `NOTIFY` is never delivered on a standby. The subscriber sees: reconnect success, one `'error'` emitted, then silence. The consumer interprets the `'error'` as a recoverable gap and does a catch-up read — which also works because the new primary's data is there. But new events will never arrive. This is the same silent-failure mode as PgBouncer transaction pooling: the connection is alive, `LISTEN` executed without error, but events are never delivered. The spec lists "Postgres restart" in the reconnect table as producing "One `'error'`, then events resume" — but for failover to an unpromoted standby, "events resume" is false. This scenario needs to be explicitly called out and distinguished from a clean Postgres restart.

---

## Final position

**SHIP WITH NAMED CHANGES**

### Must land before merge

1. **Document that "durable replay" means final-state recovery only, not intermediate-state sequence recovery.** Remove the implication that a consumer can reconstruct a full transition sequence from `pgbossier.record` after a gap. The audit table stores one row per `(job_id, attempt)` via upsert; intermediate states are overwritten. Either add a sentence to the "Connection-gap handling" decision that makes this explicit, or change the schema to append-only. Changing the schema is the correct long-term answer; for v1, honest documentation is the minimum bar.

2. **Add `seq BIGSERIAL` (or equivalent) to `pgbossier.record` and include it in the NOTIFY payload.** Without a monotonic cursor, catch-up reads against the audit table cannot be ordered correctly even for final-state recovery. `captured_at` is non-unique at millisecond resolution under real load. This is a schema change on a shipped table — it needs to happen before Goal 7 ships, not after.

3. **Replace fixed 1s reconnect with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s cap) plus ±20% jitter.** The YAGNI dismissal fails once you count subscribers across multiple processes. descent-app runs multiple replicas; a 30-minute outage produces thousands of connection attempts. This is a must-land change, not a v2 follow-up.

4. **Document PgBouncer transaction-mode incompatibility prominently** — in `COMPATIBILITY.md` under a new "Unsupported configurations" section and in the README's prerequisites section. This is the most common real-world failure mode for the primary consumer.

5. **Define the unknown-state fallback behavior explicitly.** The spec does not say what `event` value is emitted for an unrecognized `state` from a future pg-boss version. The implementation must specify: fall through to `event = state` (pass-through), emit on `'job'` only (drop the typed event), or throw. Pass-through with a `'warning'` event (per Opus's suggestion) is the right answer. Spec must say this before code is written.

6. **Change the performance probe from "informational, not a release gate" to a conditional gate tied to issue #12.** The spec directly contradicts issue #1's "exceeding the budget blocks release." This is a one-line fix in the spec.

7. **Specify per-type vs `'job'` event ordering.** Per-type fires first, then `'job'`. One sentence.

8. **Document SQL-side gap coverage.** The `'error'` gap signal covers connection drops; it does not cover SQL-side `pg_notify` failures caught by `EXCEPTION WHEN OTHERS`. Those produce no subscriber-level signal. Add a sentence to the "Error handling and fail-open boundaries" section that makes this clear.

### Nice to have before merge (does not block)

- Add `AbortSignal` support to `subscribe()` and implement `Symbol.asyncDispose` on `BossierEvents`.
- Document streaming-replication / failover behavior in the Risks table — specifically the silent-failure case where `LISTEN` succeeds on a standby but events never arrive.
- One sentence on backfill behavior during `install()`: backfill goes directly to `pgbossier.record` without firing the trigger, so no events are emitted for historical jobs.
- Fix the `error` event type in `BossierEventsMap` from `[Error]` to `[unknown]`.
- Add a `reason` discriminant to the `'error'` payload (`'gap' | 'parse' | 'handler'`) so consumers can respond without parsing `err.message`.
- Document `MaxListenersExceededWarning` risk for consumers adding many `'job'` listeners; recommend `setMaxListeners(0)` for metrics use cases.
