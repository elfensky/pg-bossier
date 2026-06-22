// Re-export pg-boss's entire public module surface (the `PgBoss` class, the
// `fromPrisma` / `fromKnex` / `fromKysely` / `fromDrizzle` ORM adapters, and
// every type) so a consumer imports everything from `pg-bossier` — the
// module-level half of the "complete single surface" facade. pg-bossier's own
// named exports below take precedence on any name conflict; conflicting star
// names are dropped per ESM `export *` semantics.
export * from 'pg-boss';

export { install, uninstall } from './install.js';
export type { InstallOptions } from './install.js';
export { bossier } from './client.js';
export type { Bossier, BossierMethods, BossierOptions } from './client.js';
export type {
  TerminalDetail,
  TerminalDetailCompleted,
  TerminalDetailCancelled,
  TerminalDetailFailed,
} from './terminal-detail.js';
export type { RecordDeadLetterArgs } from './dead-letter.js';
export type { ProgressResult } from './progress.js';
export type { InputSnapshotResult } from './input-snapshot.js';
export type { JobRecord, JobState, JobFilter, ListJobsOpts } from './read.js';
export { subscribeEvents } from './events.js';
export type {
  BossierEvents, JobEvent, JobEventName,
  BossierErrorEvent, BossierWarningEvent, ErrorReason,
  SubscribeOptions,
} from './events.js';
export type { SchemaNames } from './sql.js';
export { pgBossDb } from './db.js';
export type { BossierDb } from './db.js';
export { getLiveState, getLiveHeartbeat } from './live.js';
export type { LiveState } from './live.js';
