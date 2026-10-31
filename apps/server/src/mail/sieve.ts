import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';

/**
 * Minimal ManageSieve (RFC 5804) client: STARTTLS, AUTHENTICATE PLAIN, LISTSCRIPTS, GETSCRIPT,
 * PUTSCRIPT, SETACTIVE, LOGOUT.
 */
class SieveConnection {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  capabilities = new Map<string, string>();

  constructor(private socket: net.Socket | tls.TLSSocket) {
    this.attach(socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket) {
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.waiters.splice(0).forEach((w) => w());
    });
    socket.on('close', () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
    socket.on('error', () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  private async more() {
    if (this.closed) throw new Error('sieve connection closed');
    await new Promise<void>((r) => this.waiters.push(r));
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 2);
        return line;
      }
      await this.more();
    }
  }

  private async readBytes(n: number): Promise<string> {
    while (this.buf.length < n) await this.more();
    const s = this.buf.subarray(0, n).toString('utf8');
    this.buf = this.buf.subarray(n);
    return s;
  }

  /** Read a full response: data lines (with literals expanded) until OK/NO/BYE. */
  async response(): Promise<{ status: 'OK' | 'NO' | 'BYE'; lines: string[][]; text: string }> {
    const lines: string[][] = [];
    for (;;) {
      let line = await this.readLine();
      // expand literals {n} / {n+} at end of line
      const parts: string[] = [];
      for (;;) {
        const m = /\{(\d+)\+?\}$/.exec(line);
        if (!m) {
          parts.push(line);
          break;
        }
        parts.push(line.slice(0, m.index));
        parts.push('\u0000LIT' + (await this.readBytes(Number(m[1]))));
        line = await this.readLine();
      }
      const tokens = tokenize(parts);
      const head = tokens[0]?.toUpperCase();
      if (head === 'OK' || head === 'NO' || head === 'BYE') {
        return { status: head as 'OK' | 'NO' | 'BYE', lines, text: tokens.slice(1).join(' ') };
      }
      lines.push(tokens);
    }
  }

  write(s: string) {
    this.socket.write(s);
  }

  async upgrade(servername: string, opts: tls.ConnectionOptions) {
    this.socket.removeAllListeners('data');
    const secure = tls.connect({ socket: this.socket, servername, ...opts });
    await new Promise<void>((res, rej) => {
      secure.once('secureConnect', () => res());
      secure.once('error', rej);
    });
    this.socket = secure;
    this.buf = Buffer.alloc(0);
    this.attach(secure);
  }

  close() {
    this.socket.end();
  }
}

function tokenize(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (p.startsWith('\u0000LIT')) {
      out.push(p.slice(4));
      continue;
    }
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return out;
}

const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
const literal = (s: string) => `{${Buffer.byteLength(s)}+}\r\n${s}`;

export class SieveClient {
  private conn!: SieveConnection;

  constructor(
    private cfg: Config,
    private username: string,
    private password: string,
  ) {}

  async connect() {
    const ep = this.cfg.sieve;
    if (!ep) throw new Error('ManageSieve is not configured');
    const socket = net.connect({ host: ep.host, port: ep.port });
    await new Promise<void>((res, rej) => {
      socket.once('connect', () => res());
      socket.once('error', rej);
      socket.setTimeout(15_000, () => socket.destroy(new Error('sieve timeout')));
    });
    this.conn = new SieveConnection(socket);
    let greet = await this.conn.response();
    this.readCaps(greet.lines);
    const tlsOpts = {
      rejectUnauthorized: !this.cfg.tlsInsecure,
      minVersion: 'TLSv1.2' as const,
      ca: this.cfg.caFile ? readFileSync(this.cfg.caFile) : undefined,
    };
    if (ep.tls !== 'none') {
      if (!this.conn.capabilities.has('STARTTLS')) throw new Error('ManageSieve server does not offer STARTTLS');
      this.conn.write('STARTTLS\r\n');
      const r = await this.conn.response();
      if (r.status !== 'OK') throw new Error(`STARTTLS failed: ${r.text}`);
      await this.conn.upgrade(ep.servername ?? ep.host, tlsOpts);
      greet = await this.conn.response(); // capabilities are re-sent after STARTTLS
      this.conn.capabilities.clear();
      this.readCaps(greet.lines);
    }
    const plain = Buffer.from(`\0${this.username}\0${this.password}`).toString('base64');
    this.conn.write(`AUTHENTICATE "PLAIN" ${quote(plain)}\r\n`);
    const auth = await this.conn.response();
    if (auth.status !== 'OK') throw new Error('ManageSieve authentication failed');
  }

  private readCaps(lines: string[][]) {
    for (const l of lines) if (l[0]) this.conn.capabilities.set(l[0].toUpperCase(), l[1] ?? '');
  }

  get extensions(): string[] {
    return (this.conn.capabilities.get('SIEVE') ?? '').split(/\s+/).filter(Boolean);
  }

  async listScripts(): Promise<{ name: string; active: boolean }[]> {
    this.conn.write('LISTSCRIPTS\r\n');
    const r = await this.conn.response();
    if (r.status !== 'OK') throw new Error(r.text);
    return r.lines.map((l) => ({ name: l[0], active: (l[1] ?? '').toUpperCase() === 'ACTIVE' }));
  }

  async getScript(name: string): Promise<string> {
    this.conn.write(`GETSCRIPT ${quote(name)}\r\n`);
    const r = await this.conn.response();
    if (r.status !== 'OK') throw new Error(r.text);
    return r.lines[0]?.[0] ?? '';
  }

