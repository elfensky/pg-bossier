import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { recordPatch, type RecordPatch } from './record.js';

export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
}

export interface BossierClient {
  /** The underlying pg-boss instance — its queue ops are used unchanged. */
  boss: PgBoss;
  /** Write the app-hook-owned columns of a record row. */
  recordPatch: (jobId: string, attempt: number, patch: RecordPatch) => Promise<void>;
}

/**
 * The app-hook wrapping client skeleton. v1 exposes the pg-boss instance for
 * queue ops plus `recordPatch`; the per-goal write features (terminal_detail,
 * progress, input_snapshot — issues #3/#5/#7) build their methods on this.
 */
export function bossier(options: BossierOptions): BossierClient {
  const { boss, pool } = options;
  return {
    boss,
    recordPatch: (jobId, attempt, patch) => recordPatch(pool, jobId, attempt, patch),
  };
}
