/**
 * Poll `predicate` until it returns true or `timeout` ms elapse. Replaces fixed
 * `setTimeout` sleeps that wait for asynchronous LISTEN/NOTIFY or trigger
 * propagation before asserting: a fixed sleep is either too short (flaky under
 * CI load) or needlessly slow. This waits only as long as needed and throws a
 * clear, fast error if the condition never holds.
 *
 * Use only for *positive* conditions (something will become true). A test that
 * asserts nothing happened (a count stays 0) still needs a fixed wait — there is
 * nothing to poll for.
 */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
  const { timeout = 5000, interval = 25, message = 'condition' } = opts;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${String(timeout)}ms waiting for ${message}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