  async putScript(name: string, content: string) {
    this.conn.write(`PUTSCRIPT ${quote(name)} ${literal(content)}\r\n`);
    const r = await this.conn.response();
    if (r.status !== 'OK') throw new Error(`The mail server rejected the filter script: ${r.text}`);
  }

  async setActive(name: string) {
    this.conn.write(`SETACTIVE ${quote(name)}\r\n`);
    const r = await this.conn.response();
    if (r.status !== 'OK') throw new Error(r.text);
  }

  async logout() {
    try {
      this.conn.write('LOGOUT\r\n');
      await this.conn.response();
    } catch {
      /* ignore */
    }
    this.conn.close();
  }
}

// ---------------------------------------------------------------------------
// The Tidings script: a structured, round-trippable model stored as JSON in a comment.

export interface SieveRule {
  id: string;
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: { field: 'from' | 'to' | 'subject' | 'cc' | 'list-id'; op: 'contains' | 'is' | 'not-contains'; value: string }[];
  actions: { type: 'move' | 'mark-read' | 'star' | 'discard' | 'forward' | 'stop'; value?: string }[];
}

export interface Vacation {
  enabled: boolean;
  subject: string;
  body: string;
  days: number;
  from?: number; // epoch ms
  until?: number;
  addresses: string[];
}

export interface TidingsSieve {
  rules: SieveRule[];
  vacation: Vacation;
  includes: string[]; // previously active scripts we keep running via include
}

export const SCRIPT_NAME = 'tidings';
const MARKER = '# tidings-model:';

const esc = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
const multiline = (s: string) => `text:\r\n${s.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.\r\n`;

export function renderScript(model: TidingsSieve, extensions: string[]): string {
  const req = new Set<string>();
  const body: string[] = [];
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  if (model.vacation.enabled) {
    req.add('vacation');
    const conds: string[] = [];
    if (model.vacation.from || model.vacation.until) {
      if (!extensions.includes('date') || !extensions.includes('relational')) {
        throw new Error('This mail server does not support date-limited vacation replies (Sieve "date"/"relational" extensions)');
      }
      req.add('date');
      req.add('relational');
      if (model.vacation.from) conds.push(`currentdate :value "ge" "date" ${esc(ymd(model.vacation.from))}`);
      if (model.vacation.until) conds.push(`currentdate :value "le" "date" ${esc(ymd(model.vacation.until))}`);
    }
    const addrs = model.vacation.addresses.length ? ` :addresses [${model.vacation.addresses.map(esc).join(', ')}]` : '';
    const action = `vacation :days ${Math.max(1, Math.min(30, model.vacation.days || 1))} :subject ${esc(model.vacation.subject || 'Out of office')}${addrs} ${multiline(model.vacation.body || '')};`;
    body.push(conds.length ? `if allof (${conds.join(', ')}) {\r\n  ${action}\r\n}` : action);
  }

  for (const rule of model.rules) {
    if (!rule.enabled || !rule.conditions.length || !rule.actions.length) continue;
    const tests = rule.conditions.map((c) => {
      const header = c.field === 'list-id' ? 'List-Id' : c.field[0].toUpperCase() + c.field.slice(1);
      const kind = c.field === 'from' || c.field === 'to' || c.field === 'cc' ? 'address' : 'header';
      const op = c.op === 'is' ? ':is' : ':contains';
      const t = `${kind} ${op} ${esc(header)} ${esc(c.value)}`;
      return c.op === 'not-contains' ? `not ${t}` : t;
    });
    const acts: string[] = [];
    for (const a of rule.actions) {
      if (a.type === 'move' && a.value) {
        req.add('fileinto');
        acts.push(`fileinto ${esc(a.value)};`);
      } else if (a.type === 'mark-read') {
        req.add('imap4flags');
        acts.push('addflag "\\\\Seen";');
      } else if (a.type === 'star') {
        req.add('imap4flags');
        acts.push('addflag "\\\\Flagged";');
      } else if (a.type === 'discard') acts.push('discard;');
      else if (a.type === 'forward' && a.value) {
        req.add('copy');
        acts.push(`redirect :copy ${esc(a.value)};`);
      } else if (a.type === 'stop') acts.push('stop;');
    }
    body.push(`# rule: ${rule.name.replace(/[\r\n]/g, ' ')}\r\nif ${rule.match === 'all' ? 'allof' : 'anyof'} (${tests.join(', ')}) {\r\n  ${acts.join('\r\n  ')}\r\n}`);
  }

  for (const inc of model.includes) {
    req.add('include');
    body.push(`include :personal ${esc(inc)};`);
  }

  for (const r of req) {
    if (r !== 'include' && !extensions.includes(r)) throw new Error(`This mail server does not support the Sieve "${r}" extension`);
    if (r === 'include' && !extensions.includes('include')) throw new Error('This mail server cannot keep your existing filters (no Sieve "include")');
  }
  const header = `${MARKER}${Buffer.from(JSON.stringify(model)).toString('base64')}\r\n# Managed by Tidings. Edit in Settings → Filters; manual edits will be replaced.\r\n`;
  const requires = req.size ? `require [${[...req].map(esc).join(', ')}];\r\n` : '';
  return `${header}${requires}${body.join('\r\n')}\r\n`;
}

export function parseModel(script: string): TidingsSieve | null {
  const line = script.split(/\r?\n/).find((l) => l.startsWith(MARKER));
  if (!line) return null;
  try {
    return JSON.parse(Buffer.from(line.slice(MARKER.length), 'base64').toString('utf8')) as TidingsSieve;
  } catch {
    return null;
  }
}

export const emptyModel = (): TidingsSieve => ({
  rules: [],
  vacation: { enabled: false, subject: 'Out of office', body: '', days: 7, addresses: [] },
  includes: [],
});
