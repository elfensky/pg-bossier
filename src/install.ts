import type { Pool } from 'pg';
import { SCHEMA_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL } from './sql.js';

export async function install(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(RECORD_TABLE_SQL);
  for (const indexSql of RECORD_INDEXES_SQL) {
    await pool.query(indexSql);
  }
}
