#!/usr/bin/env node
/**
 * tidings doctor — answers "why can't it log in?" before your users do.
 *   node dist/cli.js doctor [--user alice@example.com --password-file /run/secrets/pw]
 * Checks config, data directory, IMAP/SMTP/ManageSieve reachability, TLS and capabilities,
 * and lists which Tidings features degrade without them.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { type Endpoint, loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
let failures = 0;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Read a line-based greeting (+ optional STARTTLS) without authenticating. */
async function probe(ep: Endpoint, kind: 'imap' | 'sieve', insecure: boolean, ca?: string): Promise<{ greeting: string; caps: string; tlsInfo?: string }> {
  const tlsOpts = { servername: ep.servername ?? ep.host, rejectUnauthorized: !insecure, ca: ca ? readFileSync(ca) : undefined, minVersion: 'TLSv1.2' as const };
  let sock: net.Socket = ep.tls === 'tls' ? tls.connect({ host: ep.host, port: ep.port, ...tlsOpts }) : net.connect({ host: ep.host, port: ep.port });
  sock.setTimeout(10_000, () => sock.destroy(new Error('timed out')));
  let buf = '';
  const waitFor = (re: RegExp) =>
    new Promise<string>((res, rej) => {
      const on = (d: Buffer) => {
        buf += d.toString('utf8');
        const m = re.exec(buf);
        if (m) {
          sock.off('data', on);
          const out = buf;
          buf = '';
          res(out);
        }
      };
      sock.on('data', on);
      sock.once('error', rej);
      sock.once('close', () => rej(new Error('connection closed')));
    });
  const greeting = kind === 'imap' ? await waitFor(/\r\n/) : await waitFor(/^(OK|NO|BYE).*\r\n/m);
  let tlsInfo: string | undefined;
  if (ep.tls === 'starttls') {
    sock.write(kind === 'imap' ? 'a1 STARTTLS\r\n' : 'STARTTLS\r\n');
    await waitFor(kind === 'imap' ? /a1 (OK|NO|BAD).*\r\n/ : /^(OK|NO|BYE).*\r\n/m);
    const secure = tls.connect({ socket: sock, ...tlsOpts });
    await new Promise<void>((res, rej) => {
      secure.once('secureConnect', () => res());
      secure.once('error', rej);
    });
    sock = secure;
    tlsInfo = `${secure.getProtocol()} ${secure.getCipher()?.name}`;
  } else if (ep.tls === 'tls') {
    tlsInfo = `${(sock as tls.TLSSocket).getProtocol()} ${(sock as tls.TLSSocket).getCipher()?.name}`;
  }
  let caps = '';
  if (kind === 'imap') {
    sock.write('a2 CAPABILITY\r\n');
    caps = await waitFor(/a2 (OK|NO|BAD).*\r\n/);
    sock.write('a3 LOGOUT\r\n');
  } else {
    caps = ep.tls === 'starttls' ? await waitFor(/^(OK|NO|BYE).*\r\n/m) : greeting;
    sock.write('LOGOUT\r\n');
  }
  sock.end();
  return { greeting: greeting.split('\r\n')[0], caps, tlsInfo };
}

const FEATURE_CAPS: [string, string][] = [
  ['MOVE', 'atomic moves (falls back to COPY + flag; never plain EXPUNGE)'],
  ['UIDPLUS', 'exact undo of moves and safe expunge (without it, deleted mail is only flagged \\Deleted)'],
  ['CONDSTORE', 'cheap flag sync (without it Tidings rescans flags)'],
  ['SPECIAL-USE', 'reliable Sent/Drafts/Trash detection (falls back to folder names)'],
  ['IDLE', 'instant new-mail push (falls back to polling every 60s)'],
  ['QUOTA', 'storage usage in the sidebar'],
  ['ID', 'passing the real client IP to the server (fail2ban on the mail server)'],
];

