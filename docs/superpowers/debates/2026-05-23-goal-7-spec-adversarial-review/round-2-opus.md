# Opus critique — Round 2

After reading Round 1 from Codex, Gemini, and Sonnet alongside my own, I
update my position. The strongest signal: **all four of us independently
identified PgBouncer + missing monotonic sequence as material gaps** —
that's the convergent floor for "must land before merge."

## Concessions

**To Sonnet — `'error'` event needs a discriminant.** Sonnet (vector 10):
"three semantically different situations that need different consumer
responses" — connection drop, parse error, handler throw. I had treated
one `'error'` as sufficient. Sonnet is right: a consumer who only cares
about gap signals shouldn't have to inspect `err.message` to filter out
handler-throw noise. Change accepted: emit `'error'` with
`{ reason: 'gap' | 'parse' | 'handler', error: unknown, at: Date }`.

**To Sonnet — `[Error]` should be `[unknown]`.** Sonnet (vector 6):
"thrown handler value is not necessarily an `Error` instance; it can be a
string, a plain object, or anything." Strictly correct. Type fix.

**To Sonnet — `attempt` semantics undocumented.** Sonnet (vector 10): "Does
a `created` event carry `attempt: 0`? Does a `retried` event carry the
attempt number of the retry that was just created, or the attempt that
just failed?" Spec is silent. Concrete answer (verified against pg-boss
12.18.2's retry path): `created` carries `attempt: 0`; `retried` carries
the new attempt number (`retry_count` after the retry INSERT, e.g. `1`
for the first retry). Must go in the spec with a worked example.

**To Sonnet — performance probe must be a conditional gate, not
"informational."** Sonnet (vector 8): "issue #1 explicitly says 'Exceeding
the budget blocks release.'" The spec's "informational, not a release
gate" phrasing directly contradicts the charter. Concede: probe runs;
result is checked against #12's number once #12 lands; if over, ship
blocked. The spec's "doesn't block on #12" wording stays correct (the
probe produces #12's input), but the gating clause must be rewritten.

**To Sonnet — `closed` race in reconnect loop.** Sonnet (vector 5): "the
reconnect loop as specified does not check `closed` status between the
`1000ms` wait and the `pool.connect()` call." Caught a real implementation
hole. The wait must be cancellable (Promise.race with a close signal),
and the `closed` check must happen after the wait resolves, before
`pool.connect()`. Locking this down in the spec.

**To Codex and Sonnet — fail-open path losing the audit row.** Codex
(vector 3 in "BLOCK UNTIL"), Sonnet (vector 8): if `pg_notify` fails
inside the inner `BEGIN…EXCEPTION`, the savepoint rolls back the INSERT
too — audit row lost. I called this clean atomicity in Round 1; that
framing was incomplete. With a thin bounded payload, real-world `pg_notify`
failure is vanishingly rare, but "vanishingly rare" isn't "documented as
zero." The spec must add: *if* `pg_notify` ever does fail, the audit row
is also lost; this is a known property of the same-savepoint design and
remains acceptable under issue #1's fail-open clause because it does not
block the pg-boss op. Lock that into the Risks table.

## Rebuttals

**To Codex — "BLOCK UNTIL" verdict on PgBouncer warning and fail-open
verification.** Codex escalates two documentation items to BLOCK status.
Both are CHANGE-level, not BLOCK-level. PgBouncer is a README/COMPATIBILITY
doc change plus the `'connected'`-event escalation Sonnet proposed —
non-trivial but bounded. Fail-open verification is one line in the Risks
table plus a test. Neither requires schema or API surgery, so neither
blocks shipping in the way "add a `seq` column" does. The one real BLOCK
in Codex's list is gap correctness via `seq` — and I agree with that one.

**To Codex — "include `terminal_detail` in payload" in v1.** Codex (vector
10) and Gemini (vector 3) both push for a fatter payload. I reject for
v1: `terminal_detail`'s shape is the subject of Goal 2 (#3), which has
not landed. Inlining a field whose schema isn't agreed couples the event
payload to a not-yet-existing contract — and any future tightening of
that schema becomes a breaking change to the event payload. Defer
cleanly: when Goal 2 lands, payload growth happens in that PR with its
own design. The read-amplification math also doesn't hold up under
scrutiny: descent-app's actual failure rate is single-digit per minute,
not 50/s; the amplification cited is theoretical.

**To Codex — "channel name parameterization for multi-tenancy."** Codex
(vector 10): "Hardcoding `pgbossier_job` … prevents multiple environments
from sharing the same Postgres instance." pg-boss itself doesn't support
multi-instance-per-database (singular `pgboss.*` schema). Two staging /
prod environments on the same Postgres database is a deployment
anti-pattern that we don't owe support to in v1. If two databases share
an instance, `pg_notify` is per-database — no cross-talk. YAGNI for v1;
the channel-name constant is one TypeScript change away if a real
consumer ever surfaces the need.

