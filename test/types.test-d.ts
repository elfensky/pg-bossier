// Type-level tests (#16): verify the typed query API's generics actually infer,
// so a refactor that drops a type parameter (silently widening payloads to
// `any`/`unknown`) fails the build instead of shipping. Compile-time only —
// checked by `npm run test:types` (tsc --noEmit on tsconfig.test.json); never
// executed. Mirrors pg-boss's `*TypeTest.ts` pattern (#16), via tsc rather than
// vitest-typecheck to avoid a second runner.
import { expectTypeOf } from 'vitest';
import type { Bossier } from '../src/client.js';
import type { JobRecord } from '../src/read.js';
import type { ProgressResult } from '../src/progress.js';
import type { InputSnapshotResult } from '../src/input-snapshot.js';

declare const client: Bossier;

interface Order { sku: string; qty: number }
interface Receipt { shipped: boolean }

// findById threads TInput/TOutput into the returned JobRecord union.
expectTypeOf(client.findById<Order, Receipt>('id'))
  .resolves.toEqualTypeOf<JobRecord<Order, Receipt> | null>();

// data is the input type; output narrows to the output type on the terminal state.
async function _narrowing(): Promise<void> {
  const job = await client.findById<Order, Receipt>('id');
  if (!job) return;
  expectTypeOf(job.data).toEqualTypeOf<Order | null>();
  if (job.state === 'completed') {
    expectTypeOf(job.output).toEqualTypeOf<Receipt | null>();
  }

  // Negative checks: the generics are real, not silently `any`.
  // @ts-expect-error data is Order | null, not a number
  const _badData: number = job.data;
  void _badData;
}

// Default (no type args) is `unknown`, not `any` — you must narrow.
expectTypeOf(client.findById('id'))
  .resolves.toEqualTypeOf<JobRecord<unknown, unknown> | null>();

// getRetryHistory / listJobs carry the same generics.
expectTypeOf(client.getRetryHistory<Order, Receipt>('id'))
  .resolves.toEqualTypeOf<JobRecord<Order, Receipt>[]>();
expectTypeOf(client.listJobs<Order, Receipt>())
  .resolves.toEqualTypeOf<{ rows: JobRecord<Order, Receipt>[]; total: number }>();

// Progress + input-snapshot readers are generic on their own payload.
expectTypeOf(client.getProgress<{ pct: number }>('id'))
  .resolves.toEqualTypeOf<ProgressResult<{ pct: number }> | null>();

// getInputSnapshot is dual-mode: with an attempt → T | null; without → wrapped.
expectTypeOf(client.getInputSnapshot<Order>('id', 0)).resolves.toEqualTypeOf<Order | null>();
expectTypeOf(client.getInputSnapshot<Order>('id')).resolves.toEqualTypeOf<InputSnapshotResult<Order> | null>();

// setClaim is the #41a compare-and-set: resolves to boolean (won/lost).
expectTypeOf(client.setClaim('id', 'worker')).resolves.toEqualTypeOf<boolean>();

// The facade forwards pg-boss's own methods alongside pg-bossier's.
expectTypeOf(client.send).toBeFunction();
