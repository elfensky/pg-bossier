# `perf-metrics` orphan branch — one-time initialization

The CI-anchored perf history (issue #23) stores benchmark records on a dedicated **orphan** branch named `perf-metrics`. That branch shares **no history** with `develop` and contains exactly one file: `perf-metrics.jsonl` — one JSON object per line, append-only.

Until the branch exists, the `perf-history.yml` workflow on `develop` will fail (it tries to `git checkout perf-metrics`), and `perf-pr.yml` will report "no baseline yet" for every PR.

A maintainer runs the steps below **once**.

## Steps

From a clean checkout of `develop`:

```bash
# 1. Create the orphan branch
git checkout --orphan perf-metrics

# 2. Strip all files inherited from develop's tree
git rm -rf .

# 3. Seed an empty JSONL file
printf '' > perf-metrics.jsonl

# 4. Add and commit
git add perf-metrics.jsonl
git commit -m "init: perf-metrics chronicle (orphan branch)"

# 5. Push, setting upstream
git push -u origin perf-metrics

# 6. Switch back to develop — the orphan branch is meant to be touched only by CI
git checkout develop
```

## Verifying

```bash
# The branch exists, has one commit, and contains exactly one file:
git fetch origin perf-metrics
git ls-tree --name-only origin/perf-metrics
# Expected output:
# perf-metrics.jsonl

git log origin/perf-metrics --oneline
# Expected: one commit, "init: perf-metrics chronicle (orphan branch)"
```

The first run of `perf-history.yml` (on the next `push` to `develop`) will append the first JSONL record. From then on, every develop push appends one record.

## Why an orphan branch?

- **Git-native, zero external infrastructure.** No object store credentials, no service to maintain. The orphan branch is just a Git ref pointing at a tiny tree.
- **Tied to the repo's IAM and audit trail.** Anyone with read access to the repo can read the perf history; anyone with write access via GitHub Actions can append. No separate ACL to manage.
- **No mixing with code history.** `perf-metrics` and `develop` have unrelated histories by design — perf records will never appear in `git log develop`, and develop's commits will never appear in `git log perf-metrics`. This keeps `git log` and `git blame` clean on develop.

## When the file gets large

Each record is on the order of ~1 KB. At one commit per develop push, even 5 years of weekly pushes is well under 5 MB. The orphan branch will grow by ~one commit per record (and at least one tree object per record), so commit count grows linearly — but git's packfile compression handles that.

If size ever becomes a concern (>10 MB or >1000 records), rotate by creating a new orphan branch like `perf-metrics-2027` and pointing the workflows at it. The old branch stays in the repo as history. There is no rotation plan in v1 — issue #21 follow-ups will revisit if needed.

## Removing the branch (not recommended)

If for some reason the chronicle needs to be wiped:

```bash
# DESTRUCTIVE — discards all perf history. Only do this if you know why.
git push origin --delete perf-metrics
```

Then re-run the init steps above to create a fresh orphan branch.

## Related

- Issue #23 — this initiative.
- Issue #21 — scale extensions and budget violation policy.
- `.github/workflows/perf-history.yml` — the workflow that writes to this branch.
- `.github/workflows/perf-pr.yml` — the workflow that reads from this branch.
- `scripts/perf-write.mjs` — the JSONL writer.
- `scripts/perf-compare.mjs` — the PR-baseline comparer.
- `PERFORMANCE.md` — published per-method budgets and a description of the CI-anchored history.
