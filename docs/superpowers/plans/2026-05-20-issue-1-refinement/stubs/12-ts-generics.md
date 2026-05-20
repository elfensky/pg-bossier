## Purpose

Decide how consumers parameterize types for their job payloads. Affects every method in Goal 5 that returns a `Job`, plus progress (Goal 6) and event payload (Goal 7) types.

## Parent

Sub-issue of #1 (cross-cutting — most affects Goal 5; also Goals 6 and 7).

## Decisions to make

- **Pattern.** Choose one (or a hybrid):
  - **Inline declaration.** `bossier.findById<MyInput, MyOutput>(id)` — explicit at call site. Simple, no setup, but verbose for repeated reads.
  - **Type registration.** `bossier.register('my-queue', { input: MyInput, output: MyOutput })`, then `bossier.findById(id)` infers from the queue. Less verbose, more setup.
  - **Inference from worker.** When a worker is registered via `boss.work('my-queue', handler)`, the handler's signature defines the types. Reads against that queue inherit. Requires runtime registration order discipline.
  - **Declaration merging / module augmentation.** Consumers declare their queues in a TS module that pg-bossier merges into. Type-only, no runtime cost.
- **Default type.** When the consumer hasn't parameterized, what's the type of `Job<TInput, TOutput>`? `Job<unknown, unknown>`? `Job<JsonValue, JsonValue>`? `Job<any, any>` (worst, but easiest)?
- **Backward compatibility.** JS consumers calling the same methods see plain method calls without compile-time checks. Confirm the .d.ts surface supports this.
- **Interaction with terminal_detail / progress / input_snapshot.** Are *those* JSONB shapes also generic-parameterizable? Trade-off: full type safety vs surface complexity.
- **Documentation strategy.** Where do consumers learn the pattern? README, tsdoc, separate types-guide doc?

## Out of scope

- The method signatures themselves (Goal 5 sub-issue).
- Storage schema (Goal 1).

## Blocked by

#1 — pending agreement on the refined scope.
