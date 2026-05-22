# Goal 8 Compatibility Doc Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue [#9](https://github.com/elfensky/pg-bossier/issues/9) by ratifying three decisions (drop SLA, no matrix today, self-firing tripwire) — via two rewritten `COMPATIBILITY.md` sections, one new CI step that warns when pg-boss publishes a minor above the peer-dep floor, refreshed issue body, and a new follow-up sub-issue for cross-version correctness assertions.

**Architecture:** Doc-tightening branch, intentionally outside the surface area Goal 7 (lifecycle events) will modify. No `src/` or `test/` edits. Workflow: worktree → branch → small logical commits → `--no-ff` merge into develop. CLAUDE.md sync happens in a separate post-merge commit on develop (matches the pattern in `800c014`).

**Tech Stack:** Markdown, GitHub Actions YAML, Bash + Node one-liners for the tripwire compare, GitHub CLI (`gh`) for issue operations.

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-05-23-goal-8-compat-doc-tightening-design.md`

## File map

| File | Action | Lines | Why |
|---|---|---|---|
| `COMPATIBILITY.md` | Modify | replace ~40–47 with new sections | Drop "Still open" footer, add "How this doc gets updated" and "Version support — no matrix today, self-firing tripwire" sections |
| `.github/workflows/ci.yml` | Modify | remove line 4 comment, add new step | Drop stale "the pg-boss matrix is tracked in #9" comment, add tripwire step |
| `CHANGELOG.md` | Modify | add line under `## [Unreleased]` → `Changed` | Per CLAUDE.md, feature branches with user-visible changes add an Unreleased entry |
| `CLAUDE.md` | **Modify on develop after merge, NOT in this branch** | project status + Implementation-progress table row | Matches pattern in commit `800c014`; avoids merge conflict with Goal 7 |
| New GitHub issue | Create | n/a | Follow-up sub-issue: cross-version correctness assertions on `pgbossier.record` |
| Issue #9 body | Modify | strike stale claims, add resolved section | Per spec § "Issue #9 — refresh body, close with summary" |
| Issue #9 status | Close | n/a | After PR merge |

---

## Task 1: Create the worktree and verify baseline

**Files:**
- Create: `.worktrees/goal-8-compat-doc-tightening/` (worktree, gitignored)

- [ ] **Step 1: Create worktree and branch off develop**

Run from the main checkout (`/Users/andrei/Developer/github/pg-bossier`):

```bash
git worktree add .worktrees/goal-8-compat-doc-tightening -b feature/goal-8-compat-doc-tightening develop
```

Expected: `Preparing worktree (new branch 'feature/goal-8-compat-doc-tightening')` and the new directory appears.

- [ ] **Step 2: cd into the worktree and install dependencies**

```bash
cd .worktrees/goal-8-compat-doc-tightening
npm ci
```

Expected: clean install. Run from this worktree directory for all subsequent tasks in this plan.

- [ ] **Step 3: Verify baseline (lint + build + tests) all pass before changes**

```bash
npm run lint && npm run build && npm test
```

Expected: all three commands exit 0. The integration tests use `@testcontainers/postgresql` — Docker must be running. If any baseline check fails, stop and report; don't proceed to changes on a broken baseline.

- [ ] **Step 4: Confirm git status is clean on the new branch**

```bash
git status
git log -1 --oneline
```

Expected: working tree clean, HEAD points at develop's tip (`800c014` or later).

---

## Task 2: Open the follow-up sub-issue for cross-version correctness assertions

**Files:** none (external GitHub action; needed before COMPATIBILITY.md so the prose can cite the issue number).

- [ ] **Step 1: Draft the issue body in a temp file**

Run from the worktree:

