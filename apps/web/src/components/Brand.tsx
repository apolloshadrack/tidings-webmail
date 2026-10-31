import { hueFor, initials } from '../lib/format';
import type { Address } from '../api/types';

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size, borderRadius: size * 0.3 }} aria-hidden="true">
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 7.5 12 13l8.5-5.5" />
        <path d="M3.5 7v9.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V7" opacity=".55" />
      </svg>
    </span>
  );
}

export function Avatar({ addr, size }: { addr?: Address; size?: 'lg' | 'xl' }) {
  const key = addr?.address ?? '?';
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} style={{ '--h': hueFor(key) } as React.CSSProperties} aria-hidden="true">
      {initials(addr)}
    </span>
  );
}
