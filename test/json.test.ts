import { describe, it, expect } from 'vitest';
import { stringifyOrThrow } from '../src/json.js';

describe('stringifyOrThrow', () => {
  it('returns a JSON string for a plain object', () => {
    expect(stringifyOrThrow({ a: 1 }, 'detail')).toBe('{"a":1}');
  });

  it('returns "null" for null', () => {
    expect(stringifyOrThrow(null, 'detail')).toBe('null');
  });

  it('throws on a top-level function (JSON.stringify returns undefined)', () => {
    expect(() => stringifyOrThrow(() => 1, 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('throws on a top-level symbol', () => {
    expect(() => stringifyOrThrow(Symbol('x'), 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('throws on BigInt', () => {
    expect(() => stringifyOrThrow({ id: 1n }, 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('throws on a circular reference', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => stringifyOrThrow(a, 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('encodes Date as ISO string (standard behavior)', () => {
    const d = new Date('2026-05-23T00:00:00Z');
    expect(stringifyOrThrow({ at: d }, 'detail'))
      .toBe('{"at":"2026-05-23T00:00:00.000Z"}');
  });

  it('encodes NaN as null (standard behavior)', () => {
    expect(stringifyOrThrow({ x: NaN }, 'detail')).toBe('{"x":null}');
  });

  it('includes the underlying error message on stringify throw', () => {
    try {
      stringifyOrThrow({ id: 1n }, 'detail');
    } catch (err) {
      expect((err as Error).message).toMatch(/BigInt/i);
    }
  });
});
