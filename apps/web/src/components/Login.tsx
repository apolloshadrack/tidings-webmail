import { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { ApiError, api, setCsrf } from '../api/client';
import type { ServerConfig } from '../api/types';
import { queryClient } from '../state/queries';
import { BrandMark } from './Brand';

export function Login({ config }: { config?: ServerConfig }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [publicComputer, setPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = config?.brand.name ?? 'Tidings';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ csrf: string }>('/api/session', { body: { username, password, publicComputer } });
      setCsrf(r.csrf);
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-form" onSubmit={submit} noValidate>
        <div className="brand" style={{ padding: 0 }}>
          {config?.brand.logoUrl ? <img src={config.brand.logoUrl} alt="" height={32} /> : <BrandMark size={34} />}
          <span className="brand-name" style={{ fontSize: 18 }}>{name}</span>
        </div>
        <div>
          <h1>Sign in to your mail</h1>
          <p className="sub">{config?.brand.loginMessage ?? 'Use the email address and password of your mailbox.'}</p>
        </div>
        {error && (
          <div className="login-error" role="alert">
            <AlertCircle size={16} /> {error}
          </div>
        )}
        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="text"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={config?.defaultDomain ? `you@${config.defaultDomain}` : 'you@example.com'}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={publicComputer} onChange={(e) => setPublic(e.target.checked)} />
          This is a public or shared computer <span className="hint">(sign out after 30 minutes idle)</span>
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : null}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="login-foot">
          {config?.brand.supportUrl && (
            <a href={config.brand.supportUrl} target="_blank" rel="noopener noreferrer">
              Trouble signing in?
            </a>
          )}
          <a href={config?.sourceUrl ?? '#'} target="_blank" rel="noopener noreferrer">
            Open source · AGPL-3.0
          </a>
          {config?.demo && <span>Demo: alice@tidings.test / tidings-dev</span>}
        </div>
      </form>
      <div className="login-art" aria-hidden="true">
        <Horizon />
      </div>
    </div>
  );
}

/** A calm generated landscape that follows the theme tokens. */
export function Horizon({ compact = false }: { compact?: boolean }) {
  return (
    <svg viewBox="0 0 800 600" preserveAspectRatio={compact ? 'xMidYMid meet' : 'xMidYMid slice'}>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--sunken)" />
          <stop offset="1" stopColor="color-mix(in oklab, var(--accent) 16%, var(--sunken))" />
        </linearGradient>
        <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="color-mix(in oklab, var(--accent) 70%, var(--surface))" />
          <stop offset="1" stopColor="color-mix(in oklab, var(--accent) 35%, var(--surface))" />
        </radialGradient>
      </defs>
      <rect width="800" height="600" fill="url(#sky)" />
      <circle cx="520" cy="330" r="92" fill="url(#sun)" opacity=".9" />
      <path d="M0 380 C120 330 210 350 300 372 S470 330 560 352 690 392 800 360 V600 H0Z" fill="color-mix(in oklab, var(--accent) 22%, var(--surface))" />
      <path d="M0 430 C140 398 250 420 360 440 S560 406 660 428 760 452 800 440 V600 H0Z" fill="color-mix(in oklab, var(--accent) 34%, var(--surface))" />
      <path d="M0 492 C160 470 300 488 420 500 S640 476 800 494 V600 H0Z" fill="color-mix(in oklab, var(--accent) 52%, var(--surface))" />
      <g stroke="var(--surface)" strokeWidth="2.5" strokeLinecap="round" opacity=".7" fill="none">
        <path d="M236 210 q10 -8 20 0 q10 -8 20 0" />
        <path d="M300 182 q7 -6 14 0 q7 -6 14 0" />
      </g>
    </svg>
  );
}
