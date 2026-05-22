# pg-bossier — Unified Client — Design

- **Status:** Draft v1 — awaiting review
- **Date:** 2026-05-22
- **Author:** elfensky, with claude-code
- **Builds on:** the shipped substrate (`src/client.ts`), `2026-05-21-goal-5-read-api-design.md`
- **Target:** no sub-issue yet — see [§ Process note](#process-note)

## Scope

Make `bossier({ boss, pool })` return **one client** that exposes pg-boss's
whole API *and* pg-bossier's own methods on a single flat surface. Today a
consumer uses two surfaces — `client.boss.send()` for queue ops and
`client.findById()` for pg-bossier reads. This design removes that split.

**In scope:** the client's return shape and type, the forwarding mechanism,
how pg-bossier's methods sit alongside pg-boss's, the name-collision rule,
the knock-on doc/test changes.

**Out of scope:** the read-method set and signatures (settled — Goal 5,
PR #17), write-extension APIs (Goals 2/4/6), lifecycle events (Goal 7),
`install`/`uninstall` (unchanged — they are standalone functions).

## Background — the two-surface problem

The substrate's `bossier({ boss, pool })` returns a `BossierClient` whose
shape is `{ boss: PgBoss, recordPatch, findById, getRetryHistory, listJobs,
latestPerQueue, countByState, countByQueue, listLongRunning }`. Queue
operations are reached through `client.boss.*`; pg-bossier's own methods sit
on `client.*`. A consumer manages jobs through two objects.

Issue #1's API-shape principle already sanctions the fix: it lists
"**(c) wrapping client that intercepts pg-boss calls**" as an allowed way for
pg-bossier to attach to pg-boss. A wrapper that *delegates* to pg-boss is
composition, not replacement — it does not cross the "don't replace queue
ops" non-goal.

One consequence to record: README's **How it works** currently says
*"pg-bossier never sits between your application and pg-boss."* That is true
of the **capture path** — history is recorded by a database trigger — but
once the client wraps pg-boss, it *does* sit in front for the **API
surface**. The statement must be reworded (see [§ What changes](#what-changes-elsewhere)).

## Verified facts (pg-boss 12.18.2)

These were checked against the installed `node_modules/pg-boss` and drive the
mechanism below:

- **`export class PgBoss extends EventEmitter`** — the client must also carry
  the EventEmitter surface (`on` / `once` / `off` / `emit`).
- **pg-boss uses `#private` class fields** (in `boss.js`, `manager.js`,
  `index.js`, `bam.js`, `spy.js`). This makes method binding mandatory — see
  the mechanism.

## Design

### 1. Entry point and return shape

`bossier({ boss, pool })` keeps its exact signature. Only the return value
changes:

```ts
type Bossier = PgBoss & BossierMethods;

interface BossierMethods {
  recordPatch(jobId: string, attempt: number, patch: RecordPatch): Promise<void>;
  findById<TInput = unknown, TOutput = unknown>(jobId: string): Promise<JobRecord<TInput, TOutput> | null>;
  getRetryHistory<TInput = unknown, TOutput = unknown>(jobId: string): Promise<JobRecord<TInput, TOutput>[]>;
  listJobs<TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts): Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }>;
  latestPerQueue(queues: string[], opts?: { states?: JobState[] }): Promise<JobRecord[]>;
  countByState(filter?: JobFilter): Promise<Record<JobState, number>>;
  countByQueue(filter?: JobFilter): Promise<Record<string, number>>;
  listLongRunning(opts?: { queue?: string; longerThanSeconds?: number; limit?: number }): Promise<JobRecord[]>;
}

function bossier(options: BossierOptions): Bossier;
```

- The pg-bossier method signatures are **unchanged** from today — they are
  only relocated from `BossierClient` onto the unified surface.
- **No `.boss` property.** The wrapper is the only surface. (Considered and
  rejected: under the proxy mechanism it forwards everything anyway and
  `instanceof` still works, so an escape hatch earns nothing — it only
  invites the two-surface habit back. CLAUDE.md's KISS/YAGNI applies.)

### 2. The forwarding mechanism — a `Proxy`

The client is a `Proxy` wrapping the pg-boss instance. Its `get` trap:

1. If the property is one of `BossierMethods` → return pg-bossier's
   implementation (closed over the `pool`).
2. Otherwise → read the member off the pg-boss instance; if it is a function,
   return it **bound to the real instance**.

**Why methods must be bound.** A method invoked as `client.send()` runs with
`this` = the proxy. The moment pg-boss's code touches a `#private` field, V8
throws `TypeError: Cannot read private member ... from an object whose class
did not declare it`. Binding each forwarded function to the underlying
instance makes `this` the real object, so private fields resolve. This is
required, not defensive — pg-boss 12 uses private fields (verified above).

**Why a `Proxy` and not the alternatives.** `Object.assign` copies only own
enumerable properties — it misses pg-boss's methods, which live on the class
prototype. `Object.create(boss)` plus own pg-bossier properties hits the same
`this`/private-field problem and is awkward to type. Subclassing was rejected
in design Q1 — pg-bossier wraps an instance the consumer constructs, it does
not construct pg-boss itself. A `Proxy` is the only mechanism that forwards
the entire prototype surface — EventEmitter methods, and any method a future
pg-boss minor adds — with no per-method maintenance.

`client instanceof PgBoss` stays `true`: a `Proxy` forwards prototype
lookups, so identity checks against `PgBoss` still pass.

### 3. pg-bossier's methods — flat, with a collision guard

The eight `BossierMethods` sit flat on the client, indistinguishable in
call-shape from pg-boss's methods (`client.findById()` beside
`client.send()`). This is the seamless single surface the consumer asked for.

Because the `get` trap checks `BossierMethods` *first*, a pg-bossier method
*can* shadow a pg-boss method. The **rule**: it must not — except as a
deliberate, documented override (this leaves room for Goal 2's possible
`fail` overload, which is issue #3's decision, not an accident here). Today
there are zero collisions by design: pg-bossier uses `findById` (pg-boss has
`getJobById`), `listJobs` (pg-boss has `findJobs`). A unit test asserts the
`BossierMethods` key set does not intersect `PgBoss`'s prototype method
names, so an accidental future collision fails CI loudly.

### 4. Edge cases and risks

- **Private fields** — handled by binding (mechanism §2). An integration test
  proves a forwarded queue op actually works through the proxy.
- **Events** — `client.on('error', …)` / `'wip'` / `'stopped'` forward and
  bind to the real instance, which is exactly where pg-boss emits from, so
  listeners registered through the client are seen.
- **`on` / `once` return `this`** — through a bound forward they return the
  *raw instance*, not the proxy, so an `client.on(…).on(…)` chain operates on
  the raw instance after the first call. Functionally harmless (same
  EventEmitter). Optional one-line fix: special-case the listener methods to
  return the proxy. Decided in the implementation plan, not pre-committed
  here.
- **`then`** — pg-boss is not a thenable and exposes no `then`; the proxy
  forwarding a missing `then` yields `undefined`, so `await client` is inert.
  No action needed.

## What changes elsewhere

- **`src/client.ts`** — rewritten: `bossier()` builds and returns the proxy;
  the `BossierClient` interface is replaced by the `Bossier` /
  `BossierMethods` types.
- **`src/index.ts`** — export the renamed type(s).
- **`README.md`** — two edits. (a) The Usage example loses `client.boss.*`
  (`client.boss.createQueue` → `client.createQueue`, `client.boss.send` →
  `client.send`). (b) **How it works**: the line *"pg-bossier never sits
  between your application and pg-boss"* is reworded — the capture stays in
  the trigger, but the client is now a thin pass-through in front of pg-boss;
  the mermaid diagram's `bossier client` node moves in front of the `pg-boss`
  node.
- **`test/client.test.ts`** — updated to the new shape. The test harness's
  own `h.boss` (a raw pg-boss instance the harness owns for test *setup*) is
  independent of the client API and does not change.
- **`CHANGELOG.md`** — a `Changed` entry under `[Unreleased]`.
- This is a **breaking change to pg-bossier's own client API**. Acceptable:
  the package is `0.0.0`, unpublished, and CLAUDE.md states the `0.x` API is
  unstable.

## Decisions taken

| Decision | Resolution |
|---|---|
| Ownership / lifecycle | pg-bossier **wraps** a pg-boss instance the consumer constructs and starts — it does not own pg-boss's constructor or lifecycle. `bossier({ boss, pool })` keeps its signature. |
| Escape hatch | **No `.boss`.** The wrapper is the only surface. |
| Forwarding completeness | **Total** — every pg-boss method is reachable, including future additions. |
| Mechanism | A `Proxy` over the instance; forwarded methods **bound** to the real instance (private-field requirement). |
| pg-bossier method layout | **Flat** — alongside pg-boss's methods, signatures unchanged. |
| Collisions | `BossierMethods` resolved first; rule = no unintentional shadowing; CI test guards the name sets. |

## Decisions deferred / open

1. **`on`/`once` returning the raw instance vs the proxy** — harmless either
   way; the optional fix is decided in the implementation plan.
2. **Whether Goal 2's `fail` overload uses the (now sanctioned) shadowing
   path** — issue #3's decision, not this design's.

## What this design does NOT decide

- The read-method set, signatures, or `JobRecord` type (settled — Goal 5).
- Any write-extension API (Goals 2/4/6) or lifecycle events (Goal 7).
- The exact proxy code and its TypeScript assertions — that is the buildable
  spec / implementation plan.

## Testing

Integration tests against real pg-boss via `@testcontainers/postgresql`, no
mocks, on the existing harness:

- One client object both runs queue ops (`client.send` / `fetch` /
  `complete`) and reads history (`client.findById` / `listJobs`) — the
  unified surface end to end.
- A forwarded queue op works through the proxy — proves the private-field
  binding is correct.
- `client instanceof PgBoss` is `true`.
- `client.on('error', …)` receives an emitted error.
- The name-collision guard: `BossierMethods` keys do not intersect `PgBoss`
  prototype method names.

## Process note

This is a foundational public-API decision. Issue #1's API-shape principle
*names* the wrapping-client option as allowed, but no issue tracks the
**decision to adopt it as the base client shape**. Per CLAUDE.md ("touches an
undecided area → open an issue first"), a short issue should be opened to
record this decision before implementation.

## Next step

On approval: `superpowers:writing-plans` for the task breakdown — the proxy
built test-first against a real pg-boss container, then the doc and test
updates.
