import type { Pool } from 'pg';
import {
  SCHEMA_SQL, SEQUENCE_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL,
  RECORD_SEQ_COLUMN_SQL, RECORD_SEQ_INDEX_SQL,
  CAPTURE_FUNCTION_SQL, CAPTURE_TRIGGER_SQL, BACKFILL_SQL,
} from './sql.js';

export async function install(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(SEQUENCE_SQL);
  await pool.query(RECORD_TABLE_SQL);
  await pool.query(RECORD_SEQ_COLUMN_SQL);
  await pool.query(RECORD_SEQ_INDEX_SQL);
  for (const indexSql of RECORD_INDEXES_SQL) {
    await pool.query(indexSql);
  }
  await pool.query(CAPTURE_FUNCTION_SQL);
  await pool.query(CAPTURE_TRIGGER_SQL);
  await pool.query(BACKFILL_SQL);
}

export async function uninstall(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS pgbossier CASCADE;`);
}
