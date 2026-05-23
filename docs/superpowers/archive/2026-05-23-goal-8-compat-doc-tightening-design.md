# Goal 8 — pg-boss compatibility doc tightening: design

**Date:** 2026-05-23
**Sub-issue:** [#9](https://github.com/elfensky/pg-bossier/issues/9)
**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
**Status:** Design — pre-implementation. Builds on the storage substrate (PR #15), the unified client (2026-05-22), and the existing `COMPATIBILITY.md` shipped with the substrate. No code yet.

---

## Summary

pg-bossier ships a doc-tightening branch that closes issue [#9](https://github.com/elfensky/pg-bossier/issues/9) by decision rather than implementation. The branch:

1. Rewrites two sections of `COMPATIBILITY.md` to (a) drop overconfident claims an adversarial debate identified as not surviving scrutiny, (b) make the no-matrix decision explicitly conditional on floor and latest pg-boss being the same version, and (c) name **cross-version correctness assertions** as the real safety net for forensic-audit correctness across pg-boss versions, with the matrix as a runtime mechanism for executing them.
2. Adds a small CI step that compares the latest published pg-boss version against the peer-dep floor in `package.json`, making the conditional-matrix tripwire **self-firing** rather than relying on a maintainer noticing.
3. Refreshes issue #9's stale body (the issue body still claims CI and the tier doc don't exist; both have shipped).
4. Opens **one** clearly-scoped follow-up sub-issue for cross-version correctness assertions on `pgbossier.record` — real test-infrastructure work that does not belong in a doc-tightening branch.
5. Closes issue #9 with a summary comment linking to the follow-up and to this design.

No changes to `src/`, no changes to the test harness, no changes to the trigger function. The branch is intentionally outside the surface area Goal 7 (Lifecycle event API, in flight in a parallel session) will modify.

---

## Context — what is already built

- **`COMPATIBILITY.md`** — 47 lines. Tier tables (Stable / Transitional / Forbidden) populated with real surfaces from the shipped substrate. Trailing "Still open (issue #9)" footer naming two unresolved items: the CI version matrix and the update cadence.
- **`.github/workflows/ci.yml`** — 25 lines. Single Node 22, no pg-boss matrix, runs lint + build + test on push to develop/main and on PRs. Inline comment: "the pg-boss matrix is tracked in #9."
- **`package.json`** — pg-boss pinned as a peer dependency at `^12.18.2`. Today both floor and latest published are `12.18.2` (pg-boss has shipped 18 minors in the last 6 months at a ~1–3 week cadence).
- **Issue #9 body** — still claims "no `.github/workflows/` directory yet" and "tier doc and CI matrix are still unbuilt." Both stale as of the substrate's merge.

---

## Decisions

### Decision 1 — Drop the time-bound support SLA

Issue #1's success criterion #5 says "pg-boss minor releases are supported within ~2 weeks of upstream publication, verified by a passing CI matrix." The "~2 weeks" was an internal complexity estimate, not a published commitment to consumers. Pre-1.0, against a peer dep that releases every 1–3 weeks, a calendar SLA would either be impossible to keep or would force a pg-bossier release on every pg-boss minor regardless of need.

**The doc states there is no time-bound SLA.** "Supported" means "the matrix and assertions pass against the version" (see Decision 2). Consumer-visibility (npm publish) follows the regular release cadence, decoupled from pg-boss's release cadence.

### Decision 2 — No version matrix today; self-firing tripwire when floor and latest diverge

Today the peer-dep floor (`^12.18.2`) and the latest published pg-boss (`12.18.2`) are the same version. A version matrix would be a one-entry list — degenerate. The original reason in the proposed prose ("CI-against-latest is enough") was identified by the debate as overconfident: column aliases on rename, type/nullability shifts, trigger-ordering changes, and upgrade-path bugs all fail **silently** — the capture trigger keeps running while `pgbossier.record` records wrong data. That is the exact failure mode the forensic audit table exists to prevent.

**The doc admits what CI-against-latest catches and what it doesn't.** It catches hard schema breaks (column we read disappears, type change the trigger cannot compile against). It does not catch silent semantic drift. Silent semantic drift is caught by **cross-version correctness assertions on `pgbossier.record`** — a follow-up sub-issue, not in this branch.

**The matrix is the runtime mechanism for executing those assertions across versions.** Without the assertions, a floor+latest matrix just broadens the set of versions on which we can silently be wrong. With the assertions and at floor == latest, the matrix is duplicate work. The matrix becomes meaningful when (a) the assertions exist and (b) floor and latest diverge — both conditions, not either.

**The tripwire is self-firing.** This branch adds a CI step that compares the latest published pg-boss version (via `npm view pg-boss version`) against the peer-dep floor declared in `package.json`. The step:

- Passes silently when floor == latest.
- Warns (does not fail) when latest is one minor above floor, with a link to issue #9 in the warning text.
- Optionally fails (or stays at warn — TBD by the implementation plan) when latest is two or more minors above floor.

The exact YAML lives in the implementation plan; the design commitment is "the tripwire has an automated observer, not a maintainer's memory."

### Decision 3 — Per-PR doc-update cadence; no periodic audit

`COMPATIBILITY.md` is edited in the same PR that adds or removes a pg-boss surface. This is a code-review expectation, not enforced automation; it will sometimes be missed. The tripwire above is the safety net for when it does. **No periodic audit cadence** — the doc is a ledger of real, in-use dependencies, not a prediction of future ones.

The original draft said "Reviewers should reject PRs that touch a new pg-boss surface without updating this doc." The debate identified this as a ghost policy — no enforcement mechanism. The revised prose names it as a soft norm and points at the tripwire as the safety net, rather than pretending the reviewer rule is itself the safety net.

### Decision 4 — Issue #9 closes by decision; one follow-up sub-issue

Issue #9 originally asked: add CI matrix, define SLA. The decisions above resolve both: no SLA, no matrix today, tripwire instead. The remaining piece — **cross-version correctness assertions on `pgbossier.record`** — is real test-infrastructure work that warrants its own scoped sub-issue, not a quiet inclusion in a doc-tightening branch.

The branch:
- Opens a new sub-issue ("Goal 8 follow-up: cross-version correctness assertions on `pgbossier.record`") with the design points the debate surfaced as the scoping rationale.
- Closes issue #9 with a summary comment naming the four decisions and linking to (a) this design spec, (b) the new sub-issue, (c) the relevant section of `COMPATIBILITY.md`.

---

## What this branch ships

### `COMPATIBILITY.md` — rewritten sections

Replace the existing trailing "Still open (issue #9)" footer (current lines 40–47) with these two new sections:

````markdown
## How this doc gets updated

This document is a ledger of real pg-boss surfaces pg-bossier currently
uses — not a prediction of future ones. When a PR adds a new pg-boss
method, column, or structural assumption, the same PR extends the table
above with that surface and its tier. This norm is a code-review
expectation, not enforced automation; it will sometimes be missed. The
floor/latest tripwire below is the safety net for when it is.

## Version support — no matrix today, self-firing tripwire

pg-bossier's CI runs against a single pg-boss version: whatever `npm ci`
resolves to inside the peer-dep range declared in `package.json`. Today
the floor and the latest published pg-boss are the same version, so a
matrix would be a degenerate one-entry list.

What CI-against-latest catches: hard schema breaks (a column we read
disappears, or changes type in a way the trigger cannot compile against),
detectable by the existing integration suite. What it does NOT catch:
silent semantic drift — a column kept as an alias on rename, a
type/nullability shift the trigger still compiles against, pg-boss
adding or reordering its own triggers on `pgboss.job`, or upgrade-path
bugs that only manifest moving from an older minor to a newer one. Those
classes of bug are caught by cross-version correctness assertions
against `pgbossier.record`, not by matrix presence alone (see follow-up
issue).

The tripwire: a CI step compares the latest published pg-boss version
against the peer-dep floor declared in `package.json`. When they
diverge, the step surfaces a warning that includes a link to this
section. The trigger to add a floor+latest matrix is **floor and latest
diverging**, contingent on cross-version correctness assertions
existing. The matrix is the runtime; the assertions are the safety. A
matrix without assertions broadens the set of versions we can silently
be wrong on.

No time-bound support SLA. The "~2 weeks" estimate in issue #1 was an
internal complexity gate, not a commitment to consumers. "Supported"
means "the existing CI passes against the version pg-boss publishes
into the peer-dep range." When the floor and latest diverge, "supported"
extends to include the correctness assertions naming what semantic
behavior is verified across versions.
````

### `.github/workflows/ci.yml` — add tripwire step

Add a new job (or step in the existing `verify` job — implementation plan decides) that:

1. Reads the peer-dep floor for `pg-boss` from `package.json` (e.g. via `node -e "console.log(require('./package.json').peerDependencies['pg-boss'])"`).
2. Runs `npm view pg-boss version` to fetch the latest published version.
3. Compares the two via a small semver check (probably `semver` from npm, already in the lockfile via transitive deps; if not, install minimally as a workflow dependency).
4. If floor == latest (same version, ignoring caret prefix): pass silently.
5. If latest > floor by one or more minors: emit a GitHub Actions warning (`::warning::`) referencing the COMPATIBILITY.md section anchor.

Step behavior:
- Always succeeds (exit 0). Does not block PR merges in v1 of the tripwire.
- May be promoted to a soft-fail or hard-fail mode in a follow-up; that decision is out of scope here.

Also: remove the existing inline comment `# the pg-boss matrix is tracked in #9` from the top of `ci.yml` — it becomes inaccurate once #9 is closed.

### Issue #9 — refresh body, close with summary

**Body refresh.** Strike the stale "no `.github/workflows/` directory yet" and "tier doc and CI matrix are still unbuilt" claims. Add a "Resolved (2026-05-23)" section at the top linking to this design spec and naming the four decisions.

**Closing comment.** Summarizes the four decisions in plain language, links to (a) this design spec, (b) the new sub-issue for cross-version correctness assertions, (c) the `COMPATIBILITY.md` anchor for "Version support — no matrix today, self-firing tripwire," (d) the `.github/workflows/ci.yml` line range for the tripwire step.

### Follow-up sub-issue — cross-version correctness assertions

Open a new GitHub issue: "Goal 8 follow-up: cross-version correctness assertions on `pgbossier.record`."

Issue body covers:
- **Why it exists** — the debate's silent-failure mode list (column aliases, type/nullability shifts, trigger-ordering changes, upgrade-path bugs). Each is caught by an assertion that pg-bossier.record rows match expected shape and content for known fixture jobs, not by matrix presence alone.
- **What it would deliver** — integration tests that run against a chosen pg-boss version (or matrix of versions, once floor/latest diverge) and assert chronicle table correctness. Test shape, test harness extension, and pg-boss version fixture strategy are the design questions in that issue, not here.
- **Trigger to schedule** — when the CI tripwire first fires (floor and latest diverge). The matrix and the assertions land together or not at all.

This branch opens the issue with this scoping; the issue itself is the next design conversation.

### `CHANGELOG.md` — `## [Unreleased]` → `Changed`

Single entry: `COMPATIBILITY.md now documents the per-PR update cadence, the explicit decision against a time-bound support SLA, and the conditional self-firing tripwire approach to cross-pg-boss-version compatibility verification. CI adds a tripwire step warning when pg-boss publishes a minor above the peer-dep floor.`

### `CLAUDE.md` — sync the Implementation-progress table

The "## What's deliberately undecided" table currently lists Goal 8 as still undecided. Update the row to: `✅ pg-boss compatibility tier doc + decision against a matrix _(done — #9 closed; correctness-assertions follow-up sub-issue opened)_`, matching the pattern used for Goals 1 / 5 / 6.

Also update the Project-status paragraph at the top of `CLAUDE.md` to mention #9's closure.

---

## Verification

Before claiming the branch complete:

- `npm run lint && npm run build && npm test` — all pass. No code touched, so no test changes expected.
- Manually trigger the new CI step locally (e.g. by setting up a feature branch in `.worktrees/` and running the workflow step's commands) to confirm the floor-vs-latest comparison works.
- Manually verify the GitHub Actions warning appears in the CI run output for a synthetic case where the peer-dep floor is temporarily lowered (revert before merging).
- Visual check: every markdown link in `COMPATIBILITY.md`, the new sub-issue body, and the #9 closing comment resolves.
- Run the COMPATIBILITY.md prose past one more read to confirm none of the five "did not survive the debate" sentence patterns sneaked back in via the rewrite (audit checklist: no "reviewers should reject," no "CI fails immediately," no "the doc itself is the lint," no `^12.18.2 today` literal, no circular "nothing to audit beyond what the code already shows").

---

## Out of scope

Explicitly out of this branch:

- **Cross-version correctness assertions on `pgbossier.record`.** Real test-infrastructure work. Its own sub-issue, opened in this branch but designed and implemented later.
- **The floor+latest version matrix itself.** Not added in this branch. The tripwire is the precondition; the matrix lands when the tripwire fires (and the assertions exist).
- **A forbidden-tier violation detector** (lint rule or static analysis that fails CI on `node_modules/pg-boss/src/*` imports or internal-table reads). Was originally in issue #9's "Decisions to make" list; deferred per the brainstorming scope decision. Open as a separate issue later if it earns its keep.
- **Changes to any `src/` file or to the test harness.** This branch is intentionally outside the surface area Goal 7's parallel implementation will modify, by design — see § Parallel-track rationale below.

---

## Parallel-track rationale

This branch was scoped specifically to be safe to land in parallel with Goal 7 (Lifecycle event API), which is in flight in a separate session. Goal 7's expected file touches:

- `src/sql.ts` — adds `pg_notify` to the capture trigger.
- `src/events.ts` (new file) — `BossierEvents` typed EventEmitter wrapper.
- `src/client.ts` — wires `subscribe()` onto the unified-client Proxy.
- `src/index.ts` — exports.
- New test files under `test/`.
- `CHANGELOG.md` and possibly `CLAUDE.md`.

This branch touches none of `src/` or `test/`. It touches:

- `COMPATIBILITY.md` (Goal 7 will not).
- `.github/workflows/ci.yml` (Goal 7 will not, by design — the lifecycle-event substrate has no CI hooks).
- `CHANGELOG.md` (potential conflict — both branches add an `## [Unreleased]` entry; resolution is trivial line-add).
- `CLAUDE.md` (potential conflict — both branches edit the Project-status paragraph and the Implementation-progress table; resolution is trivial line-add unless both branches edit exactly the same line, in which case last-merged wins after a one-line manual fix).
- The new GitHub issue and the #9 closure (no file conflict possible).

Net merge-conflict surface area with Goal 7: essentially `CHANGELOG.md` and `CLAUDE.md` line-add conflicts only. Acceptable.

---

## Workflow

Per CLAUDE.md's "large features go through a worktree → branch → `--no-ff` merge" rule:

1. `git worktree add .worktrees/goal-8-compat-doc-tightening -b feature/goal-8-compat-doc-tightening develop`
2. Implement the edits per the implementation plan (writing-plans skill).
3. Verify: `npm run lint && npm run build && npm test`. Trigger-step smoke test locally.
4. Open the cross-version-correctness sub-issue on GitHub.
5. Open a PR from `feature/goal-8-compat-doc-tightening` → `develop`. PR body references this design, the new sub-issue, and the #9 closure plan.
6. After PR merge: refresh #9 body, post #9 closing comment, close #9.
7. Clean up worktree.

No release in this branch — no version bump, no CHANGELOG section rename. Per CLAUDE.md, release is the `develop` → `main` squash, not part of feature work.
