import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ComposeState, OutboxItem } from '../../api/types';
import { relative } from '../../lib/format';
import { useOutbox } from '../../state/queries';

function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return <span className="num">{s > 0 ? `Sending in ${s} s` : 'Sending…'}</span>;
}

function StateLine({ item }: { item: OutboxItem }) {
  switch (item.state) {
    case 'queued':
      return (
        <span className="s-state">
          <Clock size={14} aria-hidden="true" /> <Countdown at={item.sendAt} />
        </span>
      );
    case 'sending':
      return (
        <span className="s-state">
          <Loader2 size={14} className="s-spin" aria-hidden="true" /> Sending…
        </span>
      );
    case 'sent':
      return (
        <span className="s-state s-ok">
          <CheckCircle2 size={14} aria-hidden="true" /> Sent {relative(item.createdAt)}
          {item.error ? ` · ${item.error}` : ''}
        </span>
      );
    case 'failed':
      return (
        <span className="s-state s-bad">
          <AlertTriangle size={14} aria-hidden="true" /> Not sent. {item.error ?? 'The mail server refused it.'}
        </span>
      );
    case 'stalled':
      return (
        <span className="s-state s-warnc">
          <AlertTriangle size={14} aria-hidden="true" /> Was waiting to send when the server restarted. Nothing was sent.
        </span>
      );
    case 'unknown':
      return (
        <span className="s-state s-warnc">
          <AlertTriangle size={14} aria-hidden="true" /> May have been sent before the server restarted. Check Sent before trying again.
        </span>
      );
  }
}

export function OutboxView() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useOutbox();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['outbox'] });
    }
  };

  const sendNow = (it: OutboxItem) => run(it.id, () => api(`/api/outbox/${it.id}/send`, { body: {} }).then(() => undefined));
  const edit = (it: OutboxItem) =>
    run(it.id, async () => {
      const r = await api<{ compose: ComposeState }>(`/api/outbox/${it.id}/cancel`, { body: {} });
      window.dispatchEvent(new CustomEvent('tidings:compose', { detail: { state: r.compose } }));
    });
  const discard = (it: OutboxItem) => run(it.id, () => api(`/api/outbox/${it.id}`, { method: 'DELETE' }).then(() => undefined));

  const pending = (data ?? []).filter((i) => i.state !== 'sent');
  const sent = (data ?? []).filter((i) => i.state === 'sent');

  const renderItem = (it: OutboxItem) => (
    <li key={it.id} className="card s-outbox-item">
      <div className="s-min grow">
        <b className="s-ellipsis">{it.subject || '(no subject)'}</b>
        <small className="hint s-ellipsis">To {it.to.join(', ') || '—'}</small>
        <StateLine item={it} />
      </div>
      <div className="s-row-actions">
        {(it.state === 'queued' || it.state === 'stalled' || it.state === 'failed') && (
          <button type="button" className="btn sm primary" disabled={busy === it.id} onClick={() => void sendNow(it)}>
            <Send size={14} aria-hidden="true" /> Send now
          </button>
        )}
        {(it.state === 'queued' || it.state === 'stalled' || it.state === 'failed' || it.state === 'unknown') && (
          <button type="button" className="btn sm" disabled={busy === it.id} onClick={() => void edit(it)}>
            {it.state === 'queued' ? 'Cancel and edit' : 'Edit'}
          </button>
        )}
        {(it.state === 'stalled' || it.state === 'failed' || it.state === 'unknown') && (
          <button type="button" className="btn sm ghost" disabled={busy === it.id} onClick={() => void discard(it)}>
            Discard
          </button>
        )}
      </div>
    </li>
  );

  return (
    <div className="page">
      <div className="s-page-head">
        <div>
          <h2>Outbox</h2>
          <p className="hint">Messages waiting out the undo-send delay, and anything that couldn’t be sent.</p>
        </div>
      </div>
      {err && (
        <div className="s-error" role="alert">
          {err}
        </div>
      )}
      {error && (
        <div className="s-error" role="alert">
          {(error as Error).message}
        </div>
      )}
      {isLoading && (
        <div aria-busy="true" aria-label="Loading outbox">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton" style={{ height: 64, marginTop: 10 }} />
          ))}
        </div>
      )}
      {data && pending.length === 0 && (
        <div className="s-empty">
          <CheckCircle2 size={28} aria-hidden="true" />
          <h3>Nothing waiting to send</h3>
          <p className="hint">Everything you sent has left.</p>
        </div>
      )}
      {pending.length > 0 && <ul className="s-list">{pending.map(renderItem)}</ul>}
      {sent.length > 0 && (
        <>
          <h3 className="s-subhead">Sent in the last day</h3>
          <ul className="s-list">{sent.map(renderItem)}</ul>
        </>
      )}
    </div>
  );
}
