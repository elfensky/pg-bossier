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

const STATE_TO_EVENT: Record<string, JobEventName> = {
  created:   'created',
  active:    'started',
  retry:     'retried',
  completed: 'completed',
  failed:    'failed',
  cancelled: 'cancelled',
};

class BossierEventsImpl extends EventEmitter implements BossierEvents {
  private pool: Pool;
  private client: PoolClient | null = null;
  private closed = false;
  private seenUnknownStates = new Set<string>();

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  async open(): Promise<void> {
    if (this.closed) return;
    this.client = await this.pool.connect();
    this.client.on('notification', (msg) => this.handleNotification(msg));
    await this.client.query('LISTEN pgbossier_job');
    // Emit on next I/O tick so callers can register listeners before it fires.
    setImmediate(() => { if (!this.closed) this.emit('connected'); });
  }

  private emitError(reason: ErrorReason, error: unknown): void {
    const event: BossierErrorEvent = { reason, error, at: new Date() };
    this.emit('error', event);
  }

  private safeEmit<K extends keyof BossierEventsMap>(
    name: K, ...args: BossierEventsMap[K]
  ): void {
    const listeners = this.listeners(name).slice();
    for (const listener of listeners) {
      try {
        (listener as (...a: BossierEventsMap[K]) => void)(...args);
      } catch (err) {
        this.emitError('handler', err);
      }
    }
  }

  private handleNotification(msg: { channel: string; payload?: string }): void {
    if (this.closed) return;
    if (msg.channel !== 'pgbossier_job' || msg.payload === undefined) return;

    let parsed: { job_id?: string; queue?: string; attempt?: number;
                  state?: string; seq?: number | string; captured_at?: string };
    try {
      parsed = JSON.parse(msg.payload) as typeof parsed;
    } catch (err) {
      this.emitError('parse', err);
      return;
    }

    const { job_id, queue, attempt, state, seq, captured_at } = parsed;
    if (typeof job_id !== 'string' || typeof queue !== 'string' ||
        typeof attempt !== 'number' || typeof state !== 'string' ||
        (typeof seq !== 'number' && typeof seq !== 'string') ||
        typeof captured_at !== 'string') {
      this.emitError('parse', new Error(`pgbossier: malformed notification payload: ${msg.payload}`));
      return;
    }

    const eventName = STATE_TO_EVENT[state];
    const jobEvent: JobEvent = {
      event: eventName ?? state,
      jobId: job_id,
      queue,
      attempt,
      state,
      seq: BigInt(seq),
      capturedAt: new Date(captured_at),
    };

    if (eventName) {
      this.safeEmit(eventName, jobEvent);   // per-type first
    } else {
      if (!this.seenUnknownStates.has(state)) {
        this.seenUnknownStates.add(state);
        const warning: BossierWarningEvent = {
          unknownState: state, jobId: job_id, at: new Date(),
        };
        this.emit('warning', warning);
      }
    }
    this.safeEmit('job', jobEvent);          // then catch-all
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
