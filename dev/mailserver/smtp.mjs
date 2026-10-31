// Tidings dev SMTP submission server (loopback only, NEVER relays to the internet).
//  - AUTH PLAIN/LOGIN against users.example (plaintext allowed: loopback only)
//  - recipients @tidings.test  -> delivered to Dovecot over LMTP (127.0.0.1:12024), so Sieve runs
//  - every other recipient     -> written to run/outbound/<timestamp>.eml and dropped
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, 'run', 'outbound');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.DEV_SMTP_PORT ?? 2525);
const LOCAL_DOMAIN = 'tidings.test';

function loadUsers() {
  const users = new Map();
  for (const line of readFileSync(join(DIR, 'users.example'), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [user, pass] = line.split(':');
    users.set(user.toLowerCase(), pass.replace(/^\{PLAIN\}/, ''));
  }
  return users;
}

const lmtp = nodemailer.createTransport({ host: '127.0.0.1', port: 12024, lmtp: true, ignoreTLS: true });

const server = new SMTPServer({
  name: 'smtp.tidings.test',
  banner: 'Tidings dev SMTP (local delivery only)',
  authMethods: ['PLAIN', 'LOGIN'],
  allowInsecureAuth: true,
  disabledCommands: ['STARTTLS'],
  size: 30 * 1024 * 1024,
  authOptional: true, // Dovecot's vacation/redirect submissions arrive unauthenticated from loopback
  onConnect(session, cb) {
    const ip = session.remoteAddress.replace(/^::ffff:/, '');
    if (ip !== '127.0.0.1' && ip !== '::1') return cb(new Error('loopback only'));
    cb();
  },
  onAuth(auth, _session, cb) {
    const users = loadUsers();
    const ok = users.get(String(auth.username).toLowerCase()) === auth.password;
    if (!ok) return cb(new Error('Invalid username or password'));
    cb(null, { user: String(auth.username).toLowerCase() });
  },
  onMailFrom(address, session, cb) {
    // Authenticated users may only use their own envelope sender (like reject_sender_login_mismatch).
    if (session.user && address.address.toLowerCase() !== session.user) {
      return cb(Object.assign(new Error(`Sender ${address.address} not owned by ${session.user}`), { responseCode: 553 }));
    }
    cb();
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', async () => {
      if (stream.sizeExceeded) return cb(Object.assign(new Error('Message too large'), { responseCode: 552 }));
      const raw = Buffer.concat(chunks);
      const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
      const rcpts = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
      const local = rcpts.filter((r) => r.endsWith(`@${LOCAL_DOMAIN}`));
      const external = rcpts.filter((r) => !r.endsWith(`@${LOCAL_DOMAIN}`));
      try {
        if (local.length) await lmtp.sendMail({ envelope: { from: from || 'mailer-daemon@tidings.test', to: local }, raw });
        if (external.length) {
          const file = join(OUT, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}.eml`);
          writeFileSync(file, Buffer.concat([Buffer.from(`X-Tidings-Dev-Envelope-To: ${external.join(', ')}\r\n`), raw]));
        }
        console.log(
          `[smtp] ${new Date().toISOString()} auth=${session.user ?? '-'} from=<${from}> local=${local.join(',') || '-'} captured=${external.join(',') || '-'} size=${raw.length}`,
        );
        cb();
      } catch (err) {
        console.error('[smtp] delivery failed', err.message);
        cb(Object.assign(new Error(`Local delivery failed: ${err.message}`), { responseCode: 451 }));
      }
    });
  },
});

server.on('error', (e) => console.error('[smtp] error', e.message));
server.listen(PORT, '127.0.0.1', () => console.log(`[smtp] listening on 127.0.0.1:${PORT}`));
