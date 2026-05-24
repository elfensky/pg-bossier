/**
 * JSON-stringify a value with explicit guards. Throws with a pg-bossier-
 * prefixed message identifying `fieldName` for any non-serializable input.
 *
 * Standard JSON.stringify behaviors are preserved (not coerced):
 *  - Date → ISO string (caller must format if they want fidelity).
 *  - Non-finite numbers (NaN, Infinity) → JSON null.
 *  - Symbol-keyed properties → silently dropped.
 *
 * Throw paths:
 *  - JSON.stringify synchronous throw (BigInt, circular reference) →
 *    `pg-bossier: <fieldName> validation: value is not JSON-serializable: <err>`.
 *  - JSON.stringify returns undefined (function, symbol top-level) →
 *    `pg-bossier: <fieldName> validation: value is not JSON-serializable`.
 *
 * Returns the JSON string on success.
 */
export function stringifyOrThrow(value: unknown, fieldName: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new Error(
      `pg-bossier: ${fieldName} validation: value is not JSON-serializable: ${String(err)}`,
    );
  }
  if (json === undefined) {
    throw new Error(
      `pg-bossier: ${fieldName} validation: value is not JSON-serializable`,
    );
  }
  return json;
}
