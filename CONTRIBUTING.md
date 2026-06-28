# Contributing to pg-bossier

This document covers the local development workflow and the release
runbook. For project goals and architectural decisions, see
[CLAUDE.md](./CLAUDE.md) and [issue #1](https://github.com/elfensky/pg-bossier/issues/1).

## Local development

```bash
npm install
npm run lint && npm run build && npm run test:types && npm test
```

`npm run test:types` compile-checks the type-level assertions in
`test/types.test-d.ts` (`tsc -p tsconfig.test.json`); CI runs it too, between
`build` and `test`. Optional: `npm run test:perf` (vitest bench on a dedicated
container) and `npm run test:soak` (long-running battle soak, usually via the
`workflow_dispatch` CI job).

Integration tests use `@testcontainers/postgresql` against real Postgres +
pg-boss (Docker required). The suite boots **one** shared `postgres:18-alpine`
container once via vitest's `globalSetup` (`test/global-setup.ts`); each test
file calls `startHarness()` (`test/harness.ts`) to create a fresh database
inside it (default schema names, so test SQL is unchanged). New test files
should use `startHarness()` — don't boot a container per file.

## Feature workflow

Per [CLAUDE.md](./CLAUDE.md), large features go through a worktree →
branch → `--no-ff` merge into `develop`:

```bash
git worktree add .worktrees/feature-<name> -b feature/<name> develop
cd .worktrees/feature-<name>
npm install
# ... do the work, commit incrementally ...
npm run lint && npm run build && npm test
cd /path/to/main/checkout
git merge --no-ff feature/<name>
git push origin develop
git worktree remove .worktrees/feature-<name>
git branch -d feature/<name>
```

## Release runbook (first publish + subsequent)

A release is a single squashed commit on `main` that snapshots `develop`:

```bash
# 1. Verify develop is green (mirror CI's fail-fast order):
git checkout develop
npm run lint && npm run build && npm run test:types && npm test
npm publish --dry-run
# → surfaces metadata/files issues; runs `prepare` (tsc) end-to-end

# 2. Decide the version. Latest tag is v0.6.1; bump per the version
#    policy in CLAUDE.md (minor for features, patch for fixes).

# 3. Switch to main, snapshot develop's tree (NOT git merge — develop
#    and main have unrelated histories by design):
git checkout main
git status     # MUST be clean — no untracked files
git read-tree -u --reset develop

# 4. In ONE commit on main, bump version and rename [Unreleased]:
#    - package.json + package-lock.json:  bump
#    - CHANGELOG.md:
#        rename "## [Unreleased]" → "## [X.Y.Z] - 2026-MM-DD"
#        add fresh empty "## [Unreleased]" block above it for next cycle.
git add -u                            # tracked files only — NEVER -A
# Edit package.json + CHANGELOG.md
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release X.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags

# 5. Back on develop, open a fresh [Unreleased] block for next cycle:
git checkout develop
# Edit CHANGELOG.md to add empty [Unreleased] header back at the top
git commit -am "chore(changelog): open fresh [Unreleased] for next cycle"
git push origin develop

# 6. From main, publish:
git checkout main
npm publish
# You provide npm credentials. The prepare script runs tsc.
```

## Until the first publish

Consumers install pg-bossier via:

```bash
# Primary (reproducible — tag-pinned to the latest release):
npm install 'git+https://github.com/elfensky/pg-bossier.git#v0.6.1'

# Local pack:
cd pg-bossier && npm pack
cd ../consumer-app && npm install ../pg-bossier/pg-bossier-X.Y.Z.tgz
```

The first `npm publish` (v0.6.1) is prepared but held pending a descent-app
v0.6.1 validation pass; until it lands, the git-tag install above is the path.

## Version policy

- **v0.x.y** while the API surface is maturing (latest tag: `v0.6.1`). Minor bumps for features, patch bumps for fixes. Non-additive schema changes are minor bumps under 0.x.
- **Version bumps and releases are decoupled** — see § Versioning and changelog in [CLAUDE.md](./CLAUDE.md). A bump lands on `develop` when a feature/milestone completes; the dev-marker tags (`v0.2.0` … `v0.5.0`, `v0.6.0`, `v0.6.1`) live on `develop`, not on `main` release commits. The first `npm publish` (v0.6.1) is prepared but still held pending the descent-app v0.6.1 validation pass.
- **v1.0.0** only when the API surface is committed.
