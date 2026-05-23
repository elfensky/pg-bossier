export interface SchemaNames {
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  pgbossier: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgboss: string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

const RESERVED_SCHEMA_NAMES = new Set([
  'public',
  'information_schema',
]);

const RESERVED_KEYWORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc',
  'asymmetric', 'authorization', 'binary', 'both', 'case', 'cast',
  'check', 'collate', 'collation', 'column', 'concurrently', 'constraint',
  'create', 'cross', 'current_catalog', 'current_date', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user',
  'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end',
  'except', 'false', 'fetch', 'for', 'foreign', 'freeze', 'from', 'full',
  'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner',
  'intersect', 'into', 'is', 'isnull', 'join', 'lateral', 'leading',
  'left', 'like', 'limit', 'localtime', 'localtimestamp', 'natural',
  'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning',
  'right', 'select', 'session_user', 'similar', 'some', 'symmetric',
  'system_user', 'table', 'tablesample', 'then', 'to', 'trailing',
  'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose',
  'when', 'where', 'window', 'with',
]);

export function assertSchemaName(name: string, key: keyof SchemaNames): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `pgbossier: invalid ${key} schema name: ${JSON.stringify(name)}. ` +
      `Must match ${IDENT_RE.source}.`,
    );
  }
  if (name.startsWith('pg_')) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} is reserved — ` +
      `Postgres reserves the 'pg_' prefix for system schemas.`,
    );
  }
  if (RESERVED_SCHEMA_NAMES.has(name)) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} is reserved — ` +
      `using it would conflict with user data or system catalogs.`,
    );
  }
  if (RESERVED_KEYWORDS.has(name)) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} is a Postgres ` +
      `reserved keyword and cannot be used as a bare identifier.`,
    );
  }
  if (Buffer.byteLength(name, 'utf8') > 63) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} exceeds 63 bytes ` +
      `(NAMEDATALEN). Postgres would silently truncate it.`,
    );
  }
}

export function resolveSchemas(opts?: Partial<SchemaNames>): SchemaNames {
  const s: SchemaNames = {
    pgbossier: opts?.pgbossier ?? 'pgbossier',
    pgboss:    opts?.pgboss    ?? 'pgboss',
  };
  assertSchemaName(s.pgbossier, 'pgbossier');
  assertSchemaName(s.pgboss, 'pgboss');
  return s;
}

export function schemaSql(s: SchemaNames): string {
  return `CREATE SCHEMA IF NOT EXISTS ${s.pgbossier};`;
}

export function sequenceSql(s: SchemaNames): string {
  return `CREATE SEQUENCE IF NOT EXISTS ${s.pgbossier}.record_seq;`;
}

export function recordTableSql(s: SchemaNames): string {
  return `
CREATE TABLE IF NOT EXISTS ${s.pgbossier}.record (
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
);`;
}

export function recordIndexesSql(s: SchemaNames): readonly string[] {
  const t = `${s.pgbossier}.record`;
  return [
    `CREATE INDEX IF NOT EXISTS record_queue_state_idx     ON ${t} (queue, state);`,
    `CREATE INDEX IF NOT EXISTS record_captured_at_idx     ON ${t} (captured_at);`,
    `CREATE INDEX IF NOT EXISTS record_data_gin            ON ${t} USING gin (data);`,
    `CREATE INDEX IF NOT EXISTS record_output_gin          ON ${t} USING gin (output);`,
    `CREATE INDEX IF NOT EXISTS record_terminal_detail_gin ON ${t} USING gin (terminal_detail);`,
    `CREATE INDEX IF NOT EXISTS record_active_idx          ON ${t} (queue, started_on) WHERE state = 'active';`,
  ];
}

export function recordSeqColumnSql(s: SchemaNames): string {
  return `
ALTER TABLE ${s.pgbossier}.record
  ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('${s.pgbossier}.record_seq');`;
}

export function recordSeqIndexSql(s: SchemaNames): string {
  return `CREATE INDEX IF NOT EXISTS record_seq_idx ON ${s.pgbossier}.record (seq);`;
}

export function captureFunctionSql(s: SchemaNames): string {
  return `
CREATE OR REPLACE FUNCTION ${s.pgbossier}.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_seq bigint;
BEGIN
  BEGIN
    new_seq := nextval('${s.pgbossier}.record_seq');

    INSERT INTO ${s.pgbossier}.record
      (job_id, queue, attempt, state, data, output,
       created_on, started_on, completed_on, captured_at, seq)
    VALUES
      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
       NEW.created_on, NEW.started_on, NEW.completed_on, now(), new_seq)
    ON CONFLICT (job_id, attempt) DO UPDATE SET
      state        = EXCLUDED.state,
      data         = EXCLUDED.data,
      output       = EXCLUDED.output,
      created_on   = EXCLUDED.created_on,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on,
      seq          = new_seq;

    PERFORM pg_notify(
      '${s.pgbossier}_job',
      json_build_object(
        'job_id',      NEW.id,
        'queue',       NEW.name,
        'attempt',     NEW.retry_count,
        'state',       NEW.state,
        'seq',         new_seq,
        'captured_at', now()
      )::text
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pgbossier: capture failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;`;
}

export function captureTriggerSql(s: SchemaNames): string {
  const trigName = `${s.pgbossier}_capture`;
  return `
DROP TRIGGER IF EXISTS ${trigName} ON ${s.pgboss}.job;
CREATE TRIGGER ${trigName}
  AFTER INSERT OR UPDATE OF state ON ${s.pgboss}.job
  FOR EACH ROW EXECUTE FUNCTION ${s.pgbossier}.capture();`;
}

export function backfillSql(s: SchemaNames): string {
  return `
INSERT INTO ${s.pgbossier}.record
  (job_id, queue, attempt, state, data, output,
   created_on, started_on, completed_on, captured_at)
SELECT id, name, retry_count, state, data, output,
       created_on, started_on, completed_on, now()
FROM ${s.pgboss}.job
ON CONFLICT (job_id, attempt) DO NOTHING;`;
}