```bash
cat > /tmp/goal-8-followup-issue.md <<'EOF'
## Why this issue exists

A debate during issue #9's resolution surfaced a class of pg-boss-vs-pg-bossier failure modes that **CI-against-latest does not catch**:

- A column kept as an alias on rename. The trigger keeps reading the old name; the chronicle table silently records wrong/empty data.
- A type or nullability shift on a `pgboss.job` column the trigger reads. The trigger still compiles; the recorded row is semantically wrong.
- pg-boss adds or reorders its own triggers on `pgboss.job`. AFTER-trigger interactions can change which transitions our capture trigger actually sees.
- Upgrade-path bugs that only manifest moving from an older minor to a newer one (vs. a fresh install on the newer one).

A version matrix alone does not catch any of these — it just broadens the set of versions on which the chronicle can be silently wrong. The real safety net is **cross-version correctness assertions** on `pgbossier.record`: integration tests that assert chronicle rows match expected shape and content for known fixture jobs, run against multiple pg-boss versions.

## What this issue delivers (high-level — design lives in this issue, not in pg-bossier code yet)

- Test harness extension: ability to install the trigger, exercise pg-boss public API to produce a known job lifecycle (success / failure / retry), then assert `pgbossier.record` rows match a fixture shape.
- A small set of canonical assertions covering the four failure modes above.
- A mechanism for running those assertions against multiple pg-boss versions when the floor/latest tripwire fires (issue #9's resolution).

## Trigger to schedule

Land this work when the CI tripwire in `.github/workflows/ci.yml` first fires — i.e. when pg-boss publishes a minor above the peer-dep floor in `package.json`. Before that point the assertions and the matrix are both degenerate.

## Related

- Parent goal: pg-bossier issue [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter), Goal 8.
- Predecessor: issue #9 (matrix-or-not decision; closed by decision with this issue as the follow-up).
- Design spec for the resolution: `docs/superpowers/specs/2026-05-23-goal-8-compat-doc-tightening-design.md` on develop.
EOF
cat /tmp/goal-8-followup-issue.md
```

Expected: full body prints back. Eyeball the markdown.

- [ ] **Step 2: Open the GitHub issue**

```bash
gh issue create \
  --title "Goal 8 follow-up: cross-version correctness assertions on pgbossier.record" \
  --body-file /tmp/goal-8-followup-issue.md
```

Expected: `gh` prints the URL of the new issue. **Capture the issue number** (e.g. `#18`) — it goes into the COMPATIBILITY.md prose in Task 3 and the #9 closing comment in Task 10.

- [ ] **Step 3: Note the issue number for the rest of the plan**

```bash
echo "Captured follow-up issue number: <ISSUE_NUMBER>" # replace with the actual number from Step 2
```

For the rest of this plan, references to `<FOLLOW_UP_ISSUE>` should be substituted with the number captured here.

---

## Task 3: Rewrite `COMPATIBILITY.md` — replace the trailing footer

**Files:**
- Modify: `COMPATIBILITY.md` (lines 40–47 — the existing "Still open (issue #9)" section)

- [ ] **Step 1: Confirm current trailing section before editing**

```bash
sed -n '40,47p' COMPATIBILITY.md
```

Expected: lines starting with `## Still open (issue [#9]…` through the closing paragraph about extending tables. This is the chunk being replaced.

- [ ] **Step 2: Replace lines 40–47 with the two new sections**

Use the Edit tool. Replace the existing block:

```
## Still open (issue [#9](https://github.com/elfensky/pg-bossier/issues/9))

This document classifies the surfaces. Two related decisions are tracked in #9 and are **not** settled here:

- **The CI version matrix** — which set of pg-boss versions CI runs the suite against (latest + N-1 + N-2 minors, or another window).
- **Update cadence** — whether this document is revised on every PR that touches a pg-boss surface, or on a separate audit cadence.

As later goals land they will add surfaces — `work` and the ORM transaction adapters to Stable, more `pgboss.job` columns to Transitional. Extend the tables above in the same change.
```

with:

```
## How this doc gets updated

This document is a ledger of real pg-boss surfaces pg-bossier currently
uses — not a prediction of future ones. When a PR adds a new pg-boss
method, column, or structural assumption, the same PR extends the table
above with that surface and its tier. This norm is a code-review
expectation, not enforced automation; it will sometimes be missed. The
floor/latest tripwire below is the safety net for when it is.

As later goals land they will add surfaces — `work` and the ORM
transaction adapters to Stable, more `pgboss.job` columns to
Transitional. Extend the tables above in the same change.

## Version support — no matrix today, self-firing tripwire

pg-bossier's CI runs against a single pg-boss version: whatever `npm ci`
resolves to inside the peer-dep range declared in `package.json`. Today
the floor and the latest published pg-boss are the same version, so a
matrix would be a degenerate one-entry list.

What CI-against-latest catches: hard schema breaks — a column we read
disappears, or changes type in a way the trigger cannot compile against
— detectable by the existing integration suite. What it does NOT catch:
silent semantic drift. A column kept as an alias on rename. A
type/nullability shift the trigger still compiles against. pg-boss
adding or reordering its own triggers on `pgboss.job`. Upgrade-path
bugs that only manifest moving from an older minor to a newer one.
Those classes of bug are caught by cross-version correctness assertions
against `pgbossier.record`, not by matrix presence alone (see [follow-up
issue #<FOLLOW_UP_ISSUE>](https://github.com/elfensky/pg-bossier/issues/<FOLLOW_UP_ISSUE>)).

The tripwire: a CI step compares the latest published pg-boss version
against the peer-dep floor declared in `package.json`. When they
diverge, the step surfaces a warning that links back to this section.
The trigger to add a floor+latest version matrix is **floor and latest
diverging**, contingent on the correctness assertions above existing
first. The matrix is the runtime; the assertions are the safety. A
matrix without assertions broadens the set of versions we can silently
be wrong on.

No time-bound support SLA. The "~2 weeks" estimate in issue #1 was an
internal complexity gate, not a commitment to consumers. "Supported"
means "the existing CI passes against the version pg-boss publishes
into the peer-dep range." When the floor and latest diverge,
"supported" extends to include the correctness assertions naming what
semantic behavior is verified across versions.
```