async function main() {
  const cmd = process.argv[2];
  if (cmd !== 'doctor') {
    console.log('Usage: tidings doctor [--user <login> --password-file <path>]');
    process.exit(cmd ? 1 : 0);
  }
  console.log('\nTidings doctor\n');
  console.log('Configuration');
  let cfg;
  try {
    cfg = loadConfig();
    ok(`public URL ${cfg.publicUrl.toString()}${cfg.basePath ? ` (served under ${cfg.basePath})` : ''}`);
    if (cfg.publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(cfg.publicUrl.hostname)) warn('public URL is not https — cookies will not be marked Secure');
    ok(`identity policy: ${cfg.identityPolicy}`);
    if (cfg.trustedProxies.length) ok(`trusted proxies: ${cfg.trustedProxies.join(', ')}`);
    else warn('TIDINGS_TRUSTED_PROXIES is empty — fine without a reverse proxy, wrong behind one (client IPs and rate limits)');
    if (cfg.tlsInsecure) warn('TIDINGS_TLS_INSECURE=true — mail server certificates are not verified');
  } catch (err) {
    bad((err as Error).message);
    process.exit(1);
  }

  console.log('\nStorage');
  try {
    accessSync(cfg.dataDir, constants.W_OK);
    const db = openDatabase(cfg.dataDir);
    const v = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    ok(`data directory ${cfg.dataDir} is writable, schema v${v}`);
    db.close();
  } catch (err) {
    bad(`data directory ${cfg.dataDir}: ${(err as Error).message}`);
    failures++;
  }

  console.log(`\nIMAP ${cfg.imap.host}:${cfg.imap.port} (${cfg.imap.tls})`);
  let caps = '';
  try {
    const r = await probe(cfg.imap, 'imap', cfg.tlsInsecure, cfg.caFile);
    ok(`greeting: ${r.greeting.slice(0, 80)}`);
    if (r.tlsInfo) ok(`TLS: ${r.tlsInfo}`);
    caps = r.caps.toUpperCase();
    if (/LOGINDISABLED/.test(caps)) warn('server advertises LOGINDISABLED (needs TLS before login)');
  } catch (err) {
    bad(`cannot reach IMAP: ${(err as Error).message}`);
    failures++;
  }

  const user = arg('user');
  const pwFile = arg('password-file');
  if (user && pwFile) {
    try {
      const client = new ImapFlow({
        host: cfg.imap.host,
        port: cfg.imap.port,
        secure: cfg.imap.tls === 'tls',
        auth: { user, pass: readFileSync(pwFile, 'utf8').trim() },
        tls: { rejectUnauthorized: !cfg.tlsInsecure, servername: cfg.imap.servername ?? cfg.imap.host },
        logger: false,
      } as ConstructorParameters<typeof ImapFlow>[0]);
      await client.connect();
      caps = [...client.capabilities.keys()].join(' ').toUpperCase();
      ok(`signed in as ${user}`);
      const list = await client.list();
      ok(`${list.length} folders; special-use: ${list.filter((m) => m.specialUse).map((m) => `${m.specialUse}=${m.path}`).join(', ') || 'none advertised'}`);
      await client.logout();
    } catch (err) {
      bad(`login as ${user} failed: ${(err as Error).message}`);
      failures++;
    }
  } else {
    console.log('  (pass --user and --password-file to also test a real login and post-login capabilities)');
  }
  if (caps) {
    for (const [cap, what] of FEATURE_CAPS) {
      if (caps.includes(cap)) ok(`${cap}`);
      else warn(`${cap} missing — ${what}`);
    }
  }

  console.log(`\nSMTP ${cfg.smtp.host}:${cfg.smtp.port} (${cfg.smtp.tls})`);
  try {
    const t = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.tls === 'tls',
      requireTLS: cfg.smtp.tls === 'starttls',
      ignoreTLS: cfg.smtp.tls === 'none',
      tls: { rejectUnauthorized: !cfg.tlsInsecure, servername: cfg.smtp.servername ?? cfg.smtp.host },
      connectionTimeout: 10_000,
    } as Parameters<typeof nodemailer.createTransport>[0]);
    await t.verify().catch((e: Error & { code?: string }) => {
      // Without credentials, an AUTH requirement is fine — we only test reachability and TLS here.
      if (e.code !== 'EAUTH' && !/auth/i.test(e.message)) throw e;
    });
    ok('reachable, TLS negotiated as configured');
  } catch (err) {
    bad(`SMTP: ${(err as Error).message}`);
    failures++;
  }

  if (cfg.sieve) {
    console.log(`\nManageSieve ${cfg.sieve.host}:${cfg.sieve.port} (${cfg.sieve.tls})`);
    try {
      const r = await probe(cfg.sieve, 'sieve', cfg.tlsInsecure, cfg.caFile);
      const ext = /"SIEVE" "([^"]*)"/i.exec(r.caps)?.[1] ?? '';
      ok(`extensions: ${ext || '(none listed)'}`);
      for (const need of ['fileinto', 'vacation', 'imap4flags', 'include']) {
        if (!ext.split(/\s+/).includes(need)) warn(`Sieve "${need}" missing — some filter actions will be unavailable`);
      }
    } catch (err) {
      bad(`ManageSieve: ${(err as Error).message}`);
      failures++;
    }
  } else {
    console.log('\nManageSieve: not configured (filters and vacation replies are hidden)');
  }

  console.log(failures ? `\n${failures} problem(s) found.\n` : '\nEverything looks good.\n');
  process.exit(failures ? 1 : 0);
}

void main();
