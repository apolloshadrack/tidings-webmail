import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, ExternalLink, MailX, Newspaper, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { hueFor, initials, listDate, plural } from '../../lib/format';
import { useUi } from '../../state/ui';

interface Sender {
  email: string;
  name: string;
  total: number;
  unread: number;
  lastDate: number;
  oneClick: number;
  latest?: { mailbox: string; uidValidity: string; uid: number };
}

type UnsubResult = { method: 'one-click'; ok: boolean; status?: number; error?: string; url?: string } | { method: 'mailto'; mailto: string } | { method: 'url'; url: string };

type RowState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; note: string } | { kind: 'error'; note: string } | { kind: 'blocked'; note: string };

export function Avatar({ name, email, size }: { name: string; email: string; size?: 'lg' | 'xl' }) {
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} style={{ ['--h' as string]: hueFor(email) }} aria-hidden="true">
      {initials({ name, address: email })}
    </span>
  );
}

export function SubscriptionsView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['subscriptions'], queryFn: () => api<{ senders: Sender[] }>('/api/subscriptions').then((r) => r.senders) });
  const [state, setState] = useState<Record<string, RowState>>({});
  const [filter, setFilter] = useState('');
  const setRow = (email: string, s: RowState) => setState((prev) => ({ ...prev, [email]: s }));

  const senders = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data ?? []).filter((s) => !f || s.email.includes(f) || s.name.toLowerCase().includes(f));
  }, [q.data, filter]);

  const unsubscribe = async (s: Sender) => {
    if (!s.latest) return;
    setRow(s.email, { kind: 'busy' });
    try {
      const r = await api<UnsubResult>('/api/unsubscribe', { body: s.latest });
      if (r.method === 'one-click' && r.ok) {
        setRow(s.email, { kind: 'done', note: 'Unsubscribed' });
        return;
      }
      if (r.method === 'mailto') {
        window.dispatchEvent(new CustomEvent('tidings:compose', { detail: { mailto: r.mailto } }));
        setRow(s.email, { kind: 'done', note: 'Unsubscribe email ready to send' });
        return;
      }
      const url = r.url;
      if (url) {
        setRow(s.email, { kind: 'idle' });
        useUi.getState().setDialog({
          kind: 'confirm',
          title: `Open ${new URL(url).hostname}?`,
          body: `${s.name || s.email} doesn’t support one-click unsubscribe. Their unsubscribe page will open in a new tab: ${url}`,
          confirm: 'Open page',
          run: () => {
            window.open(url, '_blank', 'noopener,noreferrer');
            setRow(s.email, { kind: 'done', note: 'Finish on their page' });
          },
        });
        return;
      }
      setRow(s.email, { kind: 'error', note: 'The sender didn’t accept the request. Try blocking instead.' });
    } catch (e) {
      setRow(s.email, { kind: 'error', note: (e as Error).message });
    }
  };

  const block = (s: Sender) => {
    useUi.getState().setDialog({
      kind: 'confirm',
      title: `Block ${s.name || s.email}?`,
      body: `Existing and future messages from ${s.email} go to Spam. You can undo this later by moving a message back to your inbox.`,
      confirm: 'Block sender',
      danger: true,
      run: async () => {
        setRow(s.email, { kind: 'busy' });
        try {
          const r = await api<{ moved: number; filter: boolean }>('/api/senders/block', { body: { email: s.email } });
          setRow(s.email, { kind: 'blocked', note: `Blocked${r.moved ? ` · ${plural(r.moved, 'message')} moved to Spam` : ''}` });
          void qc.invalidateQueries({ queryKey: ['list'] });
          void qc.invalidateQueries({ queryKey: ['mailboxes'] });
        } catch (e) {
          setRow(s.email, { kind: 'error', note: (e as Error).message });
        }
      },
    });
  };

  return (
    <div className="page">
      <div className="s-page-head">
        <div>
          <h2>Subscriptions</h2>
          <p className="hint">Newsletters and mailing lists that sent you mail. Unsubscribing asks the sender to stop; it doesn’t delete what you already have.</p>
        </div>
        {(q.data?.length ?? 0) > 8 && (
          <label className="search s-page-search">
            <Search size={15} aria-hidden="true" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter senders" aria-label="Filter senders" />
          </label>
        )}
      </div>

      {q.isLoading && (
        <div aria-busy="true" aria-label="Loading subscriptions">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 48, marginTop: 10 }} />
          ))}
        </div>
      )}
      {q.error && <div className="s-error" role="alert">{(q.error as Error).message}</div>}
      {q.data && q.data.length === 0 && (
        <div className="s-empty">
          <Newspaper size={28} aria-hidden="true" />
          <h3>No subscriptions found</h3>
          <p className="hint">Messages with an unsubscribe header show up here as they’re indexed.</p>
        </div>
      )}
      {senders.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Sender</th>
              <th scope="col" className="num">
                Messages
              </th>
              <th scope="col">Last received</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {senders.map((s) => {
              const st = state[s.email] ?? { kind: 'idle' };
              const finished = st.kind === 'done' || st.kind === 'blocked';
              return (
                <tr key={s.email}>
                  <td>
                    <div className="s-sender">
                      <Avatar name={s.name} email={s.email} />
                      <div className="s-min">
                        <b className="s-ellipsis">{s.name || s.email}</b>
                        <small className="hint s-ellipsis">{s.email}</small>
                      </div>
                    </div>
                  </td>
                  <td className="num">
                    {s.total}
                    {s.unread > 0 && <span className="hint"> · {s.unread} unread</span>}
                  </td>
                  <td className="num hint">{listDate(s.lastDate)}</td>
                  <td>
                    <div className="s-row-actions s-end">
                      {st.kind === 'error' && (
                        <span className="s-inline-err" role="alert">
                          {st.note}
                        </span>
                      )}
                      {finished && (
                        <span className="s-ok" role="status">
                          <Check size={14} aria-hidden="true" /> {st.note}
                        </span>
                      )}
                      <button type="button" className="btn sm ghost" onClick={() => useUi.getState().setView({ kind: 'search', q: `from:${s.email}` })}>
                        View emails
                      </button>
                      {!finished && (
                        <>
                          <button type="button" className="btn sm" disabled={st.kind === 'busy' || !s.latest} onClick={() => void unsubscribe(s)} title={s.oneClick ? 'Supports one-click unsubscribe' : 'Opens the sender’s unsubscribe page or email'}>
                            {s.oneClick ? <MailX size={14} aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
                            {st.kind === 'busy' ? 'Working…' : 'Unsubscribe'}
                          </button>
                          <button type="button" className="icon-btn sm" aria-label={`Block ${s.name || s.email}`} title="Block sender" disabled={st.kind === 'busy'} onClick={() => block(s)}>
                            <Ban size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {q.data && q.data.length > 0 && senders.length === 0 && <p className="hint">No senders match “{filter}”.</p>}
    </div>
  );
}
