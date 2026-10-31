import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { credentialKey, open, randomToken, seal, sessionIdFor } from './crypto.js';

export interface Session {
  sid: string;
  token: string;
  userKey: string;
  username: string;
  csrf: string;
  createdAt: number;
  publicComputer: boolean;
}

interface Row {
  sid: string;
  user_key: string;
  username: string;
  cred_nonce: Buffer;
  cred_ct: Buffer;
  cred_tag: Buffer;
  csrf: string;
  created_at: number;
  last_seen: number;
  expires_at: number;
  public_computer: number;
}

const aadFor = (sid: string, userKey: string) => `${sid}|${userKey}|v1`;

export class SessionStore {
  constructor(
    private db: DB,
    private cfg: Config,
  ) {}

  private idleMs(publicComputer: boolean) {
    return publicComputer ? 30 * 60_000 : this.cfg.sessionIdleMinutes * 60_000;
  }

  create(opts: {
    userKey: string;
    username: string;
    password: string;
    publicComputer: boolean;
    ip?: string;
    userAgent?: string;
  }): Session {
    const token = randomToken(32);
    const sid = sessionIdFor(this.cfg.secret, token);
    const key = credentialKey(this.cfg.secret, token, sid);
    const sealed = seal(key, Buffer.from(opts.password, 'utf8'), aadFor(sid, opts.userKey));
    const now = Date.now();
    const csrf = randomToken(24);
    const now2 = now;
    this.db
      .prepare(
        `INSERT INTO users (user_key, username, created_at, last_login) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_key) DO UPDATE SET last_login = excluded.last_login`,
      )
      .run(opts.userKey, opts.username, now, now2);
    this.db
      .prepare(
        `INSERT INTO sessions (sid, user_key, username, cred_nonce, cred_ct, cred_tag, csrf, created_at, last_seen, expires_at, public_computer, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sid,
        opts.userKey,
        opts.username,
        sealed.nonce,
        sealed.ct,
        sealed.tag,
        csrf,
        now,
        now,
        now + this.cfg.sessionMaxDays * 86_400_000,
        opts.publicComputer ? 1 : 0,
        opts.ip ?? null,
        (opts.userAgent ?? '').slice(0, 300),
      );
    return { sid, token, userKey: opts.userKey, username: opts.username, csrf, createdAt: now, publicComputer: opts.publicComputer };
  }

  /** Resolve a cookie token to a live session. `touch` = counts as user activity. */
  get(token: string | undefined, touch = true): Session | null {
    if (!token || token.length > 100) return null;
    const sid = sessionIdFor(this.cfg.secret, token);
    const row = this.db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid) as Row | undefined;
    if (!row) return null;
    const now = Date.now();
    const pc = row.public_computer === 1;
    if (now > row.expires_at || now - row.last_seen > this.idleMs(pc)) {
      this.destroy(sid);
      return null;
    }
    if (touch && now - row.last_seen > 30_000) {
      this.db.prepare('UPDATE sessions SET last_seen = ? WHERE sid = ?').run(now, sid);
    }
    return { sid, token, userKey: row.user_key, username: row.username, csrf: row.csrf, createdAt: row.created_at, publicComputer: pc };
  }

  password(session: Session): string {
    const row = this.db.prepare('SELECT * FROM sessions WHERE sid = ?').get(session.sid) as Row | undefined;
    if (!row) throw new Error('session gone');
    const key = credentialKey(this.cfg.secret, session.token, session.sid);
    return open(key, { nonce: row.cred_nonce, ct: row.cred_ct, tag: row.cred_tag }, aadFor(session.sid, session.userKey)).toString('utf8');
  }

  /** Key for encrypting other per-session data at rest (e.g. the outbox), derived like the credential key. */
  dataKey(session: Session): Buffer {
    return credentialKey(this.cfg.secret, session.token, session.sid, 'outbox');
  }

  destroy(sid: string) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  }

  destroyAllForUser(userKey: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_key = ?').run(userKey);
  }

  countForUser(userKey: string): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_key = ?').get(userKey) as { n: number }).n;
  }

  sweep() {
    const now = Date.now();
    this.db
      .prepare(
        `DELETE FROM sessions WHERE expires_at < ?
          OR (public_computer = 1 AND last_seen < ?)
          OR (public_computer = 0 AND last_seen < ?)`,
      )
      .run(now, now - this.idleMs(true), now - this.idleMs(false));
  }
}
