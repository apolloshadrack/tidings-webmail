import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import type { LookupFunction } from 'node:net';

/**
 * The ONLY way Tidings fetches attacker-influenced URLs (remote images, one-click unsubscribe).
 * - http/https on 80/443 only
 * - every resolved address is checked; the socket connects to the checked address (no DNS rebinding)
 * - private, loopback, link-local, CGNAT, multicast and reserved ranges are refused
 * - <= 3 redirects, each re-validated; timeouts; size cap; no cookies, auth or referrer
 */

const BLOCKED_RANGES = new Set([
  'unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'reserved',
  'carrierGradeNat', 'uniqueLocal', 'ipv4Mapped', 'rfc6145', 'rfc6052', '6to4', 'teredo',
  'benchmarking', 'amt', 'as112', 'deprecated', 'orchid2', 'droneRemoteIdProtocolEntityTags',
]);

export function isPublicAddress(ip: string): boolean {
  try {
    let addr = ipaddr.parse(ip);
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
    const range = addr.range();
    if (BLOCKED_RANGES.has(range)) return false;
    if (addr.kind() === 'ipv4') {
      const s = addr.toString();
      if (s.startsWith('192.0.0.') || s.startsWith('198.18.') || s.startsWith('198.19.') || s.startsWith('0.')) return false;
    }
    return range === 'unicast';
  } catch {
    return false;
  }
}

export class EgressError extends Error {}

export interface EgressOptions {
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  maxBytes?: number;
  timeoutMs?: number;
  followRedirects?: boolean;
  allowPrivate?: boolean;
  httpsOnly?: boolean;
  accept?: string;
}

export interface EgressResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
}

function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return (callback as (e: Error | null, a?: string, f?: number) => void)(err);
      const list = addresses as dns.LookupAddress[];
      const ok = list.filter((a) => allowPrivate || isPublicAddress(a.address));
      if (!ok.length) {
        return (callback as (e: Error | null) => void)(new EgressError(`refusing to connect to non-public address for ${hostname}`));
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, ok);
      } else {
        (callback as (e: null, a: string, f: number) => void)(null, ok[0].address, ok[0].family);
      }
    });
  };
}

export async function egressFetch(rawUrl: string, opts: EgressOptions = {}): Promise<EgressResponse> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== 'https:' && (opts.httpsOnly || url.protocol !== 'http:')) throw new EgressError('scheme not allowed');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) throw new EgressError('port not allowed');
    if (url.username || url.password) throw new EgressError('credentials in URL not allowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(host) && !opts.allowPrivate && !isPublicAddress(host)) throw new EgressError('non-public address');

    const res = await new Promise<EgressResponse>((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        {
          method: opts.method ?? 'GET',
          lookup: guardedLookup(!!opts.allowPrivate),
          headers: {
            'user-agent': 'Tidings-Webmail-Proxy/1.0',
            accept: opts.accept ?? '*/*',
            ...(opts.body !== undefined ? { 'content-type': opts.contentType ?? 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(opts.body) } : {}),
          },
          timeout: timeoutMs,
        },
        (resp) => {
          const chunks: Buffer[] = [];
          let size = 0;
          resp.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy(new EgressError('response too large'));
              return;
            }
            chunks.push(c);
          });
          resp.on('end', () => resolve({ status: resp.statusCode ?? 0, headers: resp.headers, body: Buffer.concat(chunks), url: url.toString() }));
          resp.on('error', reject);
        },
      );
      const total = setTimeout(() => req.destroy(new EgressError('timeout')), timeoutMs);
      req.on('close', () => clearTimeout(total));
      req.on('timeout', () => req.destroy(new EgressError('timeout')));
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });

    if (opts.followRedirects !== false && res.status >= 300 && res.status < 400 && res.headers.location) {
      url = new URL(res.headers.location, url);
      continue;
    }
    return res;
  }
  throw new EgressError('too many redirects');
}
