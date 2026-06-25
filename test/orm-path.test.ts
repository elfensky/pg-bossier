import { test, expect } from 'vitest';
import { setClaim } from '../src/claim.js';
import { prune } from '../src/prune.js';
import { resolveSchemas } from '../src/sql.js';
import type { BossierDb } from '../src/db.js';

// Regression for the BYO/ORM path (#39-43 review). pg-boss's `executeSql`
// contract (db = boss.getDb(), i.e. Drizzle / Prisma / Knex / Kysely) returns
// ONLY `{ rows }` — no `rowCount`. setClaim (CAS won/lost) and prune (deleted
// count) MUST derive their result from RETURNING rows, not rowCount, or they're
// silently wrong on every ORM adapter. The container suite uses pg.Pool (which
// DOES return rowCount), so it can't catch this — hence these rows-only stubs.

const S = resolveSchemas();
const UUID = '11111111-1111-1111-1111-111111111111';

/** A db honoring only pg-boss's `{ rows }` contract — no rowCount, like every ORM adapter. */
function rowsOnlyDb(rows: unknown[]): BossierDb {
  return { query: () => Promise.resolve({ rows }) } as unknown as BossierDb;
}

test('setClaim derives won/lost from RETURNING rows on a rowCount-less (ORM) db', async () => {
  // claim won → UPDATE ... RETURNING yields a row even though rowCount is absent
  await expect(setClaim(rowsOnlyDb([{ job_id: UUID }]), S, UUID, 'w1')).resolves.toBe(true);
  // claim lost / no match → zero rows
  await expect(setClaim(rowsOnlyDb([]), S, UUID, 'w1')).resolves.toBe(false);
});

test('prune derives the deleted count from RETURNING rows on a rowCount-less (ORM) db', async () => {
  await expect(
    prune(rowsOnlyDb([{ job_id: 'a' }, { job_id: 'b' }, { job_id: 'c' }]), S, { keepLastPerQueue: 0 }),
  ).resolves.toEqual({ deleted: 3 });
  await expect(
    prune(rowsOnlyDb([]), S, { olderThan: new Date() }),
  ).resolves.toEqual({ deleted: 0 });
});