**Substitute `<FOLLOW_UP_ISSUE>` with the actual issue number captured in Task 2 Step 3** (both occurrences in the link).

- [ ] **Step 3: Verify the edit**

```bash
wc -l COMPATIBILITY.md
sed -n '40,$p' COMPATIBILITY.md
```

Expected: file is now ~75–85 lines (was 47). New sections are present; `<FOLLOW_UP_ISSUE>` is fully substituted with the real number — `grep '<FOLLOW_UP_ISSUE>' COMPATIBILITY.md` should print nothing.

- [ ] **Step 4: Sanity-check none of the "did not survive the debate" phrases sneaked back in**

```bash
grep -nE "Reviewers should reject|CI fails immediately|the doc itself is the lint|\^12\.18\.2 today|nothing to audit beyond" COMPATIBILITY.md
```

Expected: zero matches. Each of these phrases was identified by the debate as overconfident; if any reappears, fix it.

- [ ] **Step 5: Commit**

```bash
git add COMPATIBILITY.md
git commit -m "docs: rewrite COMPATIBILITY.md trailing sections per issue #9 resolution

Drops the matrix-and-SLA debate from the trailing 'Still open' footer
and ratifies the three decisions: no time-bound SLA, no matrix today,
self-firing tripwire when pg-boss publishes a minor above the
peer-dep floor. Names cross-version correctness assertions
(#<FOLLOW_UP_ISSUE>) as the real safety net for forensic-audit
correctness — the matrix is the runtime mechanism, not the fix itself.

Resolves the open items previously tracked in #9."
```

Substitute `<FOLLOW_UP_ISSUE>` in the commit body.

---

## Task 4: Add the CI tripwire step to `.github/workflows/ci.yml`

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Read the current workflow file**

```bash
cat .github/workflows/ci.yml
```

Expected: 25 lines, single `verify` job with checkout + setup-node + npm ci + lint + build + test.

- [ ] **Step 2: Remove the stale matrix comment on line 4**

Use the Edit tool. Replace:

```
# Lint, build, and run the integration suite on every push to develop or main
# and every PR. The suite uses @testcontainers/postgresql; Docker is preinstalled
# on the ubuntu-latest runner, so no `services:` Postgres block is needed. One
# Node and one pg-boss version for now — the pg-boss matrix is tracked in #9.
```

with:

```
# Lint, build, and run the integration suite on every push to develop or main
# and every PR. The suite uses @testcontainers/postgresql; Docker is preinstalled
# on the ubuntu-latest runner, so no `services:` Postgres block is needed. A
# separate tripwire job warns when pg-boss publishes a minor above the
# peer-dep floor — see COMPATIBILITY.md "Version support" for the policy.
```

- [ ] **Step 3: Append the tripwire job after the `verify` job**

The file currently ends after line 25 (`      - run: npm test`). Use the Edit tool to extend the file. After the last `- run: npm test` line, add:

```yaml

  pg-boss-version-tripwire:
    # Warns (does not fail) when the latest published pg-boss minor is above
    # the peer-dep floor declared in package.json. The trigger to add a
    # floor+latest matrix (and the correctness assertions that earn it) is
    # this warning firing. See COMPATIBILITY.md "Version support".
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: actions/checkout@v4
      - name: Compare pg-boss floor vs latest published minor
        run: |
          set -euo pipefail
          FLOOR_RANGE=$(node -e "console.log(require('./package.json').peerDependencies['pg-boss'])")
          FLOOR_MM=$(printf '%s' "$FLOOR_RANGE" | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1.\2/')
          LATEST=$(npm view pg-boss version)
          LATEST_MM=$(printf '%s' "$LATEST" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1.\2/')
          echo "Peer-dep range: $FLOOR_RANGE  (minor: $FLOOR_MM)"
          echo "Latest published: $LATEST     (minor: $LATEST_MM)"
          if [ "$FLOOR_MM" = "$LATEST_MM" ]; then
            echo "Floor and latest minor match — no tripwire."
          else
            echo "::warning::pg-boss latest minor ($LATEST_MM, version $LATEST) is above the peer-dep floor minor ($FLOOR_MM, range $FLOOR_RANGE). See COMPATIBILITY.md section 'Version support — no matrix today, self-firing tripwire'."
          fi
```

