> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). The install migration (schema + table + trigger + backfill) and uninstall (`DROP SCHEMA pgbossier CASCADE`) are specified in the [substrate spec](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-substrate-spec.md). This issue decides delivery — CLI vs programmatic vs SQL file — and distribution shape.

## Purpose

Decide the install + uninstall surface — distribution shape, migration tooling, and Prisma coexistence — that delivers the <1hr-install / clean-uninstall promise.

## Parent

Sub-issue of #1 (Goal 9 — One-step install, symmetric uninstall).

## Decisions to make

- **Distribution shape.** Single npm package, monorepo with main + adapters, or separate Prisma adapter? Each affects the install experience.
- **Migration tooling.** Raw SQL file the user runs with `psql`, custom Node script (`npx pg-bossier migrate`), Prisma migration consumers compose into their migration history, or some combination. Trade-offs: idempotency, Prisma coexistence, re-runnability, rollback support.
- **Idempotency.** Should the install migration be safe to re-run? Modern migrations usually are.
- **Schema name.** Confirm `pgbossier` as the schema name. Allow override via config?
- **Uninstall command / docs.** Ship `npx pg-bossier uninstall` CLI that runs `DROP SCHEMA pgbossier CASCADE`, or document the SQL only?
- **Versioning across pg-bossier upgrades.** When pg-bossier 0.3 changes the audit schema, how does an existing 0.2 install migrate? Forward-only with breaking-change docs, or rollback-capable?
- **Symmetric-uninstall verification.** What does CI assert to verify "uninstall leaves zero pgbossier remnants"? Listing all DB objects in pgbossier schema after CASCADE, checking for orphaned LISTEN/NOTIFY channels, etc.
- **Multi-database / multi-schema.** Does pg-bossier support pg-boss configured against a custom schema? Multiple pg-boss instances in one Postgres database?

## Out of scope

- The audit table schema itself (Goal 1).
- TypeScript generics surface (cross-cutting sub-issue).

