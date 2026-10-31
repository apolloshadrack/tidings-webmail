import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

/**
 * All configuration comes from TIDINGS_* environment variables. Any secret may instead be given as
 * TIDINGS_<NAME>_FILE pointing at a file (Docker / Kubernetes secrets).
 */

export type TlsMode = 'tls' | 'starttls' | 'none';

export interface Endpoint {
  host: string;
  port: number;
  tls: TlsMode;
  servername?: string;
}

export interface Branding {
  name: string;
  accent?: string;
  logoUrl?: string;
  loginMessage?: string;
  supportUrl?: string;
  customCss?: string;
}

export interface Config {
  port: number;
  bind: string;
  publicUrl: URL;
  basePath: string; // "" or "/webmail"
  dataDir: string;
  secret: Buffer;
  secretPrevious?: Buffer;
  imap: Endpoint;
  smtp: Endpoint;
  sieve?: Endpoint;
  tlsInsecure: boolean;
  caFile?: string;
  trustedProxies: string[];
  defaultDomain?: string;
  identityPolicy: 'login-only' | 'aliases' | 'free';
  aliases: Record<string, string[]>; // login -> allowed extra From addresses
  saveSent: 'auto' | 'append' | 'never';
  sessionIdleMinutes: number;
  sessionMaxDays: number;
  maxUploadMb: number;
  maxRecipientsPerMessage: number;
  maxMessagesPerDay: number;
  egressAllowPrivate: boolean;
  trustedAuthservIds: string[];
  logLevel: string;
  sourceUrl: string;
  branding: Branding;
  demo: boolean;
}

const KNOWN_WEAK = new Set(['changeme', 'secret', 'please-change-me', 'replace-me']);

