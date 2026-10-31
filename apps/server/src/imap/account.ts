import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import type { Config } from '../config.js';

export class AuthFailedError extends Error {
  code = 'AUTH_FAILED';
}

export class UidValidityChangedError extends Error {
  code = 'UIDVALIDITY_CHANGED';
  constructor(public mailbox: string) {
    super(`UIDVALIDITY of ${mailbox} changed`);
  }
}

export interface ServerEvent {
  type: 'mailbox' | 'mailboxes' | 'outbox' | 'resync' | 'snooze' | 'auth';
  [k: string]: unknown;
}

export interface Logger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

const MAX_WORKERS = 2;
const WORKER_IDLE_MS = 5 * 60_000;

interface Worker {
  client: ImapFlow;
  busy: boolean;
  lastUsed: number;
}

/**
 * One Account per (IMAP host, username), shared across every session, tab and device of that user.
 * Holds at most MAX_WORKERS command connections plus one IDLE connection (only while a browser is
 * listening), so we stay well under Dovecot's mail_max_userip_connections.
 */
export class Account extends EventEmitter {
  private workers: Worker[] = [];
  private waiters: Array<{ resolve: (w: Worker) => void; reject: (e: Error) => void; priority: number }> = [];
  private idleClient: ImapFlow | null = null;
  private idleStarting = false;
  listeners_ = 0;
  capabilities = new Map<string, boolean | number>();
  enabled = new Set<string>();
  private backoffUntil = 0;
  private dead = false;
  lastActivity = Date.now();
  originatingIp?: string;

  constructor(
    public readonly userKey: string,
    public readonly username: string,
    private password: string,
    private cfg: Config,
    private log: Logger,
  ) {
    super();
    this.setMaxListeners(100);
  }

  updatePassword(pw: string) {
    this.password = pw;
    this.dead = false;
  }

  private tlsOptions() {
    const ep = this.cfg.imap;
    return {
      rejectUnauthorized: !this.cfg.tlsInsecure,
      minVersion: 'TLSv1.2' as const,
      servername: ep.servername ?? ep.host,
      ca: this.cfg.caFile ? readFileSync(this.cfg.caFile) : undefined,
    };
  }

  createClient(kind: 'worker' | 'idle' | 'verify'): ImapFlow {
    const ep = this.cfg.imap;
    const client = new ImapFlow({
      host: ep.host,
      port: ep.port,
      secure: ep.tls === 'tls',
      doSTARTTLS: ep.tls === 'starttls' ? true : ep.tls === 'none' ? false : undefined,
      servername: ep.servername,
      auth: { user: this.username, pass: this.password },
      tls: this.tlsOptions(),
      logger: false,
      disableAutoIdle: kind !== 'idle',
      maxIdleTime: 4 * 60_000,
      qresync: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: kind === 'idle' ? 10 * 60_000 : 5 * 60_000,
      clientInfo: {
        name: 'Tidings',
        vendor: 'Tidings',
        'support-url': this.cfg.sourceUrl,
        ...(this.originatingIp ? { 'x-originating-ip': this.originatingIp } : {}),
      },
    } as ConstructorParameters<typeof ImapFlow>[0] & { doSTARTTLS?: boolean });
    client.on('error', (err: Error) => {
      this.log.warn({ err: err.message, kind }, 'imap connection error');
    });
    return client;
  }

  private async connect(kind: 'worker' | 'idle'): Promise<ImapFlow> {
    if (this.dead) throw new AuthFailedError('Credentials rejected by the mail server');
    const wait = this.backoffUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
    const client = this.createClient(kind);
    try {
      await client.connect();
    } catch (err) {
      const e = err as { authenticationFailed?: boolean; serverResponseCode?: string; responseText?: string; message: string };
      if (e.authenticationFailed || e.serverResponseCode === 'AUTHENTICATIONFAILED') {
        this.dead = true;
        this.emit('event', { type: 'auth', reason: 'failed' } satisfies ServerEvent);
        this.emit('auth-failed');
        throw new AuthFailedError('Credentials rejected by the mail server');
      }
      // [LIMIT], [UNAVAILABLE], BYE, network errors: back off exponentially
      const prev = Math.max(1000, (this.backoffUntil - Date.now()) * 2);
      this.backoffUntil = Date.now() + Math.min(prev, 60_000);
      throw err;
    }
    this.capabilities = client.capabilities;
    this.enabled = client.enabled;
    this.backoffUntil = 0;
    return client;
  }

  has(cap: string): boolean {
    return this.capabilities.has(cap);
  }

  /** Run a task on a pooled command connection. Higher priority runs first when the pool is full. */
  async run<T>(fn: (client: ImapFlow) => Promise<T>, priority = 5): Promise<T> {
    this.lastActivity = Date.now();
    const worker = await this.acquire(priority);
    try {
      return await fn(worker.client);
    } catch (err) {
      if (!worker.client.usable) this.drop(worker);
      throw err;
    } finally {
      this.release(worker);
    }
  }

