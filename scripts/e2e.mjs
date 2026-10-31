// End-to-end API test against a running Tidings server + the dev mail stack.
//   npm run mail:reset && npm run dev   (in another terminal)
//   npm run test:e2e
// Uses only the local test accounts; the dev SMTP cannot deliver outside tidings.test.
const B = process.env.TIDINGS_E2E_URL ?? 'http://127.0.0.1:5300';
const ORIGIN = process.env.TIDINGS_E2E_ORIGIN ?? 'http://localhost:5304';
let cookie = '';
let csrf = '';
let passed = 0;
let failed = 0;

async function call(path, { method, body, headers = {} } = {}) {
  const m = method ?? (body ? 'POST' : 'GET');
  const h = { Origin: ORIGIN, ...headers };
  if (cookie) h.Cookie = cookie;
  if (m !== 'GET' && csrf && !('X-Tidings-CSRF' in headers)) h['X-Tidings-CSRF'] = csrf;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const r = await fetch(B + path, { method: m, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('tidings_session=')) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const enc = encodeURIComponent;

console.log('\nAuth');
let r = await call('/api/session', { body: { username: 'alice', password: 'wrong-password' } });
check('wrong password is rejected with a generic message', r.status === 401 && r.data.error === 'Wrong email or password.');
r = await call('/api/session', { body: { username: 'alice', password: 'tidings-dev' }, headers: { Origin: 'https://evil.example' } });
check('cross-origin login is refused', r.status === 403);
r = await call('/api/session', { body: { username: 'alice', password: 'tidings-dev' } });
check('login succeeds', r.status === 200 && !!r.data.csrf);
csrf = r.data.csrf;
check('session cookie is HttpOnly + SameSite=Lax', /HttpOnly/i.test(r.headers.get('set-cookie') ?? '') && /SameSite=Lax/i.test(r.headers.get('set-cookie') ?? ''));
await new Promise((res) => setTimeout(res, 2500));

console.log('\nIndex & lists');
r = await call('/api/mailboxes');
const boxes = r.data.mailboxes;
check('special-use folders detected', ['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk'].every((role) => boxes.some((b) => b.role === role)));
r = await call('/api/list?mailbox=INBOX&threads=1&limit=60');
const items = r.data.items;
check('inbox lists conversations', items.length > 5);
const thread = items.find((i) => i.subject.includes('Q4 roadmap'));
check('roadmap conversation groups 6+ messages incl. Sent', thread && thread.count >= 6);
r = await call(`/api/thread?threadId=${enc(thread.threadId)}&mailbox=INBOX`);
check('thread spans Inbox and Sent', new Set(r.data.messages.map((m) => m.mailbox)).size >= 2);
r = await call(`/api/list?mailbox=${enc('Projects/2025 Archive')}&threads=1&limit=60`);
check('2,500-message folder returns a first page', r.data.items.length === 60 && !!r.data.nextCursor);
r = await call(`/api/list?q=${enc('has:attachment')}`);
check('search operator has:attachment', r.data.items.length >= 3 && r.data.items.every((i) => i.hasAttachments));
r = await call(`/api/list?q=${enc('from:bob is:unread')}`);
check('combined operators', r.data.items.every((i) => i.from.address.includes('bob')));
r = await call('/api/list?mailbox=INBOX&filter=is:newsletter&threads=1');
check('split-inbox filter keeps conversations', r.data.threads === true && r.data.items.every((i) => i.newsletter));

console.log('\nSecurity');
const fixture = items.find((i) => i.subject.includes('Dangerous attachments'));
if (fixture) {
  const m = (await call(`/api/message?mailbox=INBOX&uidValidity=${fixture.uidValidity}&uid=${fixture.uid}`)).data;
  for (const a of m.attachments) {
    const p = await call(`/api/message/part?mailbox=INBOX&uidValidity=${fixture.uidValidity}&uid=${fixture.uid}&part=${a.part}&inline=1`);
    const inline = /^inline/.test(p.headers.get('content-disposition') ?? '');
    const ok = p.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(p.headers.get('content-security-policy') ?? '') && (!inline || /^image\/(png|jpeg|gif|webp)$/.test(p.headers.get('content-type') ?? ''));
    check(`attachment ${a.filename} served safely (${inline ? 'inline image' : 'download'})`, ok);
    check(`attachment ${a.filename} has no bidi/path characters`, !/[‪-‮⁦-⁩/\\]/.test(a.filename));
  }
}
const one = items[0];
const tgt = { mailbox: 'INBOX', uidValidity: one.uidValidity, uids: one.uids };
r = await call('/api/actions/flags', { body: { targets: [tgt], add: ['\\Flagged'], remove: [] }, headers: { 'X-Tidings-CSRF': 'forged' } });
check('mutation with a forged CSRF token is refused', r.status === 403);
r = await call('/api/actions/flags', { body: JSON.stringify({ targets: [tgt], add: ['\\Flagged'], remove: [] }), headers: { 'Content-Type': 'text/plain' } });
check('text/plain mutation is refused', r.status === 415 || r.status === 400);
r = await call('/api/actions/flags', { body: { targets: [{ ...tgt, uidValidity: '1' }], add: ['\\Seen'], remove: [] } });
check('stale UIDVALIDITY returns 409', r.status === 409 && r.data.code === 'UIDVALIDITY_CHANGED');
r = await call('/api/proxy/sign', { body: { urls: ['http://127.0.0.1:5300/healthz', 'http://169.254.169.254/latest/meta-data/'] } });
for (const u of Object.values(r.data.urls)) {
  const p = await call(u.replace(/^\/?/, '/').replace(/^\/webmail/, ''));
  check(`image proxy refuses internal target`, p.status === 404);
}
r = await call(`/api/message/part?mailbox=INBOX&uidValidity=${one.uidValidity}&uid=${one.uid}&part=..%2F1`);
check('malformed part path rejected', r.status >= 400);

r = await call('/api/proxy/sign', { body: { urls: ['http://[::127.0.0.1]/'] } });
for (const u of Object.values(r.data.urls)) {
  const p = await call(u);
  check('image proxy refuses IPv4-compatible IPv6 and leaks no error detail', p.status === 404 && !String(p.data).includes('EHOST'));
}
r = await call('/api/actions/flags', { body: { targets: [tgt], add: ['\\Deleted'], remove: [] } });
check('\\Deleted cannot be set outside Trash/Spam/Drafts', r.status === 400);

console.log('\nSearch');
r = await call(`/api/list?q=${enc('subject:roadmap')}`);
check('search results are grouped into conversations', r.data.threads === true && r.data.items.filter((i) => i.subject.includes('roadmap')).length === 1);
r = await call(`/api/list?q=${enc('in:travel')}`);
check('in: matches folders case-insensitively', r.data.items.length >= 1);
r = await call(`/api/list?q=${enc('older_than:1d in:anywhere')}`);
check('older_than: operator', r.data.items.length > 0 && r.data.items.every((i) => i.date < Date.now() - 86_400_000));

console.log('\nActions');
r = await call('/api/actions/move', { body: { targets: [{ mailbox: 'INBOX', uidValidity: one.uidValidity, uids: [one.uid] }], role: 'archive' } });
const res = r.data.results?.[0];
check('archive returns a UID map for undo', r.status === 200 && res && res.uidMap[one.uid]);
r = await call('/api/actions/move', { body: { targets: [{ mailbox: res.destination, uidValidity: res.uidValidity, uids: [res.uidMap[one.uid]] }], to: 'INBOX' } });
check('undo archive moves it back', r.status === 200);

const snoozeTarget = (await call('/api/list?mailbox=INBOX&threads=0&limit=3')).data.items[2];
r = await call('/api/snooze', { body: { mailbox: 'INBOX', uidValidity: snoozeTarget.uidValidity, uids: [snoozeTarget.uid], until: Date.now() + 86_400_000 } });
check('snooze moves the message away', r.status === 200 && r.data.messageIds.length === 1);
r = await call('/api/snooze/cancel', { body: { messageIds: r.data.messageIds } });
check('undo snooze brings it back', r.status === 200 && r.data.moved === 1);
r = await call(`/api/list?q=${enc(`in:inbox subject:"${snoozeTarget.subject.slice(0, 20)}"`)}`);
check('snoozed message is back in the Inbox', r.data.items.length >= 1);
r = await call(`/api/mailboxes/export?path=Travel`);
check('folder exports as mbox', r.status === 200 && String(r.data).startsWith('From ') && /mbox/.test(r.headers.get('content-type') ?? ''));

console.log('\nSending');
const draftId = crypto.randomUUID();
r = await call('/api/send', { body: { draftId, from: 'ceo@tidings.test', to: [{ name: '', address: 'bob@tidings.test' }], subject: 'spoof', text: 'x', delaySeconds: 0 } });
check('sending as an address outside the identity policy is refused', r.status >= 400);
r = await call('/api/send', { body: { draftId, from: 'alice@tidings.test', to: [{ name: 'Bob\r\nBcc: evil@example.com', address: 'bob@tidings.test' }], subject: 'E2E\r\nBcc: evil@example.com', text: 'hello from e2e', delaySeconds: 0 } });
check('send is queued', r.status === 200 && r.data.id);
await new Promise((res2) => setTimeout(res2, 2500));
r = await call('/api/outbox');
const sent = r.data.items.find((i) => i.draftId === draftId);
check('message delivered', sent?.state === 'sent', JSON.stringify(sent));
check('header injection neutralised in subject', sent && !/\r|\n/.test(sent.subject));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
