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

export const CAPTURE_FUNCTION_SQL = `
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
    NULL;
  END;
  RETURN NULL;
END;
$$;`;

export const CAPTURE_TRIGGER_SQL = `
DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job;
CREATE TRIGGER pgbossier_capture
  AFTER INSERT OR UPDATE OF state ON pgboss.job
  FOR EACH ROW EXECUTE FUNCTION pgbossier.capture();`;

export const BACKFILL_SQL = `
INSERT INTO pgbossier.record
  (job_id, queue, attempt, state, data, output,
   created_on, started_on, completed_on, captured_at)
SELECT id, name, retry_count, state, data, output,
       created_on, started_on, completed_on, now()
FROM pgboss.job
ON CONFLICT (job_id, attempt) DO NOTHING;`;
