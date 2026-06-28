#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { install, uninstall } from '../dist/install.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf8'),
);

function printUsage() {
  console.error(`pg-bossier ${pkg.version}

Usage:
  pgbossier install   [--conn-string=<url>] [--schema=<n>] [--pgboss-schema=<n>]
  pgbossier uninstall [--conn-string=<url>] [--schema=<n>]
  pgbossier --help
  pgbossier --version

Connection string sources (first match wins):
  1. --conn-string=<url>
  2. PGBOSSIER_CONN_STRING env var
  3. DATABASE_URL env var

Exit codes:
  0   success
  1   usage error / --help
  2   runtime error (connect failed, SQL error)
  64  invalid schema name`);
}

let exitCode = 0;
let pool = null;

try {
  const { values, positionals } = parseArgs({
    options: {
      'conn-string':   { type: 'string' },
      'schema':        { type: 'string' },
      'pgboss-schema': { type: 'string' },
      'help':          { type: 'boolean', short: 'h' },
      'version':       { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.version) {
    console.log(pkg.version);
    process.exit(0);
  }
  if (values.help || positionals.length === 0) {
    printUsage();
    process.exit(1);
  }

  const cmd = positionals[0];
  if (cmd !== 'install' && cmd !== 'uninstall') {
    printUsage();
    process.exit(1);
  }

  const connString =
    values['conn-string'] ??
    process.env.PGBOSSIER_CONN_STRING ??
    process.env.DATABASE_URL;
  if (!connString) {
    console.error(
      'pgbossier: no connection string. Pass --conn-string or set ' +
      'PGBOSSIER_CONN_STRING / DATABASE_URL.',
    );
    process.exit(1);
  }

  // Print destination (without credentials) before any SQL runs. The DSN may be
  // a URL or a libpq keyword/value string ("host=... dbname=..."); only URLs
  // parse via `new URL`, so degrade gracefully instead of aborting this cosmetic
  // print on a non-URL DSN (#44). The connect path below decides real validity.
  let target = '';
  try {
    const url = new URL(connString);
    target = `host=${url.host} database=${url.pathname.slice(1) || '(default)'} `;
  } catch {
    // Non-URL (keyword/value) DSN — omit host/db rather than risk echoing a
    // password embedded in the raw string.
  }
  console.log(
    `pgbossier: ${cmd} into ${target}` +
    `schema=${values['schema'] ?? 'pgbossier'}` +
    (cmd === 'install' ? ` pgbossSchema=${values['pgboss-schema'] ?? 'pgboss'}` : ''),
  );

  pool = new pg.Pool({
    connectionString: connString,
    connectionTimeoutMillis: 10_000,
  });

  if (cmd === 'install') {
    const { backfilled } = await install(pool, {
      schema:       values['schema'],
      pgbossSchema: values['pgboss-schema'],
    });
    console.log(`pgbossier: installed (backfilled ${backfilled} existing job${backfilled === 1 ? '' : 's'})`);
  } else {
    await uninstall(pool, { schema: values['schema'] });
    console.log('pgbossier: uninstalled');
  }
} catch (err) {
  if (err && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(`pgbossier: ${err.message}`);
    exitCode = 1;
  } else if (err instanceof Error && /pg-?bossier:.*schema name/.test(err.message)) {
    console.error(err.message);
    exitCode = 64;
  } else {
    console.error(
      `pgbossier: ${err instanceof Error ? err.message : String(err)}`,
    );
    exitCode = 2;
  }
} finally {
  if (pool) {
    await pool.end().catch(() => { /* connection may already be down */ });
  }
}
process.exit(exitCode);
