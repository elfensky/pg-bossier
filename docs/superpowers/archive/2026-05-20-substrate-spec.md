# pg-bossier Substrate — Buildable Spec

- **Status:** Approved direction, awaiting spec review
- **Date:** 2026-05-20
- **Author:** elfensky, with claude-code
- **Builds on:** `docs/superpowers/specs/2026-05-20-storage-architecture-design.md` (the architecture) and the agreed [issue #1](https://github.com/elfensky/pg-bossier/issues/1) charter
- **Implements:** sub-issue #2 (forensic table) + the capture mechanism shared by Goals 1–6

## Scope

This is the **buildable** spec — exact DDL and SQL — for the first implementation increment: the storage substrate every other goal builds on.

**In scope:** the `pgbossier` schema, the `pgbossier.record` table, the capture trigger on `pgboss.job`, the app-hook wrapping-client skeleton, the install migration, and install-time backfill.

**Out of scope** (per-goal sub-issues): the write APIs that populate `progress` / `terminal_detail` / `input_snapshot` (#3/#5/#7), the query method signatures and `search()` criteria language (#6/#13), migration *delivery* packaging (#9), dead-letter lineage (#4), backfill performance tuning (#11), the numeric per-event budget (#12).

## Verified pg-boss 12.18.2 facts used here

The architecture doc verified the job lifecycle. This spec depends on one further fact, verified in `node_modules/pg-boss/dist/plans.js`:

**`fetchNextJob` increments `retry_count` only when the job has run before.** Its `UPDATE` sets `retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END`. Consequence: the first fetch leaves `retry_count = 0` (the job's `started_on` was `NULL`); each subsequent retry fetch increments it. So **for any `active` or terminal job, `retry_count` is exactly the 0-based attempt number** — `0` = first run, `1` = first retry, and so on. This makes `attempt := retry_count` a sound, verified mapping.

## The table: `pgbossier.record`

```sql
CREATE SCHEMA IF NOT EXISTS pgbossier;

CREATE TABLE IF NOT EXISTS pgbossier.record (
  job_id          uuid        NOT NULL,
  queue           text        NOT NULL,
  attempt         integer     NOT NULL,
  state           text        NOT NULL,
  data            jsonb,
  output          jsonb,
  progress        jsonb,
  terminal_detail jsonb,
  input_snapshot  jsonb,
  created_on      timestamptz,
  started_on      timestamptz,
  completed_on    timestamptz,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attempt)
);

CREATE INDEX IF NOT EXISTS record_queue_state_idx      ON pgbossier.record (queue, state);
CREATE INDEX IF NOT EXISTS record_captured_at_idx      ON pgbossier.record (captured_at);
CREATE INDEX IF NOT EXISTS record_data_gin             ON pgbossier.record USING gin (data);
CREATE INDEX IF NOT EXISTS record_output_gin           ON pgbossier.record USING gin (output);
CREATE INDEX IF NOT EXISTS record_terminal_detail_gin  ON pgbossier.record USING gin (terminal_detail);
```

- **Grain:** one row per `(job_id, attempt)`. PK `(job_id, attempt)`.
- **`state`** is `text`, not an enum — forward-compatible if pg-boss adds states. Stored verbatim from `pgboss.job.state` (`created` / `active` / `retry` / `completed` / `cancelled` / `failed`).
- **Trigger-owned columns:** `job_id`, `queue`, `attempt`, `state`, `data`, `output`, `created_on`, `started_on`, `completed_on`, `captured_at`.
- **App-hook-owned columns:** `progress`, `terminal_detail`, `input_snapshot` — written only by pg-bossier's wrapping client, never by the trigger.
- The `(queue, state)` index serves `listActive` / `listStalled` / state-counts; the three GIN indexes serve `search()`.

A record row with `state = 'retry'` denotes **a failed attempt that was retried** — its `output` holds that attempt's error, its `terminal_detail` (when the app-hook ran) holds the failure `class`. The read layer interprets `retry` as "failed, superseded by the next attempt." This keeps the trigger a verbatim mirror; the tiny interpretation lives in the typed read API.

## The capture trigger

```sql
CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO pgbossier.record
      (job_id, queue, attempt, state, data, output,
       created_on, started_on, completed_on, captured_at)
    VALUES
      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
       NEW.created_on, NEW.started_on, NEW.completed_on, now())
    ON CONFLICT (job_id, attempt) DO UPDATE SET
      state        = EXCLUDED.state,
      data         = EXCLUDED.data,
      output       = EXCLUDED.output,
      created_on   = EXCLUDED.created_on,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on,
      captured_at  = EXCLUDED.captured_at;
  EXCEPTION WHEN OTHERS THEN
    -- fail-open: a capture failure must never abort the pg-boss operation
    NULL;
  END;
  RETURN NULL;  -- AFTER trigger; return value is ignored
END;
$$;

CREATE TRIGGER pgbossier_capture
  AFTER INSERT OR UPDATE OF state ON pgboss.job
  FOR EACH ROW EXECUTE FUNCTION pgbossier.capture();
```

How each pg-boss transition is captured:

| pg-boss operation | SQL | Trigger fires on | Effect on `pgbossier.record` |
|---|---|---|---|
| `send()` | `INSERT` into `pgboss.job` | `INSERT` | new `(job_id, 0)` row, `state = created` |
| fetch → `active` | `UPDATE … SET state = active` | `UPDATE OF state` | `(job_id, retry_count)` row → `state = active` |
| `complete()` / `cancel()` | `UPDATE … SET state = …` | `UPDATE OF state` | row → `state = completed` / `cancelled`, `output` set |
| fail → `retry` / `failed` | `DELETE` + `INSERT` (same id) | `INSERT` of the new row | `(job_id, retry_count)` row → `state = retry`/`failed`, `output` = this attempt's error |
| dead-letter | `INSERT` (new id) | `INSERT` | a fresh `(new_job_id, 0)` row |
| `touch()` | `UPDATE … SET heartbeat_on` | — (does **not** change `state`) | not fired — heartbeat keep-alives cost nothing |
| TTL `deletion` | `DELETE` | — (not in trigger scope) | nothing — the terminal row was already captured |

Design points:

- **`AFTER INSERT OR UPDATE OF state`** — fires on every meaningful transition and skips `touch()` heartbeats (which change only `heartbeat_on`). All of pg-boss's information-bearing changes (`output`, timestamps) coincide with a `state` change, so the column-scoped trigger loses nothing.
- **No `DELETE` handling.** The retry `DELETE` removes a row already captured as `active`; the TTL `DELETE` removes a row already captured in its terminal state. `pgbossier.record` never deletes, so neither `DELETE` carries new information.
- **`attempt := NEW.retry_count`** — verified mapping (see above). The retry `DELETE`+`INSERT` re-inserts with the same `id` and the same `retry_count`; the trigger's `ON CONFLICT` updates that attempt's row in place. The next fetch increments `retry_count`, so the following attempt lands on a fresh row.
- **`ON CONFLICT DO UPDATE` touches only trigger-owned columns** — `progress`, `terminal_detail`, `input_snapshot` are never named, so app-hook writes already on the row are preserved.
- **Fail-open** — the `BEGIN … EXCEPTION WHEN OTHERS THEN NULL` block swallows any capture error so the underlying pg-boss operation always commits. (`WHEN OTHERS` does not catch every condition — e.g. disk-full — but covers the realistic failures; this is the deliberate fail-open trade-off from the architecture doc.)
- **Thin trigger** — one direct `UPSERT` per event. The outbox-plus-drainer alternative is not built for v1; revisit only if sub-issue #12's per-event budget is exceeded.
- **Partitioned table** — `pgboss.job` is `PARTITION BY LIST (name)`; a row trigger on the partitioned parent propagates to every partition, including ones pg-boss creates later (Postgres 13+, which pg-boss 12 already requires).
- **Compatibility tier** — the function references `pgboss.job` columns and is DDL attached to that table → **Transitional** (Goal 8). The function lives in the `pgbossier` schema so `DROP SCHEMA pgbossier CASCADE` drops the trigger with it.

## App-hook wrapping-client skeleton

The substrate ships the *structure* the per-goal write features plug into, not the write features themselves:

- pg-bossier exports a wrapping client created from a pg-boss instance (e.g. `bossier(boss)`).
- It exposes pg-boss's methods unchanged (delegation) plus a small internal `recordUpsert(jobId, attempt, patch)` helper that `UPSERT`s **only** the app-hook-owned columns (`progress` / `terminal_detail` / `input_snapshot`) onto the `(job_id, attempt)` row.
- Goals 2/4/6 (#3/#5/#7) build their write methods on `recordUpsert`. The substrate provides the helper and the wrapping structure; it wires no write method itself.

## Install migration

One idempotent migration — safe to re-run:

1. `CREATE SCHEMA IF NOT EXISTS pgbossier;`
2. `CREATE TABLE IF NOT EXISTS pgbossier.record (…)` + the five `CREATE INDEX IF NOT EXISTS …`.
3. `CREATE OR REPLACE FUNCTION pgbossier.capture() …`.
4. `CREATE TRIGGER pgbossier_capture …` — guarded (`DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job;` first, since `CREATE TRIGGER` has no `IF NOT EXISTS` before Postgres 16).
5. **Backfill** (below).

The migration SQL is defined here; *how it is delivered* (a CLI command, a programmatic `install()` call, or a raw `.sql` file) is sub-issue #9.

## Backfill

After the trigger is in place, copy the current contents of `pgboss.job` into `pgbossier.record` so the mirror is complete from install — pre-install jobs that never change again would otherwise never be captured:

```sql
INSERT INTO pgbossier.record
  (job_id, queue, attempt, state, data, output,
   created_on, started_on, completed_on, captured_at)
SELECT id, name, retry_count, state, data, output,
       created_on, started_on, completed_on, now()
FROM pgboss.job
ON CONFLICT (job_id, attempt) DO NOTHING;
```

`ON CONFLICT DO NOTHING` makes backfill safe to interleave with live trigger writes — a row the trigger has already captured is not overwritten with stale data. Backfill sees only rows still present in `pgboss.job`; jobs pg-boss already TTL-deleted are unrecoverable (expected). Backfill *performance* — chunking, lock impact, throttling on large tables — is sub-issue #11.

## Testing

- **Runner: `vitest`** — ESM- and TypeScript-native, the modern default for a 2026 library. (This resolves the runner choice `CLAUDE.md` deferred "until the first feature lands" — this is that feature.)
- **Database: `@testcontainers/postgresql`** — an ephemeral Postgres container per test run, with pg-boss 12.18.2 installed into it. No external DB setup; runs the same locally and in CI.
- **What the substrate's tests must prove** (integration tests against real pg-boss — not mocks, per the architecture doc):
  1. `send` → a `(job_id, 0)` record row with `state = created`, then `active` on fetch.
  2. `complete` / `cancel` → the row reaches `completed` / `cancelled` with `output`.
  3. A job that fails and retries twice → three record rows, `attempt` `0,1,2`, the first two `state = retry` carrying each attempt's `output`, the last carrying the terminal state.
  4. A `touch()` keep-alive does **not** create or alter a record row.
  5. Backfill on a pre-populated `pgboss.job` → a complete mirror; re-running backfill changes nothing.
  6. `DROP SCHEMA pgbossier CASCADE` removes the table, function, **and** the trigger on `pgboss.job` — `pgboss.job` is left exactly as before.
- This test suite is the seed of the Goal 8 CI matrix (run against each supported pg-boss version).

## Decisions taken

| Decision | Resolution |
|---|---|
| `attempt` mapping | `attempt := pgboss.job.retry_count` — verified 0-based for active/terminal jobs via `fetchNextJob`'s `started_on`-guarded increment. |
| Trigger scope | `AFTER INSERT OR UPDATE OF state ON pgboss.job FOR EACH ROW` — captures every transition, skips `touch()` heartbeats. |
| `DELETE` handling | None — retry- and TTL-`DELETE`s carry no information `pgbossier.record` lacks. |
| Thin-trigger sub-choice | Direct `INSERT … ON CONFLICT DO UPDATE`. Outbox+drainer deferred — revisit only if #12's budget is exceeded. |
| Fail-open | PL/pgSQL `EXCEPTION WHEN OTHERS THEN NULL` around the UPSERT. |
| Column-ownership safety | The trigger's `DO UPDATE SET` names only trigger-owned columns; app-hook columns are never clobbered. |
| `state` representation | `text`, stored verbatim; `retry` rows mean "failed attempt, retried" and are interpreted by the read layer. |
| Test runner | `vitest`. |
| Test database | `@testcontainers/postgresql` — ephemeral Postgres + pg-boss per run. |
| Migration idempotence | `CREATE … IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`; backfill `ON CONFLICT DO NOTHING`. |

## What this spec does NOT decide

- The write methods that populate `progress` / `terminal_detail` / `input_snapshot`, and their API shape (#3 / #5 / #7).
- Query method signatures, pagination, worker identity, `search()` criteria language, TypeScript generics (#6 / #13).
- Migration *delivery* — CLI vs programmatic vs `.sql` file (#9).
- Dead-letter lineage and singleton-supersession representation (#4).
- Backfill performance — chunking, locking, throttling (#11).
- The numeric per-event overhead budget, and whether to move to an outbox (#12).

## Next step

`superpowers:writing-plans` turns this spec into a task-by-task implementation plan: scaffold `vitest` + `@testcontainers/postgresql`, then build the migration SQL, the `pgbossier.record` DDL, the `pgbossier.capture()` function and trigger, the backfill, and the app-hook wrapping-client skeleton — each task test-first against a real pg-boss container.
