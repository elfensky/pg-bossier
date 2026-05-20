## Purpose

Set the numeric per-event overhead budget that gives "stay close to pg-boss" (Goal 8) enforceable teeth. Without a number, the constraint in #1 is unenforceable.

## Parent

Sub-issue of #1 (cross-cutting — gives Goal 8's "stay close" constraint enforceable teeth; budgets every other goal's implementation).

## Decisions to make

- **Budget unit.** Absolute (e.g., "audit write must complete in <2ms p99") or relative (e.g., "<10% overhead vs pg-boss baseline")?
- **Numeric target.** Concrete value(s). Suggested anchors:
  - Audit-write overhead: target <2ms p99 per job state change
  - Event emission overhead: target <1ms p99
  - Read-path overhead: targets per method (`findById` <5ms p99, `listActive` <50ms p99 for 1000-job result, etc.)
- **Measurement methodology.** How does CI measure these — synthetic benchmarks against a fresh Postgres, or production-shape workloads?
- **Budget violation policy.** Hard block on PR? Warn-only with merge override? Tied to release process?
- **Per-feature budget allocation.** Each goal's implementation gets a fraction of total overhead budget. Confirm the split.
- **Reporting cadence.** Is the performance dashboard updated per-PR, per-release, or on a separate cadence?

## Out of scope

- The actual performance optimizations to achieve the budget (per-goal sub-issues).
- Test-coverage targets (separate operational concern).

## Blocked by

#1 — pending agreement on the refined scope.
