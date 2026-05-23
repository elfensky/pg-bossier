import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import type { JobState } from './read.js';
import type { SchemaNames } from './sql.js';

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
  private schemas: SchemaNames;
  private client: PoolClient | null = null;
  private closed = false;
  private seenUnknownStates = new Set<string>();
  private failureCount = 0;
  private reconnectCancellers: (() => void)[] = [];
  /** True only for the very first open() call — used to defer the 'connected' emit. */
  private isFirstOpen = true;

  constructor(pool: Pool, schemas: SchemaNames) {
    super();
    this.pool = pool;
    this.schemas = schemas;
  }

  // Stable references for listener removal on release.
  private readonly boundNotification = (msg: { channel: string; payload?: string }) => { this.handleNotification(msg); };
  private readonly boundError = (err: unknown) => { this.onClientLost(err); };
  private readonly boundEnd = () => { this.onClientLost(new Error('connection ended')); };

  async open(): Promise<void> {
    if (this.closed) return;
    this.client = await this.pool.connect();
    this.client.on('notification', this.boundNotification);
    this.client.on('error', this.boundError);
    this.client.on('end', this.boundEnd);
    await this.client.query(`LISTEN ${this.schemas.pgbossier}_job`);
    this.failureCount = 0;
    if (this.isFirstOpen) {
      this.isFirstOpen = false;
      // Defer the initial 'connected' so callers can register listeners after subscribe() returns.
      setImmediate(() => { if (!this.closed) this.emit('connected'); });
    } else {
      this.emit('connected');
    }
  }

  private removeClientListeners(): void {
    if (!this.client) return;
    this.client.off('notification', this.boundNotification);
    this.client.off('error', this.boundError);
    this.client.off('end', this.boundEnd);
  }

  private onClientLost(err: unknown): void {
    if (this.closed || !this.client) return;
    this.removeClientListeners();
    try { this.client.release(err instanceof Error ? err : new Error(String(err))); } catch { /* */ }
    this.client = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delayMs = this.computeBackoffMs();
    const wait = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      this.reconnectCancellers.push(() => { clearTimeout(timer); resolve(); });
    });
    void wait.then(async () => {
      if (this.closed) return;
      try {
        await this.open();
        this.emitError('gap', new Error('event-stream gap during reconnect'));
      } catch {
        this.failureCount += 1;
        this.scheduleReconnect();
      }
    });
  }

  private computeBackoffMs(): number {
    const base = Math.min(1000 * Math.pow(2, this.failureCount), 30_000);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(base * jitter);
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
    const expectedChannel = `${this.schemas.pgbossier}_job`;
    if (msg.channel !== expectedChannel || msg.payload === undefined) return;

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
    for (const cancel of this.reconnectCancellers.slice()) {
      try { cancel(); } catch { /* */ }
    }
    this.reconnectCancellers = [];
    if (this.client) {
      this.removeClientListeners();
      try { await this.client.query(`UNLISTEN ${this.schemas.pgbossier}_job`); } catch { /* connection may be dead */ }
      this.client.release();
      this.client = null;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export async function subscribe(
  pool: Pool,
  schemas: SchemaNames,
  opts: SubscribeOptions = {},
): Promise<BossierEvents> {
  if (opts.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const events = new BossierEventsImpl(pool, schemas);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => { void events.close(); }, { once: true });
  }
  await events.open();
  return events;
}
