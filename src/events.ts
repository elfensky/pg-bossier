import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import type { JobState } from './read.js';

export type JobEventName =
  | 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'retried';

export interface JobEvent {
  /** Friendly event name. Pass-through string for unknown future pg-boss states. */
  event: JobEventName | (string & {});
  jobId: string;
  queue: string;
  attempt: number;
  /** Raw pg-boss state. */
  state: JobState | (string & {});
  /** Monotonic per-transition cursor. Pairs with getEventsSince(seq). */
  seq: bigint;
  capturedAt: Date;
}

export type ErrorReason = 'gap' | 'parse' | 'handler';

export interface BossierErrorEvent {
  reason: ErrorReason;
  error: unknown;
  at: Date;
}

export interface BossierWarningEvent {
  unknownState: string;
  jobId: string;
  at: Date;
}

interface BossierEventsMap {
  created:   [JobEvent];
  started:   [JobEvent];
  completed: [JobEvent];
  failed:    [JobEvent];
  cancelled: [JobEvent];
  retried:   [JobEvent];
  job:       [JobEvent];
  connected: [];
  warning:   [BossierWarningEvent];
  error:     [BossierErrorEvent];
}

export interface SubscribeOptions {
  signal?: AbortSignal;
}

export interface BossierEvents extends EventEmitter {
  on<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  once<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  off<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

class BossierEventsImpl extends EventEmitter implements BossierEvents {
  private pool: Pool;
  private client: PoolClient | null = null;
  private closed = false;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  async open(): Promise<void> {
    if (this.closed) return;
    this.client = await this.pool.connect();
    await this.client.query('LISTEN pgbossier_job');
    // Emit on next I/O tick so callers can register listeners before it fires.
    setImmediate(() => { if (!this.closed) this.emit('connected'); });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client) {
      try { await this.client.query('UNLISTEN pgbossier_job'); } catch { /* connection may be dead */ }
      this.client.release();
      this.client = null;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export async function subscribe(
  pool: Pool,
  opts: SubscribeOptions = {},
): Promise<BossierEvents> {
  if (opts.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const events = new BossierEventsImpl(pool);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => { void events.close(); }, { once: true });
  }
  await events.open();
  return events;
}
