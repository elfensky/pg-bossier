import { test, expect, describe } from 'vitest';
import { assertSchemaName, resolveSchemas } from '../src/sql.js';

describe('assertSchemaName — valid names accepted', () => {
  for (const name of ['pgbossier', 'pgboss', 'altbossier', 'a_b_c', '_under', 'a1']) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).not.toThrow();
    });
  }
});

describe('assertSchemaName — regex rejection', () => {
  for (const name of ['Has-Dash', 'has space', 'has.dot', '"quoted"', 'UpperCase', '1starts_digit', '']) {
    test(`rejects ${JSON.stringify(name)} (regex)`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/Must match/);
    });
  }
});

describe('assertSchemaName — pg_ prefix rejection', () => {
  for (const name of ['pg_', 'pg_catalog', 'pg_temp', 'pg_bossier_alt']) {
    test(`rejects ${JSON.stringify(name)} (pg_ prefix)`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/'pg_' prefix/);
    });
  }
});

describe('assertSchemaName — reserved-name rejection (data-loss prevention)', () => {
  test('rejects "public" (would DROP SCHEMA public CASCADE all user tables)', () => {
    expect(() => assertSchemaName('public', 'pgbossier')).toThrow(/reserved/);
  });
  test('rejects "information_schema"', () => {
    expect(() => assertSchemaName('information_schema', 'pgbossier')).toThrow(/reserved/);
  });
});

describe('assertSchemaName — reserved-keyword rejection', () => {
  for (const name of ['user', 'select', 'from', 'table', 'where', 'order', 'group']) {
    test(`rejects ${JSON.stringify(name)} (reserved keyword)`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/reserved keyword/);
    });
  }
});

describe('assertSchemaName — length rejection', () => {
  test('accepts a 63-byte name (NAMEDATALEN limit)', () => {
    const name = 'a' + 'b'.repeat(62);
    expect(name.length).toBe(63);
    expect(() => assertSchemaName(name, 'pgbossier')).not.toThrow();
  });
  test('rejects a 64-byte name (over NAMEDATALEN)', () => {
    const name = 'a' + 'b'.repeat(63);
    expect(name.length).toBe(64);
    expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/exceeds 63 bytes/);
  });
});

describe('resolveSchemas — defaults and overrides', () => {
  test('returns defaults when no options', () => {
    expect(resolveSchemas()).toEqual({ pgbossier: 'pgbossier', pgboss: 'pgboss' });
  });
  test('returns defaults when empty options', () => {
    expect(resolveSchemas({})).toEqual({ pgbossier: 'pgbossier', pgboss: 'pgboss' });
  });
  test('overrides pgbossier only', () => {
    expect(resolveSchemas({ pgbossier: 'alt' })).toEqual({ pgbossier: 'alt', pgboss: 'pgboss' });
  });
  test('overrides pgboss only', () => {
    expect(resolveSchemas({ pgboss: 'altpgboss' })).toEqual({ pgbossier: 'pgbossier', pgboss: 'altpgboss' });
  });
  test('rejects invalid pgbossier name', () => {
    expect(() => resolveSchemas({ pgbossier: 'public' })).toThrow(/reserved/);
  });
  test('rejects invalid pgboss name', () => {
    expect(() => resolveSchemas({ pgboss: 'pg_temp' })).toThrow(/'pg_' prefix/);
  });
});
