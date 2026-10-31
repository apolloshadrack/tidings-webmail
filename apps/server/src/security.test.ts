import { describe, expect, it } from 'vitest';
import { parseEndpoint } from './config.js';
import { credentialKey, open, seal, sessionIdFor } from './lib/crypto.js';
import { isPublicAddress } from './lib/egress.js';
import { cleanHeaderValue, contentDisposition, decodeTransfer, normalizeSubject, sanitizeFilename, sniffImage } from './lib/mime.js';
import { normalizeAddress } from './mail/outbox.js';
import { renderScript, emptyModel, parseModel } from './mail/sieve.js';
import { ftsQuery, parseSearch } from './http/search.js';
import { uidSet } from './imap/sync.js';

describe('egress address filter', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '224.0.0.1', '198.18.0.1', '192.0.0.8', '::7f00:1', '::a9fe:a9fe', '::c0a8:101', '64:ff9b::7f00:1'])(
    'blocks %s',
    (ip) => expect(isPublicAddress(ip)).toBe(false),
  );
  it.each(['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe('endpoint parsing', () => {
  it('refuses plaintext to a remote host', () => {
    expect(() => parseEndpoint('imap://mail.example.com:143?tls=none', 'imap', 'X')).toThrow(/loopback/);
  });
  it('defaults imap:// to STARTTLS and imaps:// to TLS', () => {
    expect(parseEndpoint('imap://mail.example.com', 'imap', 'X')).toMatchObject({ tls: 'starttls', port: 143 });
    expect(parseEndpoint('imaps://mail.example.com', 'imap', 'X')).toMatchObject({ tls: 'tls', port: 993 });
    expect(parseEndpoint('smtp://mail.example.com', 'smtp', 'X')).toMatchObject({ tls: 'starttls', port: 587 });
  });
  it('allows plaintext on loopback', () => {
    expect(parseEndpoint('imap://127.0.0.1:1143?tls=none', 'imap', 'X')).toMatchObject({ tls: 'none', port: 1143 });
  });
});

describe('credential sealing', () => {
  const secret = Buffer.from('x'.repeat(48));
  it('round-trips and is bound to the row', () => {
    const token = 'tok';
    const sid = sessionIdFor(secret, token);
    const key = credentialKey(secret, token, sid);
    const sealed = seal(key, Buffer.from('hunter2'), `${sid}|u|v1`);
    expect(open(key, sealed, `${sid}|u|v1`).toString()).toBe('hunter2');
    expect(() => open(key, sealed, `other|u|v1`)).toThrow();
    const wrongKey = credentialKey(secret, 'other-token', sid);
    expect(() => open(wrongKey, sealed, `${sid}|u|v1`)).toThrow();
  });
});

describe('header & filename hygiene', () => {
  it('strips CRLF and bidi controls from header values', () => {
    expect(cleanHeaderValue('hi\r\nBcc: evil@x')).toBe('hi  Bcc: evil@x');
    expect(cleanHeaderValue('invoice‮fdp.exe')).not.toMatch(/‮/);
  });
  it('sanitizes filenames', () => {
    expect(sanitizeFilename('../../etc/passwd', 'f')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('report‮fdp.exe', 'f')).toBe('report_fdp.exe');
    expect(sanitizeFilename("utf-8''%E2%82%AC%20rates.pdf", 'f')).toBe('€ rates.pdf');
    expect(sanitizeFilename('', 'fallback.bin')).toBe('fallback.bin');
  });
  it('emits an ASCII-safe Content-Disposition', () => {
    expect(contentDisposition('attachment', 'naïve "x".pdf')).toBe(`attachment; filename="na_ve _x_.pdf"; filename*=UTF-8''na%C3%AFve%20%22x%22.pdf`);
  });
});

describe('image sniffing', () => {
  it('only accepts raster magic bytes', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
  });
});

describe('transfer decoding', () => {
  it('handles truncated base64 and QP', () => {
    expect(decodeTransfer(Buffer.from('aGVsbG8gd29y'), 'base64').toString()).toBe('hello wor');
    expect(decodeTransfer(Buffer.from('aGVsbG8gd2'), 'base64').toString()).toBe('hello ');
    expect(decodeTransfer(Buffer.from('caf=C3=A9 =\r\nau lait=E'), 'quoted-printable').toString()).toBe('café au lait');
  });
});

describe('addresses', () => {
  it('normalizes and rejects tricks', () => {
    expect(normalizeAddress('Alice@Example.COM')).toBe('Alice@example.com');
    expect(normalizeAddress('user@bücher.example')).toBe('user@xn--bcher-kva.example');
    expect(() => normalizeAddress('a@b@c')).toThrow();
    expect(() => normalizeAddress('"x"@example.com')).toThrow();
    expect(() => normalizeAddress('evil@example.com\r\nBcc: x@y.z')).toThrow();
    expect(() => normalizeAddress('nodomain@')).toThrow();
  });
});

describe('subjects & threading helpers', () => {
  it('normalizes reply prefixes', () => {
    expect(normalizeSubject('Re: RE: Fwd: AW: [list] Hello')).toBe('hello');
  });
  it('compresses uid sets', () => {
    expect(uidSet([5, 1, 2, 3, 9, 10, 7])).toBe('1:3,5,7,9:10');
  });
});

describe('search parsing', () => {
  it('builds operator filters and fts', () => {
    const p = parseSearch('from:bob has:attachment is:unread budget "q3 plan"', new Map());
    expect(p.where).toEqual(expect.arrayContaining(['m.has_attachments = 1', 'm.seen = 0']));
    expect(p.freeText).toEqual(['budget', 'q3 plan']);
    expect(ftsQuery(p.freeText)).toBe('"budget"* AND "q3 plan"');
  });
  it('neutralises fts syntax', () => {
    expect(ftsQuery(['a"b*', 'NEAR(x'])).toBe('"a b" AND "NEAR x"');
  });
});

describe('sieve rendering', () => {
  it('round-trips the model and escapes values', () => {
    const m = emptyModel();
    m.rules.push({
      id: '1', name: 'x', enabled: true, match: 'any',
      conditions: [{ field: 'subject', op: 'contains', value: 'a"b\\c' }],
      actions: [{ type: 'move', value: 'Lists/News' }],
    });
    m.vacation = { enabled: true, subject: 'Away', body: 'Back monday\n.\nreally', days: 3, addresses: [] };
    const s = renderScript(m, ['fileinto', 'vacation', 'imap4flags']);
    expect(s).toContain('header :contains "Subject" "a\\"b\\\\c"');
    expect(s).toContain('\r\n..\r\n'); // dot-stuffed multiline
    expect(parseModel(s)).toEqual(m);
  });
  it('refuses unsupported extensions instead of writing a broken script', () => {
    const m = emptyModel();
    m.rules.push({ id: '1', name: 'x', enabled: true, match: 'any', conditions: [{ field: 'from', op: 'is', value: 'a@b.c' }], actions: [{ type: 'move', value: 'X' }] });
    expect(() => renderScript(m, [])).toThrow(/fileinto/);
  });
});
