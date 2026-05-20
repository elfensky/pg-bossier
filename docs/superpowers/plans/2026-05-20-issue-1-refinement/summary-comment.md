## Refinement: structure update — 2026-05-20

This issue has been refined to a clearer 9-goal structure, three explicit constraints, and a 12-sub-issue split for per-feature implementation. The full reasoning — diagnostic of the prior framing, the orthogonality decisions, the rename history, and the verification of pg-boss's actual behavior — lives in the committed design doc:

📄 [Design doc: `docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md`](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md)

### Headline changes from the prior framing

- **Goal 1 (audit table)** split out from the prior "operational data plane" bundle as its own discrete goal.
- **Goal 2 (terminal-state detail)** replaces the prior 5-value failure-class enum with a `terminal_state` (pg-boss's three real terminal values — `completed` / `cancelled` / `failed`) + `terminal_detail` (JSONB, discriminated union; `class` field mandated for `failed`).
- **Goal 3 (retry history)** renamed from the prior "lineage" — disambiguated from data lineage / provenance.
- **Goal 4 (optional input-snapshot)** — new goal: opt-in JSONB slot for consumer-supplied data-provenance.
- **Goal 5 (new APIs)** renamed from "typed query API"; body distinguishes read methods (always new pg-bossier methods; some overlap pg-boss built-ins and name a differentiator) from write extensions (deferred per-feature).
- **Goal 6 (persistent progress)** unified into one mechanism with two documented usage patterns (resumable + non-resumable).
- **Goal 7 (lifecycle events)** clarified relative to pg-boss's existing "pub/sub" feature (which is queue fan-out, not real-time events) and pg-boss#570 (declined upstream). Verified by source-search that pg-boss does NOT use Postgres LISTEN/NOTIFY today.
- **Goal 8 (compatibility tier system)** unchanged from the prior framing.
- **Goal 9 (install/uninstall)** retained from the prior framing.
- **pg-boss baseline corrected.** The prior framing assumed a `pgboss.archive` table and `expired` / `superseded` job states; pg-boss 12 has neither (verified against pg-boss 12.18.2 source). Goal 8's transitional surface now names `pgboss.job` only; Goal 2 treats `expired` / `superseded` as pg-bossier-derived refinements, not pg-boss states.

### Three constraints made explicit in the body, plus the bounded-retention non-goal

- Constraint: audit writes are fail-open (never block pg-boss).
- Constraint: per-event overhead has a published budget.
- Constraint: API-shape principle — composition, not replacement; each write feature explores both overload-pg-boss and new-pg-bossier-method shapes.
- Non-goal added: bounded retention (consumer-owned — pg-bossier writes forever).

### Sub-issues opened

Per-goal implementation (9):

- STUB_NUMBERS_HERE

Cross-cutting (3):

- STUB_NUMBERS_HERE

Each sub-issue references this issue as its rubric. Per the original framing: anything not justifiable against the goals / non-goals here gets closed with a reference to this issue.
