// Re-export pg-boss's entire public module surface (the `PgBoss` class, the
// `fromPrisma` / `fromKnex` / `fromKysely` / `fromDrizzle` ORM adapters, and
// every type) so a consumer imports everything from `pg-bossier` — the
// module-level half of the "complete single surface" facade. pg-bossier's own
// named exports below take precedence on any name conflict; conflicting star
// names are dropped per ESM `export *` semantics.
export * from 'pg-boss';

// Value exports are deliberately minimal: the `bossier()` client is the single
// operational surface (every read/write/live method hangs off it), and
// `install` / `migrate` / `uninstall` are the provisioning entry points run
// without a client (migration scripts, the CLI). The per-feature free functions
// (prune, captureHealth, getLiveState, exportRecords, subscribeEvents, …) are
// NOT re-exported: they take pg-bossier's internal `(db, schemas, …)` calling
// convention, which consumers should never hand-thread — go through the client.
// Their types are still exported below for annotations.
export { install, migrate, uninstall } from './install.js';
export type { InstallOptions, InstallResult } from './install.js';
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
export type { JobRecord, JobState, JobFilter, CountFilter, ListJobsOpts } from './read.js';
export type {
  BossierEvents, JobEvent, JobEventName,
  BossierErrorEvent, BossierWarningEvent, ErrorReason,
  SubscribeOptions,
} from './events.js';
export type { SchemaNames } from './sql.js';
export type { BossierDb } from './db.js';
export type { LiveState } from './live.js';
export type { CaptureHealth } from './health.js';
export type { PruneOptions } from './prune.js';
export type { ExportFilter, ExportOptions, ImportResult } from './archive.js';