**To Codex — "connection exhaustion in serverless environments."** Codex
(vector 1): "100 pods = 100 idle connections." Long-lived `LISTEN`
subscriptions don't fit lambda / FaaS deployments by their nature —
those are stateless and short-lived. Subscriptions are for long-running
worker / app processes. The right answer is a README note ("subscribe()
is for long-running processes; FaaS callers should poll the read API
periodically instead"), not a design change.

**To Sonnet — specific 2PC failure claim.** Sonnet (vector 4): "`NOTIFY`
inside a prepared transaction is explicitly disallowed by Postgres — it
raises `ERROR: cannot use subtransactions during a two-phase commit`."
The error Sonnet quotes isn't the 2PC + NOTIFY error. Postgres docs
[(NOTIFY page)](https://www.postgresql.org/docs/current/sql-notify.html)
actually say: "NOTIFY interacts with SQL transactions in some important
ways. … If NOTIFY is executed inside a transaction, the notify events are
not delivered until and unless the transaction is committed. … If the
transaction was prepared with PREPARE TRANSACTION, then the notifications
are sent at the commit phase of two-phase commit." 2PC + NOTIFY is
explicitly supported, not disallowed. The broader Sonnet point — that
edge-case transaction semantics deserve a paragraph in COMPATIBILITY.md
— stands; the specific failure description does not.

## Escalations

**Health-check / `'connected'` event (escalates Sonnet's vector 10).** With
PgBouncer silently breaking LISTEN, the only signal a consumer has that
"events should be flowing" is "I haven't seen any in a while," which is
indistinguishable from a quiet system. After Round 1 I now see this is a
**must-land**, not a nice-to-have: emit `'connected'` on every successful
`LISTEN` (initial subscribe and every successful reconnect). Consumers
can wire a "no `'connected'` within 5 s of subscribe ⇒ alert" pattern as
their PgBouncer-silent-fail canary. Two extra lines in the implementation;
makes the most-invisible failure mode detectable.

**Unknown-state fallback is sharper than Round 1 implied.** Codex (vector
7), Gemini (vector 7), and Sonnet (vector 7) all hit this. Reading the
three critiques together, the design's vulnerability is bigger than my
Round 1 framing: it's a forward-compat issue that breaks pg-boss minor
absorption (success criterion #5). The fix must be in v1: unknown
`state` → emit on `'job'` only (no per-type), with `event` set to the
raw state string, and a one-time `'warning'` event (separate from
`'error'`) the first time we see each unknown state. That last piece —
`'warning'` is a distinct event from `'error'` — is the new escalation:
unknown-state-from-pg-boss isn't an error, it's a forward-compat signal.
Distinct semantics need a distinct event name.

**Failover reconnect doesn't actually detect "wrong primary."** Building on
Gemini and Sonnet's failover points: the spec's reconnect logic reconnects
to the same endpoint. After a failover, the old primary becomes a standby
serving zero notifications. The subscriber reconnects "cleanly" and waits
forever for events that will never arrive. **The `'connected'` event from
the escalation above doesn't help here** — the LISTEN succeeded; the
underlying topology is wrong. Two viable mitigations: (a) recommend
`target_session_attrs=read-write` in the connection string (driver-level
primary discovery in libpq ≥ 14 / pg-driver-supported), or (b) periodic
`SELECT pg_is_in_recovery()` from the subscriber's connection (cheap, one
query per heartbeat interval). Option (a) is the right v1 answer because
it's zero pg-bossier code and uses Postgres' own primary-discovery
mechanism. Spec must document this prominently.

## Final position

**SHIP WITH NAMED CHANGES.**

I do not agree with Codex's BLOCK UNTIL framing — none of the gaps are
the kind that require a fundamentally different design. They're all
focused additions to a sound architecture.

### Must land before merge (revised)

1. **CHANGE: Add `seq BIGSERIAL` to `pgbossier.record`** + include in NOTIFY payload + ship `getEventsSince(seq)` catch-up read. (All four critics agree.)
2. **CHANGE: Document PgBouncer transaction-mode incompatibility** prominently in README + COMPATIBILITY.md. (All four critics agree.)
3. **CHANGE: Add `'connected'` event** on every successful LISTEN as the silent-failure canary. (Escalated from Sonnet.)
4. **CHANGE: Exponential backoff (1 s → 30 s cap) + ±20 % jitter** on reconnect. (All four critics agree.)
5. **CHANGE: Unknown-state fallback** — emit on `'job'` only with `event = state`, plus a distinct one-time `'warning'` event. (All four critics flagged the absence.)
6. **CHANGE: `'error'` discriminant** — payload becomes `{ reason: 'gap' | 'parse' | 'handler', error: unknown, at: Date }`. (Sonnet.)
7. **CHANGE: `'error'` listener type** — `[unknown]`, not `[Error]`. (Sonnet.)
8. **CHANGE: Document `attempt` semantics** per event type with worked examples. (Sonnet.)
9. **CHANGE: Performance probe becomes a conditional gate** — "if probe exceeds #12's budget once #12 lands, ship is blocked." (Sonnet.)
10. **CHANGE: `closed` race in reconnect loop** — wait must be cancellable; `closed` check immediately after wait, before `pool.connect()`. (Sonnet.)
11. **CHANGE: Fail-open documents the audit-row-loss path** — if `pg_notify` ever fails inside the inner BEGIN, the savepoint also rolls back the INSERT. Acceptable under fail-open; must be stated. (Codex / Sonnet.)
12. **CHANGE: Failover / `target_session_attrs=read-write`** in COMPATIBILITY.md as the recommended primary-discovery mechanism. (Escalated from Gemini / Sonnet.)

### Nice to have in v1 (ship if cheap)

- **CHANGE: `AbortSignal` support** on `subscribe({ signal })`. (Codex + Opus.)
- **CHANGE: `Symbol.asyncDispose`** on `BossierEvents`. (Opus.)
- **CHANGE: Per-type vs `'job'` event firing order** — spec must say which fires first. (Opus.)
- **CHANGE: One sentence on backfill behavior** — backfilled rows produce no events because they bypass the `pgboss.job` trigger. (Opus.)
- **CHANGE: Test additions** — `idle_session_timeout`, notification-flood under throughput, TLS-failure variant. (All four.)

### Explicitly rejected

- Channel-name parameterization for multi-tenancy (YAGNI; pg-boss doesn't support it either).
- Inline `terminal_detail` in payload (defer to Goal 2's design).
- Serverless-aware connection management (README note suffices).
