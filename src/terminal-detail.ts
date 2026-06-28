import type { BossierDb } from './db.js';
import { stringifyOrThrow } from './json.js';
import { UUID_RE, type SchemaNames } from './sql.js';

/**
 * `terminal_detail` shape for a `completed` row. Any plain object — pg-bossier
 * does not enforce structure on success payloads.
 */
export type TerminalDetailCompleted = Record<string, unknown>;

/**
 * `terminal_detail` shape for a `cancelled` row. Open by convention; the named
 * fields are suggestions, not requirements.
 */
export type TerminalDetailCancelled = {
  cancelledBy?: string;
  reason?: string;
} & Record<string, unknown>;

/**
 * `terminal_detail` shape for a `failed` row. `class` is required — pg-bossier's
 * single load-bearing classification. Pick `'transient'` for failures the
 * consumer expects can recover (network, rate-limit, etc.) and `'non_retryable'`
 * for failures that should give up (validation, missing data, programmer
 * errors). Other fields are open.
 */
export type TerminalDetailFailed = {
  class: 'transient' | 'non_retryable';
  message?: string;
  where?: string;
  deadLetteredAs?: string;
} & Record<string, unknown>;

/**
 * The full discriminated-union payload accepted by `recordTerminalDetail`.
 * The writer maps `state` to the allowed row states in the chronicle:
 *  - `'completed'`  → only updates rows currently in `state='completed'`.
 *  - `'cancelled'`  → only updates rows currently in `state='cancelled'`.
 *  - `'failed'`     → updates rows in `state='failed'` OR `state='retry'`
 *                     (the worker may write detail before pg-boss's retry
 *                     DELETE+INSERT lands the next attempt).
 */
export type TerminalDetail =
  | { state: 'completed'; detail: TerminalDetailCompleted }
  | { state: 'cancelled'; detail: TerminalDetailCancelled }
  | { state: 'failed';    detail: TerminalDetailFailed };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function allowedStates(state: TerminalDetail['state']): string[] {
  return state === 'failed' ? ['failed', 'retry'] : [state];
}

/**
 * Write a worker-classified terminal detail to a chronicle row, keyed by
 * `(jobId, attempt)`. The writer is bound to the row's pg-boss state — a
 * `state: 'failed'` payload only matches rows in `state='failed'` or
 * `state='retry'`; a `state: 'completed'` payload only matches `'completed'`
 * rows; likewise `'cancelled'`. A state-mismatched call is a silent no-op
 * (the UPDATE matches zero rows). A wrong `(jobId, attempt)` is the same.
 *
 * Validation (throw paths — programmer errors):
 *  - `payload` and `payload.detail` must be plain objects (not arrays,
 *    primitives, null, functions).
 *  - When `payload.state === 'failed'`, `payload.detail.class` must be either
 *    `'transient'` or `'non_retryable'`.
 *  - `payload.detail` must be JSON-serializable (no BigInt, no circular refs).
 *
 * Fail-open per issue #1's audit-write constraint (matching the other writers —
 * `setProgress` / `setClaim` / `recordInputSnapshot` / `recordDeadLetter`): a
 * runtime DB error is logged via `console.warn` and swallowed, and a malformed
 * (non-UUID) `jobId` short-circuits to a clear warning + no-op rather than a raw
 * Postgres `uuid`-cast error. A failed terminal-detail write must never fail the
 * consumer's job — the worker is *classifying* a failure, not depending on the
 * write. (A state-mismatch / wrong-`(jobId, attempt)` UPDATE matching zero rows
 * stays a deliberate silent no-op.)
 *
 * `recordTerminalDetail` is the *primary* writer of `pgbossier.record.terminal_detail`:
 * `recordDeadLetter` co-writes only the `deadLetteredAs` key via JSONB merge, and the
 * archive `importRecords` restores the column on new rows (`ON CONFLICT DO NOTHING`).
 */
export async function recordTerminalDetail(
  db: BossierDb,
  schemas: SchemaNames,
  jobId: string,
  attempt: number,
  payload: TerminalDetail,
): Promise<void> {
  if (!isPlainObject(payload) || !isPlainObject(payload.detail)) {
    throw new Error(
      'pg-bossier: terminal_detail validation: payload and detail must be plain objects',
    );
  }
  if (payload.state === 'failed') {
    const cls = payload.detail.class;
    if (cls !== 'transient' && cls !== 'non_retryable') {
      throw new Error(
        "pg-bossier: terminal_detail validation: failed state requires class in ('transient', 'non_retryable')",
      );
    }
  }
  const json = stringifyOrThrow(payload.detail, 'terminal_detail');
  // Short-circuit a malformed (non-UUID) id like the sibling writers, so a typo
  // logs a clear "malformed job id" rather than a Postgres uuid-cast error.
  if (!UUID_RE.test(jobId)) {
    console.warn(`pg-bossier: recordTerminalDetail got a malformed job id: ${jobId}`);
    return;
  }
  const states = allowedStates(payload.state);
  try {
    await db.query(
      `UPDATE ${schemas.pgbossier}.record
          SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb
        WHERE job_id = $1
          AND attempt = $2
          AND state = ANY($3::text[])`,
      [jobId, attempt, states, json],
    );
  } catch (err) {
    console.warn(
      `pg-bossier: recordTerminalDetail failed for job ${jobId} attempt ${String(attempt)}: ${String(err)}`,
    );
  }
}