- [ ] **Step 4: Verify the YAML is valid**

```bash
node -e "require('js-yaml')" 2>&1 || npm ls js-yaml 2>&1
# If js-yaml isn't available, use a Python check instead:
python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML valid"
```

Expected: `YAML valid` (or no errors). If both Python and js-yaml are unavailable, fall back to: the GitHub Actions schema check happens on push — you'll see the result in the next CI run.

- [ ] **Step 5: Smoke-test the tripwire commands locally**

The tripwire is bash + node + npm — run its commands directly to confirm the output is right today (floor==latest, should print "no tripwire"):

```bash
FLOOR_RANGE=$(node -e "console.log(require('./package.json').peerDependencies['pg-boss'])")
FLOOR_MM=$(printf '%s' "$FLOOR_RANGE" | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1.\2/')
LATEST=$(npm view pg-boss version)
LATEST_MM=$(printf '%s' "$LATEST" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1.\2/')
echo "Peer-dep range: $FLOOR_RANGE  (minor: $FLOOR_MM)"
echo "Latest published: $LATEST     (minor: $LATEST_MM)"
if [ "$FLOOR_MM" = "$LATEST_MM" ]; then
  echo "Floor and latest minor match — no tripwire."
else
  echo "WARNING: would fire ::warning::pg-boss latest minor ($LATEST_MM) is above peer-dep floor minor ($FLOOR_MM)."
fi
```

Expected today (2026-05-23): `Peer-dep range: ^12.18.2  (minor: 12.18)`, `Latest published: 12.18.2     (minor: 12.18)`, `Floor and latest minor match — no tripwire.`

- [ ] **Step 6: Smoke-test the "warn" branch by faking a divergence**

Temporarily simulate the floor being one minor behind to confirm the warn branch works:

```bash
FAKE_FLOOR_MM="12.17"
LATEST=$(npm view pg-boss version)
LATEST_MM=$(printf '%s' "$LATEST" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1.\2/')
if [ "$FAKE_FLOOR_MM" = "$LATEST_MM" ]; then
  echo "match"
else
  echo "WARNING: would fire ::warning::pg-boss latest minor ($LATEST_MM, version $LATEST) is above the peer-dep floor minor ($FAKE_FLOOR_MM)."
fi
```

Expected: prints the warning text (this is a local simulation only — does not edit `package.json`).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add pg-boss floor/latest tripwire warning step

A separate workflow job that compares the latest published pg-boss
version to the peer-dep floor in package.json. Warns (does not fail)
when the latest minor is above the floor minor — the trigger to add
the floor+latest version matrix and the cross-version correctness
assertions in #<FOLLOW_UP_ISSUE>.

Also removes the now-stale inline comment about the pg-boss matrix
being tracked in #9."
```

Substitute `<FOLLOW_UP_ISSUE>`.

---

## Task 5: Add the CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Confirm the current Unreleased section**

```bash
sed -n '/## \[Unreleased\]/,/^## /p' CHANGELOG.md | head -40
```

Expected: shows the `## [Unreleased]` header and any existing subsections (`Added`, `Changed`, etc.) under it. Note whether a `### Changed` subsection already exists — that affects whether Step 2 inserts under an existing header or creates a new one.

- [ ] **Step 2: Add the Changed entry**

Use the Edit tool. If a `### Changed` subsection already exists under `## [Unreleased]`, insert this bullet at the top of that subsection:

```markdown
- `COMPATIBILITY.md` now documents the per-PR update cadence and the explicit decision against a CI version matrix and a time-bound support SLA. CI adds a tripwire step that warns when pg-boss publishes a minor above the peer-dep floor in `package.json`. Resolves issue [#9](https://github.com/elfensky/pg-bossier/issues/9). Cross-version correctness assertions on `pgbossier.record` continue as follow-up [#<FOLLOW_UP_ISSUE>](https://github.com/elfensky/pg-bossier/issues/<FOLLOW_UP_ISSUE>).
```

