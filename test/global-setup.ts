import type { TestProject } from 'vitest/node';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Global setup for the integration suite (#16). Boots ONE Postgres container for
 * the entire run and hands its connection string to every worker via vitest's
 * `provide()` / `inject()`. Each test file's `startHarness()` then creates a
 * fresh *database* inside this one container (default schema names → test SQL is
 * unchanged), so the slow part — booting a container — happens once for the whole
 * suite instead of once per file. Teardown stops the container, dropping all
 * per-file databases wholesale.
 */
let container: StartedPostgreSqlContainer | null = null;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  project.provide('pgSharedUrl', container.getConnectionUri());
  return async () => {
    await container?.stop();
    container = null;
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    pgSharedUrl: string;
  }
}
