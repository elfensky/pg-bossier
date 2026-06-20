import { test, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startHarness, type Harness } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '../bin/pgbossier.js');

function runCli(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveP) => {
    const proc = spawn('node', [BIN, ...args], {
      env: { ...process.env, ...env, PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('--version prints package.json version', async () => {
  const { code, stdout } = await runCli(['--version']);
  expect(code).toBe(0);
  expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test('--help prints usage and exits 1', async () => {
  const { code, stderr } = await runCli(['--help']);
  expect(code).toBe(1);
  expect(stderr).toMatch(/Usage:/);
});

test('install with no conn-string exits 1', async () => {
  const { code, stderr } = await runCli(['install']);
  expect(code).toBe(1);
  expect(stderr).toMatch(/no connection string/);
});

test('install with unknown flag exits 1 (strict: true)', async () => {
  const { code, stderr } = await runCli([
    'install',
    '--unknown-flag=x',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(1);
  expect(stderr).toMatch(/Unknown option|unknown-flag/);
});

test('install with invalid schema name exits 64', async () => {
  const { code, stderr } = await runCli([
    'install',
    '--schema=public',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(64);
  expect(stderr).toMatch(/reserved/);
});

test('install success path exits 0 and prints destination + installed', async () => {
  const { code, stdout } = await runCli([
    'install',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/install into host=/);
  expect(stdout).toMatch(/schema=pgbossier/);
  expect(stdout).toMatch(/installed/);

  // Verify the schema actually exists
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(1);
});

test('uninstall success path exits 0', async () => {
  // Pre-condition: install must have happened (previous test)
  const { code, stdout } = await runCli([
    'uninstall',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/uninstalled/);

  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(0);
});

test('install exits cleanly (no hung connections after success)', async () => {
  // If pool.end() isn't called or the post-finally exit is wrong, the
  // process would hang and the test would time out. The fact that
  // runCli's `proc.on('close')` fires within the test timeout means the
  // process exited cleanly. This test just makes that assertion explicit.
  const start = Date.now();
  const { code } = await runCli([
    'install',
    `--conn-string=${h.connectionString}`,
  ]);
  const elapsed = Date.now() - start;
  expect(code).toBe(0);
  expect(elapsed).toBeLessThan(5000); // generous; expectation is <2s normally

  // Cleanup
  await runCli(['uninstall', `--conn-string=${h.connectionString}`]);
}, 10_000);