If no `### Changed` subsection exists yet, create one as the first subsection under `## [Unreleased]`:

```markdown
### Changed

- `COMPATIBILITY.md` now documents the per-PR update cadence and the explicit decision against a CI version matrix and a time-bound support SLA. CI adds a tripwire step that warns when pg-boss publishes a minor above the peer-dep floor in `package.json`. Resolves issue [#9](https://github.com/elfensky/pg-bossier/issues/9). Cross-version correctness assertions on `pgbossier.record` continue as follow-up [#<FOLLOW_UP_ISSUE>](https://github.com/elfensky/pg-bossier/issues/<FOLLOW_UP_ISSUE>).
```

Substitute `<FOLLOW_UP_ISSUE>` in both link occurrences.

- [ ] **Step 3: Verify the entry**

```bash
grep -A2 -B0 'CHANGELOG-test' CHANGELOG.md  # spot-check command for syntax verification
sed -n '/## \[Unreleased\]/,/^## /p' CHANGELOG.md | head -30
grep -n '<FOLLOW_UP_ISSUE>' CHANGELOG.md
```

Expected: the `sed` shows the new entry under `### Changed`; the `grep '<FOLLOW_UP_ISSUE>'` returns no matches (full substitution).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for Goal 8 doc tightening (#9 resolution)"
```

---

## Task 6: Final in-branch verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full verification suite**

```bash
npm run lint && npm run build && npm test
```

Expected: all three exit 0. No code touched, so test results should be identical to the baseline in Task 1 Step 3. If anything fails, stop and report — don't push a branch with broken verification.

- [ ] **Step 2: Eyeball the diff against develop**

```bash
git diff develop --stat
git diff develop
```

Expected diff scope:
- `COMPATIBILITY.md` (+~35 / -8 lines)
- `.github/workflows/ci.yml` (+~25 / -1 lines)
- `CHANGELOG.md` (+1–4 lines depending on whether `### Changed` already existed)

No other files. If `src/` or `test/` show up in the diff, something went wrong — stop.

- [ ] **Step 3: Commit log review**

```bash
git log develop..HEAD --oneline
```

Expected: 3 commits, in this order:

```
<sha> docs: changelog entry for Goal 8 doc tightening (#9 resolution)
<sha> ci: add pg-boss floor/latest tripwire warning step
<sha> docs: rewrite COMPATIBILITY.md trailing sections per issue #9 resolution
```

If any commit message contains `<FOLLOW_UP_ISSUE>` literally, edit it with `git commit --amend` (last commit) or note for an interactive squash later.

---

## Task 7: Push the branch and open the PR

**Files:** none (git/GitHub operations).

- [ ] **Step 1: Push the feature branch**

```bash
git push -u origin feature/goal-8-compat-doc-tightening
```

Expected: `Branch 'feature/goal-8-compat-doc-tightening' set up to track 'origin/feature/goal-8-compat-doc-tightening'`.

- [ ] **Step 2: Open the PR**

```bash
cat > /tmp/goal-8-pr-body.md <<'EOF'
Closes #9 by ratifying three decisions from the design spec at
`docs/superpowers/specs/2026-05-23-goal-8-compat-doc-tightening-design.md`:

1. **No time-bound SLA.** The "~2 weeks" estimate in issue #1 was an internal complexity gate, not a published commitment.
2. **No version matrix today.** Floor and latest pg-boss are the same version (`12.18.2`), so a matrix would be a degenerate one-entry list. The reason in the original draft prose ("CI-against-latest is enough") was identified by an adversarial multi-LLM debate as overconfident — silent semantic drift fails the chronicle table without firing CI.
3. **Self-firing tripwire instead.** A new CI step compares the latest published pg-boss version to the peer-dep floor in `package.json` and warns when they diverge. The matrix lands when the warning first fires — together with the cross-version correctness assertions tracked in #<FOLLOW_UP_ISSUE>.

### Changes

- `COMPATIBILITY.md` — replaced "Still open (issue #9)" footer with "How this doc gets updated" + "Version support — no matrix today, self-firing tripwire" sections.
- `.github/workflows/ci.yml` — new `pg-boss-version-tripwire` job; removed stale inline comment.
- `CHANGELOG.md` — Unreleased / Changed entry.

`CLAUDE.md` sync (project status + Implementation-progress table row) follows in a separate post-merge commit on develop — matches the pattern in `800c014`.

### Out of scope (tracked elsewhere)

- Cross-version correctness assertions on `pgbossier.record` → follow-up #<FOLLOW_UP_ISSUE>.
- Forbidden-tier violation detector (lint rule on `node_modules/pg-boss/src/*` imports) → deferred per the brainstorming scope decision; open as a separate issue later if it earns its keep.

### Verification

- `npm run lint && npm run build && npm test` pass (baseline + post-changes).
- The tripwire step's bash + node commands smoke-tested locally; floor/latest match today (12.18 == 12.18), warn branch verified via fake-floor simulation.
EOF

gh pr create \
  --base develop \
  --head feature/goal-8-compat-doc-tightening \
  --title "feat(docs): Goal 8 — close #9 with conditional tripwire, drop matrix and SLA" \
  --body-file /tmp/goal-8-pr-body.md
```

Substitute `<FOLLOW_UP_ISSUE>` in `/tmp/goal-8-pr-body.md` before running `gh pr create`.

Expected: PR URL printed. **Note the PR number** for the issue body refresh in Task 8.

---

## Task 8: Refresh issue #9's body (before merge)

**Files:** none (external GitHub action).

This can be done in parallel with reviewing the PR — does not block merge.

- [ ] **Step 1: Fetch the current issue #9 body**

```bash
gh issue view 9 --json body --jq '.body' > /tmp/issue-9-current.md
wc -l /tmp/issue-9-current.md
```

Expected: the current body (the stale-claims version) is saved locally for reference.

- [ ] **Step 2: Draft the refreshed body**

```bash
cat > /tmp/issue-9-refreshed.md <<'EOF'
## Status: Resolved by decision (2026-05-23)

This issue's open items — the CI version matrix and the "~2 weeks" support SLA — have been resolved by decision rather than implementation:

- **No time-bound SLA.** The "~2 weeks" estimate in issue #1 was an internal complexity gate, never a published commitment.
- **No version matrix today.** Floor and latest pg-boss are the same version. A matrix would be a one-entry list — degenerate.
- **Self-firing tripwire instead.** A CI step warns when pg-boss publishes a minor above the peer-dep floor.
- **Cross-version correctness assertions on `pgbossier.record`** — the real safety net for forensic-audit correctness across pg-boss versions — continue as follow-up #<FOLLOW_UP_ISSUE>. They land together with the matrix when the tripwire fires.

**Design spec:** [`docs/superpowers/specs/2026-05-23-goal-8-compat-doc-tightening-design.md`](https://github.com/elfensky/pg-bossier/blob/develop/docs/superpowers/specs/2026-05-23-goal-8-compat-doc-tightening-design.md) on develop after PR #<PR_NUMBER> merges.

**Resolution PR:** #<PR_NUMBER>.

---

## Original purpose (preserved for context)

Produce the compatibility tier document and CI matrix configuration that make pg-bossier's "stay close to pg-boss" promise enforceable.

## Parent

Sub-issue of #1 (Goal 8 — pg-boss compatibility tier system).
EOF

cat /tmp/issue-9-refreshed.md
```

Substitute `<FOLLOW_UP_ISSUE>` (from Task 2) and `<PR_NUMBER>` (from Task 7) in the body.

- [ ] **Step 3: Update issue #9**

```bash
gh issue edit 9 --body-file /tmp/issue-9-refreshed.md
```

Expected: `gh` prints the updated issue URL.

- [ ] **Step 4: Visual confirmation**

```bash
gh issue view 9 | head -30
```

Expected: the new "Status: Resolved by decision" section is at the top; both `<FOLLOW_UP_ISSUE>` and `<PR_NUMBER>` are fully substituted.

---

## Task 9: Land the PR (review + merge)

**Files:** none (review and merge operations).

- [ ] **Step 1: Confirm CI passes on the PR**

```bash
gh pr checks
```

Expected: all checks green — `verify` job (lint + build + test) passes, `pg-boss-version-tripwire` job passes with no warning (floor == latest today). If the tripwire job emits a warning today, something is wrong with the bash script and Task 4 needs revisiting.

- [ ] **Step 2: Self-review the diff once more**

```bash
gh pr diff
```

Eyeball the rendered diff. Confirm the COMPATIBILITY.md prose reads cleanly and `<FOLLOW_UP_ISSUE>` placeholder is nowhere.

- [ ] **Step 3: Merge with --no-ff**

Per CLAUDE.md's "Feature → develop merges are `--no-ff`, never squashed":

```bash
gh pr merge --merge  # GitHub UI equivalent of --no-ff
# OR locally:
# cd /Users/andrei/Developer/github/pg-bossier  (the main checkout, NOT the worktree)
# git checkout develop
# git pull
# git merge --no-ff feature/goal-8-compat-doc-tightening
# git push origin develop
```

Use whichever path is established in the repo's workflow. Expected: develop now has the merge commit + the 3 feature-branch commits.

---

## Task 10: Close issue #9 with summary comment

**Files:** none (external GitHub action; done after merge).

- [ ] **Step 1: Draft the closing comment**

```bash
cat > /tmp/issue-9-closing.md <<'EOF'
Closed by PR #<PR_NUMBER>.

**Four decisions ratified:**

1. **No time-bound support SLA.** The "~2 weeks" estimate in issue #1 was an internal complexity gate, not a published commitment to consumers. Pre-1.0 against a peer dep with a 1–3 week release cadence, a calendar SLA would either be impossible to keep or would force a pg-bossier release on every pg-boss minor regardless of need.

2. **No version matrix today.** Floor and latest pg-boss are the same version (`12.18.2`). A matrix would be a one-entry list — degenerate. The original draft's reason ("CI-against-latest is enough") was identified by an adversarial multi-LLM debate as overconfident: silent semantic drift (column aliases on rename, type/nullability shifts, trigger-ordering changes, upgrade-path bugs) fails the chronicle table without firing CI.

3. **Self-firing tripwire instead.** A new CI job (`pg-boss-version-tripwire`) compares the latest published pg-boss version to the peer-dep floor in `package.json` and warns when they diverge.

4. **Per-PR documentation cadence; no periodic audit.** `COMPATIBILITY.md` is edited in the same PR that adds or removes a pg-boss surface. This is a code-review expectation, not enforced automation; the tripwire is the safety net.

**Where things live now:**

- Decisions and reasoning: [`COMPATIBILITY.md` § "Version support"](https://github.com/elfensky/pg-bossier/blob/develop/COMPATIBILITY.md#version-support--no-matrix-today-self-firing-tripwire).
- CI tripwire: [`.github/workflows/ci.yml`](https://github.com/elfensky/pg-bossier/blob/develop/.github/workflows/ci.yml) (`pg-boss-version-tripwire` job).
- Design spec (full rationale): [`docs/superpowers/specs/2026-05-23-goal-8-compat-doc-tightening-design.md`](https://github.com/elfensky/pg-bossier/blob/develop/docs/superpowers/specs/2026-05-23-goal-8-compat-doc-tightening-design.md).
- Adversarial debate transcripts: `~/.claude-octopus/debates/pg-bossier-issue-9-compat-doc-prose/` (local, not checked in).

**Carrying forward:**

- **#<FOLLOW_UP_ISSUE>** — Cross-version correctness assertions on `pgbossier.record`. The real safety net for forensic-audit correctness across pg-boss versions. Scheduled to land when the tripwire first fires.
- **Forbidden-tier violation detector** (lint rule on `node_modules/pg-boss/src/*` imports) — deferred per the brainstorming scope decision; open as a separate issue if it earns its keep later.
EOF

cat /tmp/issue-9-closing.md
```

Substitute `<FOLLOW_UP_ISSUE>` and `<PR_NUMBER>`.

- [ ] **Step 2: Post the comment and close #9**

```bash
gh issue comment 9 --body-file /tmp/issue-9-closing.md
gh issue close 9 --reason completed
```

Expected: comment URL prints, issue moves to closed state.

- [ ] **Step 3: Confirm #9 is closed and the comment is the most recent**

```bash
gh issue view 9 --json state,closedAt
gh issue view 9 --comments | tail -40
```

Expected: `"state":"CLOSED"`, recent `closedAt` timestamp, the closing comment is the last comment with all placeholders substituted.

---

## Task 11: Post-merge — sync `CLAUDE.md` on develop

**Files:**
- Modify: `CLAUDE.md` (on develop directly, in the main checkout — NOT in the now-merged feature branch worktree)

This is a docs commit directly on develop. Per CLAUDE.md ("bugfixes, chores, and docs may be committed directly"), this does not need a feature branch. Matches the pattern in commit `800c014` ("docs: sync CLAUDE.md — Goal 6 delivered, issue #7 closed").

- [ ] **Step 1: Switch to the main checkout on develop**

```bash
cd /Users/andrei/Developer/github/pg-bossier
git checkout develop
git pull
git log -3 --oneline
```

Expected: latest commit is the merge of `feature/goal-8-compat-doc-tightening`.

- [ ] **Step 2: Update the project status paragraph**

Use the Edit tool to update the "## Project status" paragraph in `CLAUDE.md`. The current paragraph mentions Goals 1, 5, 6 as delivered and #1's status. Add Goal 8 to the delivered list following the same pattern. Look for the existing phrasing for Goal 6 and use it as a template:

Find existing text (within the Project-status paragraph):
> Goal 6's persistent progress API — `setProgress` / `getProgress` in `src/progress.ts`, on the `bossier` client — merged via `a7a8074`; its issue #7 is closed.

Add right after it:

> **Goal 8** (the pg-boss compatibility doc tightening — drop matrix and SLA, self-firing tripwire instead) is delivered — issue #9 closed; cross-version correctness assertions tracked as follow-up #\<FOLLOW_UP_ISSUE\>.

Substitute the actual follow-up issue number.

- [ ] **Step 3: Update the Implementation-progress table**

Use the Edit tool. Find the row in the "## What's deliberately undecided" → "Goal implementation issues" table for Goal 8. Current row:

```
| pg-boss compatibility tier doc + CI matrix definition                                 | Goal 8 |
```

Replace with:

```
| ✅ pg-boss compatibility tier doc + decision against a matrix _(done — #9 closed; correctness-assertions follow-up #<FOLLOW_UP_ISSUE> opened)_ | Goal 8 |
```

Substitute the follow-up issue number.

- [ ] **Step 4: Also update the introductory line above the table**

Find the existing text:
> Sub-issues opened during the issue #1 refinement. **Goal 1's issue ([#2](https://github.com/elfensky/pg-bossier/issues/2)) is closed — delivered by the storage substrate;** the rest were re-scoped on 2026-05-21 to reflect what the substrate settled. Goal 5's operational read API has since merged (PR #17) and its issue [#6](https://github.com/elfensky/pg-bossier/issues/6) is closed; Goal 6's persistent progress API has merged (`a7a8074`) and its issue [#7](https://github.com/elfensky/pg-bossier/issues/7) is closed; the remaining goal issues stay open.

Replace the trailing clause `the remaining goal issues stay open.` with:

`Goal 8's compat-doc tightening has merged and its issue [#9](https://github.com/elfensky/pg-bossier/issues/9) is closed (correctness-assertions follow-up #<FOLLOW_UP_ISSUE> open); the remaining goal issues stay open.`

- [ ] **Step 5: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md — Goal 8 doc tightening delivered, issue #9 closed"
git push origin develop
```

Expected: clean commit, pushed to develop.

---

## Task 12: Clean up the worktree

**Files:**
- Remove: `.worktrees/goal-8-compat-doc-tightening/`

- [ ] **Step 1: Confirm the branch is fully merged into develop**

```bash
cd /Users/andrei/Developer/github/pg-bossier
git branch --merged develop | grep goal-8-compat-doc-tightening
```

Expected: `feature/goal-8-compat-doc-tightening` listed as merged.

- [ ] **Step 2: Remove the worktree and delete the local branch**

```bash
git worktree remove .worktrees/goal-8-compat-doc-tightening
git branch -d feature/goal-8-compat-doc-tightening
git worktree list
```

Expected: only the main checkout remains in `git worktree list`. Local branch is gone. Remote branch can stay on origin or be deleted via `git push origin --delete feature/goal-8-compat-doc-tightening` — optional.

---

## Self-review check (done after writing this plan)

- **Spec coverage:** All seven deliverables from the spec (COMPATIBILITY.md sections, ci.yml step, issue body refresh, follow-up sub-issue, issue #9 closure, CHANGELOG entry, CLAUDE.md sync) are mapped to specific tasks. ✓
- **Placeholder scan:** Two intentional placeholders — `<FOLLOW_UP_ISSUE>` (resolved in Task 2 Step 3, substituted everywhere downstream) and `<PR_NUMBER>` (resolved in Task 7, substituted in Tasks 8 and 10). Both are flagged for substitution at each use site. No "TBD", "TODO", "implement later," or hand-wavy "appropriate" terms. ✓
- **Type/text consistency:** New COMPATIBILITY.md heading is `## Version support — no matrix today, self-firing tripwire` everywhere it appears (Task 3 Step 2, Task 4 Step 3's warning text, Task 7 PR body, Task 10 closing comment). CI job name `pg-boss-version-tripwire` is consistent across Task 4, Task 9, Task 10. ✓
- **Scope check:** Single implementation plan covers the whole spec; no decomposition needed. The follow-up issue (cross-version correctness assertions) is explicitly *opened* in this plan but designed/implemented in its own future plan. ✓
