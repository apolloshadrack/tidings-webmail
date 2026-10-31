import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const b64url = (buf: Buffer) => buf.toString('base64url');

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function hmac(key: Buffer, ...parts: (string | Buffer)[]): Buffer {
  const h = createHmac('sha256', key);
  for (const p of parts) {
    h.update(p);
    h.update('\0');
  }
  return h.digest();
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Session id stored in the DB: the cookie token itself is never persisted. */
export function sessionIdFor(secret: Buffer, token: string): string {
  return hmac(secret, token, 'sid').toString('hex');
}

/**
 * Credential key: HKDF over the cookie token (which only the browser holds), salted with a value
 * derived from the server secret, bound to the session id. Needs BOTH the DB row and the cookie.
 */
export function credentialKey(secret: Buffer, token: string, sid: string, purpose = 'cred'): Buffer {
  const salt = hmac(secret, 'tidings-cred-salt');
  return Buffer.from(hkdfSync('sha256', Buffer.from(token), salt, Buffer.from(`tidings-${purpose}-v1|${sid}`), 32));
}

export interface Sealed {
  nonce: Buffer;
  ct: Buffer;
  tag: Buffer;
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { nonce, ct, tag: c.getAuthTag() };
}

export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.tag);
  return Buffer.concat([d.update(sealed.ct), d.final()]);
}

/** Stable per-account key: sha256(host:port \0 username). */
export function userKeyFor(host: string, port: number, username: string): string {
  return sha256hex(`${host.toLowerCase()}:${port}\0${username}`);
}
