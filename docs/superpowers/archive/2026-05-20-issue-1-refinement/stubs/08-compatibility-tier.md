> **Architecture update — 2026-05-20.** Issue #1 is agreed; the storage / capture / query architecture is settled in the [storage-architecture design](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-20-storage-architecture-design.md). The capture trigger is DDL on `pgboss.job` — this issue must tier it explicitly as Transitional.

## Purpose

Produce the compatibility tier document and CI matrix configuration that make pg-bossier's "stay close to pg-boss" promise enforceable.

## Parent

Sub-issue of #1 (Goal 8 — pg-boss compatibility tier system).

## Decisions to make

- **Stable tier membership.** Confirm the full list of pg-boss public API methods pg-bossier depends on: `send`, `fetch`, `complete`, `fail`, `work`, `touch`, `cancel`, `start`, `stop`, `findJobs`, `getQueueStats`, `getWipData`, others? Each named in the tier doc. pg-boss's ORM transaction adapters (`fromKnex` / `fromKysely` / `fromPrisma` / `fromDrizzle`) also need a tier — Stable for the function names, Transitional for the ORM-version-coupled wrapped types.
- **Transitional tier membership.** Confirm the list of `pgboss.*` tables / columns pg-bossier reads from: `pgboss.job` columns, `pgboss.queue` columns (if any), the schema version. Note: pg-boss 12 has **no `pgboss.archive` table** — do not list one.
- **Forbidden tier enumeration.** Which pg-boss internals are explicitly off-limits? Anything in `node_modules/pg-boss/src/*`, undocumented events, private SQL not in the public docs, and the `pgboss.bam` table and other internal maintenance machinery.
- **CI matrix config.** Supported pg-boss version set: latest + N-1 + N-2 minors, or some other window? Test runner integration (which pg-boss versions get installed in which CI jobs).
- **Detection of forbidden-tier violations.** Lint rule? Static analysis? Manual review checklist?
- **Cadence for updating the tier doc.** Updated on every pg-bossier PR that touches pg-boss APIs? Or on a separate audit cadence?
- **Definition of "supported within ~2 weeks".** Is "within 2 weeks of upstream publication" measured by: PR opened, PR merged, npm-published? Confirm.

## Out of scope

- Implementation details of how each goal uses pg-boss APIs (that's per-goal-sub-issue).
- Numeric per-event performance budget (cross-cutting sub-issue).