  private async acquire(priority: number): Promise<Worker> {
    const free = this.workers.find((w) => !w.busy && w.client.usable);
    if (free) {
      free.busy = true;
      return free;
    }
    this.workers = this.workers.filter((w) => w.client.usable || w.busy);
    if (this.workers.length < MAX_WORKERS) {
      const placeholder: Worker = { client: null as unknown as ImapFlow, busy: true, lastUsed: Date.now() };
      this.workers.push(placeholder);
      try {
        placeholder.client = await this.connect('worker');
        return placeholder;
      } catch (err) {
        this.workers = this.workers.filter((w) => w !== placeholder);
        throw err;
      }
    }
    return new Promise<Worker>((resolve, reject) => {
      this.waiters.push({ resolve, reject, priority });
      this.waiters.sort((a, b) => b.priority - a.priority);
    });
  }

  private release(worker: Worker) {
    worker.lastUsed = Date.now();
    if (!this.workers.includes(worker)) {
      this.pump();
      return;
    }
    const next = this.waiters.shift();
    if (next) {
      if (worker.client.usable) {
        next.resolve(worker);
        return;
      }
      this.drop(worker);
      this.acquire(next.priority).then(next.resolve, next.reject);
      return;
    }
    worker.busy = false;
  }

  private pump() {
    const next = this.waiters.shift();
    if (next) this.acquire(next.priority).then(next.resolve, next.reject);
  }

  private drop(worker: Worker) {
    this.workers = this.workers.filter((w) => w !== worker);
    try {
      worker.client.close();
    } catch {
      /* ignore */
    }
  }

  /** Close command connections idle for a while. Called periodically. */
  reap() {
    const now = Date.now();
    for (const w of [...this.workers]) {
      if (!w.busy && now - w.lastUsed > WORKER_IDLE_MS) {
        this.workers = this.workers.filter((x) => x !== w);
        w.client.logout().catch(() => w.client.close());
      }
    }
  }

  // ---------- IDLE / realtime ----------

  addListener_() {
    this.listeners_++;
    if (this.listeners_ === 1) void this.startIdle();
  }

  removeListener_() {
    this.listeners_ = Math.max(0, this.listeners_ - 1);
    if (this.listeners_ === 0) {
      setTimeout(() => {
        if (this.listeners_ === 0) this.stopIdle();
      }, 60_000).unref();
    }
  }

  private async startIdle() {
    if (this.idleClient || this.idleStarting || this.dead) return;
    this.idleStarting = true;
    try {
      const client = await this.connect('idle');
      this.idleClient = client;
      await client.mailboxOpen('INBOX', { readOnly: true });
      const changed = () => this.emit('inbox-changed');
      client.on('exists', changed);
      client.on('expunge', changed);
      client.on('flags', changed);
      client.on('close', () => {
        this.idleClient = null;
        if (this.listeners_ > 0 && !this.dead) {
          // reconnect and ask for a resync: events may have been missed
          setTimeout(() => {
            void this.startIdle().then(() => this.emit('inbox-changed'));
          }, 3000).unref();
        }
      });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'idle connection failed');
      if (this.listeners_ > 0 && !this.dead) setTimeout(() => void this.startIdle(), 15_000).unref();
    } finally {
      this.idleStarting = false;
    }
  }

  private stopIdle() {
    const c = this.idleClient;
    this.idleClient = null;
    if (c) c.logout().catch(() => c.close());
  }

  async shutdown() {
    this.dead = true;
    this.stopIdle();
    for (const w of this.workers) {
      w.client?.logout().catch(() => w.client?.close());
    }
    this.workers = [];
    for (const w of this.waiters) w.reject(new Error('account closed'));
    this.waiters = [];
  }

  get isDead() {
    return this.dead;
  }
}

export class AccountRegistry {
  private accounts = new Map<string, Account>();
  constructor(
    private cfg: Config,
    private log: Logger,
  ) {
    setInterval(() => {
      for (const a of this.accounts.values()) a.reap();
    }, 60_000).unref();
  }

  get(userKey: string): Account | undefined {
    return this.accounts.get(userKey);
  }

  getOrCreate(userKey: string, username: string, password: string, onCreate?: (a: Account) => void): Account {
    let acc = this.accounts.get(userKey);
    if (acc && acc.isDead) {
      acc.updatePassword(password);
    }
    if (!acc) {
      acc = new Account(userKey, username, password, this.cfg, this.log);
      this.accounts.set(userKey, acc);
      onCreate?.(acc);
    }
    return acc;
  }

  async remove(userKey: string) {
    const acc = this.accounts.get(userKey);
    this.accounts.delete(userKey);
    await acc?.shutdown();
  }

  all() {
    return [...this.accounts.values()];
  }
}