function env(name: string): string | undefined {
  const direct = process.env[`TIDINGS_${name}`];
  if (direct !== undefined && direct !== '') return direct;
  const file = process.env[`TIDINGS_${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return undefined;
}

function int(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`TIDINGS_${name} must be a non-negative integer`);
  return n;
}

function bool(name: string, fallback = false): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const DEFAULT_PORTS: Record<string, number> = {
  imaps: 993, imap: 143, smtps: 465, smtp: 587, sieve: 4190,
};

export function isLoopback(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1';
  return false;
}

/** Parse `imaps://host:993`, `imap://host:143`, `smtp://host:587`, `smtps://host:465`, `sieve://host:4190`. */
export function parseEndpoint(raw: string, kind: 'imap' | 'smtp' | 'sieve', label: string): Endpoint {
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `${kind}://${raw}`);
  } catch {
    throw new Error(`${label}: cannot parse "${raw}" as a URL like ${kind}s://mail.example.com`);
  }
  const scheme = url.protocol.replace(':', '');
  const allowed = kind === 'sieve' ? ['sieve'] : [kind, `${kind}s`];
  if (!allowed.includes(scheme)) throw new Error(`${label}: scheme must be one of ${allowed.join(', ')}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];
  let tls: TlsMode = scheme.endsWith('s') && scheme !== 'sieve' ? 'tls' : 'starttls';
  const q = url.searchParams.get('tls');
  if (q === 'none' || q === 'off') {
    if (!isLoopback(host)) {
      throw new Error(`${label}: plaintext (tls=none) is only allowed for loopback hosts, not "${host}"`);
    }
    tls = 'none';
  } else if (q === 'starttls' || q === 'tls') {
    tls = q;
  }
  const servername = url.searchParams.get('servername') ?? undefined;
  return { host, port, tls, servername };
}

function parseAliases(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  // Format: "alice@example.com=sales@example.com|info@example.com;bob@example.com=b@example.com"
  const out: Record<string, string[]> = {};
  for (const entry of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [login, list] = entry.split('=');
    if (!login || !list) continue;
    out[login.trim().toLowerCase()] = list.split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return out;
}

export function loadConfig(): Config {
  const demo = bool('DEMO');
  let secretRaw = env('SECRET');
  if (!secretRaw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TIDINGS_SECRET is required (at least 32 characters). Generate one with: openssl rand -base64 48');
    }
    secretRaw = 'dev-only-insecure-secret-do-not-use-in-production-0123456789';
    console.warn('[tidings] WARNING: TIDINGS_SECRET not set; using an insecure development secret.');
  }
  if (secretRaw.length < 32 || KNOWN_WEAK.has(secretRaw)) {
    throw new Error('TIDINGS_SECRET must be at least 32 characters and not an example value');
  }
  const prev = env('SECRET_PREVIOUS');

  const publicUrl = new URL(env('PUBLIC_URL') ?? `http://localhost:${int('PORT', 5300)}/`);
  if (!publicUrl.pathname.endsWith('/')) publicUrl.pathname += '/';
  const basePath = publicUrl.pathname.replace(/\/$/, '');

  const imapRaw = env('IMAP_URL');
  const smtpRaw = env('SMTP_URL');
  if (!imapRaw) throw new Error('TIDINGS_IMAP_URL is required, e.g. imaps://mail.example.com:993');
  if (!smtpRaw) throw new Error('TIDINGS_SMTP_URL is required, e.g. smtp://mail.example.com:587');
  const sieveRaw = env('SIEVE_URL');

  const tlsInsecure = bool('TLS_INSECURE');
  if (tlsInsecure) {
    console.warn('[tidings] WARNING: TIDINGS_TLS_INSECURE=true — TLS certificates of the mail server are NOT verified.');
  }

  const policy = (env('IDENTITY_POLICY') ?? 'login-only') as Config['identityPolicy'];
  if (!['login-only', 'aliases', 'free'].includes(policy)) {
    throw new Error('TIDINGS_IDENTITY_POLICY must be login-only, aliases or free');
  }
  const saveSent = (env('SAVE_SENT') ?? 'auto') as Config['saveSent'];

  return {
    port: int('PORT', 5300),
    bind: env('BIND') ?? '0.0.0.0',
    publicUrl,
    basePath,
    dataDir: resolve(env('DATA_DIR') ?? './data'),
    secret: Buffer.from(secretRaw, 'utf8'),
    secretPrevious: prev ? Buffer.from(prev, 'utf8') : undefined,
    imap: parseEndpoint(imapRaw, 'imap', 'TIDINGS_IMAP_URL'),
    smtp: parseEndpoint(smtpRaw, 'smtp', 'TIDINGS_SMTP_URL'),
    sieve: sieveRaw ? parseEndpoint(sieveRaw, 'sieve', 'TIDINGS_SIEVE_URL') : undefined,
    tlsInsecure,
    caFile: env('CA_FILE'),
    trustedProxies: (env('TRUSTED_PROXIES') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    defaultDomain: env('DEFAULT_DOMAIN')?.toLowerCase(),
    identityPolicy: policy,
    aliases: parseAliases(env('ALIASES')),
    saveSent,
    sessionIdleMinutes: int('SESSION_IDLE_MINUTES', 60 * 24),
    sessionMaxDays: int('SESSION_MAX_DAYS', 14),
    maxUploadMb: int('MAX_UPLOAD_MB', 25),
    maxRecipientsPerMessage: int('MAX_RECIPIENTS', 100),
    maxMessagesPerDay: int('MAX_MESSAGES_PER_DAY', 500),
    egressAllowPrivate: bool('EGRESS_ALLOW_PRIVATE'),
    trustedAuthservIds: (env('TRUSTED_AUTHSERV_IDS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    logLevel: env('LOG_LEVEL') ?? 'info',
    sourceUrl: env('SOURCE_URL') ?? 'https://github.com/apolloshadrack/tidings-webmail',
    branding: {
      name: env('BRAND_NAME') ?? 'Tidings',
      accent: env('BRAND_ACCENT'),
      logoUrl: env('BRAND_LOGO_URL'),
      loginMessage: env('BRAND_LOGIN_MESSAGE'),
      supportUrl: env('BRAND_SUPPORT_URL'),
      customCss: env('CUSTOM_CSS_FILE') ? readFileSync(env('CUSTOM_CSS_FILE')!, 'utf8') : undefined,
    },
    demo,
  };
}
