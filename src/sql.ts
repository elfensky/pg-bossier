export const SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS pgbossier;`;

export const RECORD_TABLE_SQL = `
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
);`;

export const RECORD_INDEXES_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS record_queue_state_idx     ON pgbossier.record (queue, state);`,
  `CREATE INDEX IF NOT EXISTS record_captured_at_idx     ON pgbossier.record (captured_at);`,
  `CREATE INDEX IF NOT EXISTS record_data_gin            ON pgbossier.record USING gin (data);`,
  `CREATE INDEX IF NOT EXISTS record_output_gin          ON pgbossier.record USING gin (output);`,
  `CREATE INDEX IF NOT EXISTS record_terminal_detail_gin ON pgbossier.record USING gin (terminal_detail);`,
];
