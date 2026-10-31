import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '../../api/client';
import { useMailboxes } from '../../state/queries';
import { InlineError, Row, Section, SkeletonRows, ToggleRow } from './controls';

type Field = 'from' | 'to' | 'subject' | 'cc' | 'list-id';
type Op = 'contains' | 'is' | 'not-contains';
type ActionType = 'move' | 'mark-read' | 'star' | 'discard' | 'forward' | 'stop';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: { field: Field; op: Op; value: string }[];
  actions: { type: ActionType; value?: string }[];
}
interface Vacation {
  enabled: boolean;
  subject: string;
  body: string;
  days: number;
  from?: number;
  until?: number;
  addresses: string[];
}
interface SieveState {
  available: boolean;
  extensions?: string[];
  model?: { rules: Rule[]; vacation: Vacation; includes: string[] };
  active?: string | null;
  otherScripts?: string[];
  managedByUs?: boolean;
}

const FIELDS: { value: Field; label: string }[] = [
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'cc', label: 'Cc' },
  { value: 'subject', label: 'Subject' },
  { value: 'list-id', label: 'Mailing list' },
];
const OPS: { value: Op; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'is', label: 'is exactly' },
  { value: 'not-contains', label: 'does not contain' },
];
const ACTIONS: { value: ActionType; label: string }[] = [
  { value: 'move', label: 'Move to folder' },
  { value: 'mark-read', label: 'Mark as read' },
  { value: 'star', label: 'Star it' },
  { value: 'forward', label: 'Forward a copy to' },
  { value: 'discard', label: 'Delete it' },
  { value: 'stop', label: 'Stop processing more rules' },
];

const toDateInput = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const fromDateInput = (s: string) => (s ? Date.parse(`${s}T00:00:00`) : undefined);

function RuleEditor({ rule, onChange, onRemove, folders, index }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void; folders: string[]; index: number }) {
  const id = useId();
  const setCond = (i: number, patch: Partial<Rule['conditions'][number]>) =>
    onChange({ ...rule, conditions: rule.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setAct = (i: number, patch: Partial<Rule['actions'][number]>) => onChange({ ...rule, actions: rule.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  return (
    <fieldset className="card s-rule">
      <legend className="sr-only">Rule {index + 1}</legend>
      <div className="s-rule-head">
        <input id={`${id}-on`} type="checkbox" role="switch" className="switch" checked={rule.enabled} onChange={(e) => onChange({ ...rule, enabled: e.target.checked })} aria-label={`Rule ${rule.name || index + 1} enabled`} />
        <input className="input s-rule-name" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} aria-label="Rule name" placeholder="Rule name" maxLength={200} />
        <button type="button" className="icon-btn sm" onClick={onRemove} aria-label={`Delete rule ${rule.name || index + 1}`}>
          <Trash2 size={15} />
        </button>
      </div>
      <div className="s-rule-line">
        <span>When</span>
        <select className="select input s-auto" value={rule.match} onChange={(e) => onChange({ ...rule, match: e.target.value as Rule['match'] })} aria-label="Match">
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        <span>of these are true:</span>
      </div>
      {rule.conditions.map((c, i) => (
        <div className="s-rule-line" key={i}>
          <select className="select input s-auto" value={c.field} onChange={(e) => setCond(i, { field: e.target.value as Field })} aria-label={`Condition ${i + 1} field`}>
            {FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select className="select input s-auto" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Op })} aria-label={`Condition ${i + 1} comparison`}>
            {OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input className="input" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} aria-label={`Condition ${i + 1} value`} placeholder="newsletter@example.com" />
          <button
            type="button"
            className="icon-btn sm"
            aria-label={`Remove condition ${i + 1}`}
            disabled={rule.conditions.length <= 1}
            onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="btn sm ghost s-add" onClick={() => onChange({ ...rule, conditions: [...rule.conditions, { field: 'from', op: 'contains', value: '' }] })}>
        <Plus size={14} aria-hidden="true" /> Add condition
      </button>
      <div className="s-rule-line">
        <span>Then:</span>
      </div>
      {rule.actions.map((a, i) => (
        <div className="s-rule-line" key={i}>
          <select className="select input s-auto" value={a.type} onChange={(e) => setAct(i, { type: e.target.value as ActionType, value: undefined })} aria-label={`Action ${i + 1}`}>
            {ACTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {a.type === 'move' && (
            <select className="select input" value={a.value ?? ''} onChange={(e) => setAct(i, { value: e.target.value })} aria-label={`Action ${i + 1} folder`}>
              <option value="" disabled>
                Choose a folder
              </option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          {a.type === 'forward' && (
            <input className="input" type="email" value={a.value ?? ''} onChange={(e) => setAct(i, { value: e.target.value })} aria-label={`Action ${i + 1} forward address`} placeholder="someone@example.com" />
          )}
          {a.type !== 'move' && a.type !== 'forward' && <span className="grow" />}
          <button
            type="button"
            className="icon-btn sm"
            aria-label={`Remove action ${i + 1}`}
            disabled={rule.actions.length <= 1}
            onClick={() => onChange({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="btn sm ghost s-add" onClick={() => onChange({ ...rule, actions: [...rule.actions, { type: 'mark-read' }] })}>
        <Plus size={14} aria-hidden="true" /> Add action
      </button>
    </fieldset>
  );
}

function ruleProblem(r: Rule): string | null {
  if (!r.enabled) return null;
  if (r.conditions.some((c) => !c.value.trim())) return `“${r.name || 'Untitled rule'}” has an empty condition.`;
  if (r.actions.some((a) => (a.type === 'move' || a.type === 'forward') && !a.value?.trim())) return `“${r.name || 'Untitled rule'}” needs a folder or address.`;
  return null;
}

export function FiltersTab() {
  const qc = useQueryClient();
  const { data: boxes } = useMailboxes();
  const q = useQuery({ queryKey: ['sieve'], queryFn: () => api<SieveState>('/api/sieve'), staleTime: 0, retry: false });
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [vac, setVac] = useState<Vacation | null>(null);
  const [addrText, setAddrText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const vid = useId();

  useEffect(() => {
    if (q.data?.model && rules === null) {
      setRules(q.data.model.rules);
      setVac(q.data.model.vacation);
      setAddrText(q.data.model.vacation.addresses.join(', '));
    }
  }, [q.data, rules]);

  if (q.isLoading) return <SkeletonRows />;
  if (q.error) return <InlineError error={q.error} />;
  if (!q.data?.available) {
    return (
      <div className="s-empty">
        <Filter size={28} aria-hidden="true" />
        <h3>Filters aren’t available on this server</h3>
        <p className="hint">
          Filters and the vacation responder use ManageSieve on your mail server. Ask your administrator to enable it and set <code>TIDINGS_SIEVE_URL</code>.
        </p>
      </div>
    );
  }
  if (!rules || !vac) return <SkeletonRows />;

  const folders = (boxes ?? []).map((b) => b.path);
  const exts = q.data.extensions ?? [];
  const canDate = exts.includes('date') && exts.includes('relational');
  const touch = () => setSaved(false);
  const problem = rules.map(ruleProblem).find(Boolean) ?? null;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const addresses = addrText
        .split(/[,\s;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api('/api/sieve', { method: 'PUT', body: { rules, vacation: { ...vac, addresses } } });
      await qc.invalidateQueries({ queryKey: ['sieve'] });
      setSaved(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const foreign = q.data.active && !q.data.managedByUs ? q.data.active : null;

  return (
    <>
      {foreign && (
        <p className="s-note card" role="note">
          Your existing filters from “{foreign}” stay active — Tidings includes them when you save here.
        </p>
      )}
      <Section title="Vacation responder" lead="Sends an automatic reply while you’re away. Each sender gets at most one reply in the period you choose.">
        <ToggleRow
          title="Send automatic replies"
          checked={vac.enabled}
          onChange={(v) => {
            touch();
            setVac({ ...vac, enabled: v });
          }}
        />
        <div className="s-stack" aria-disabled={!vac.enabled} style={{ opacity: vac.enabled ? 1 : 0.6 }}>
          <label className="field">
            <span>Subject</span>
            <input className="input" value={vac.subject} onChange={(e) => (touch(), setVac({ ...vac, subject: e.target.value }))} maxLength={500} />
          </label>
          <label className="field">
            <span>Message</span>
            <textarea
              className="textarea"
              rows={5}
              value={vac.body}
              onChange={(e) => (touch(), setVac({ ...vac, body: e.target.value }))}
              placeholder={'I’m away until Monday 10 November with limited access to email.\nFor anything urgent, contact Bob at bob@example.com.'}
            />
          </label>
          <div className="s-grid3">
            <label className="field">
              <span>First day</span>
              <input className="input" type="date" disabled={!canDate} value={toDateInput(vac.from)} onChange={(e) => (touch(), setVac({ ...vac, from: fromDateInput(e.target.value) }))} />
            </label>
            <label className="field">
              <span>Last day</span>
              <input className="input" type="date" disabled={!canDate} value={toDateInput(vac.until)} onChange={(e) => (touch(), setVac({ ...vac, until: fromDateInput(e.target.value) }))} />
            </label>
            <label className="field">
              <span id={vid}>Reply to each sender every</span>
              <select className="select input" value={vac.days} onChange={(e) => (touch(), setVac({ ...vac, days: Number(e.target.value) }))} aria-labelledby={vid}>
                {[1, 3, 7, 14, 30].map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? 'day' : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!canDate && <p className="hint">This server can’t limit replies to a date range, so they run until you turn them off.</p>}
          <label className="field">
            <span>Also reply for these addresses (optional)</span>
            <input className="input" value={addrText} onChange={(e) => (touch(), setAddrText(e.target.value))} placeholder="sales@example.com, hello@example.com" />
          </label>
        </div>
      </Section>

      <Section title="Rules" lead="Run on the mail server as messages arrive, so they work even when Tidings isn’t open. Rules run from top to bottom.">
        {rules.length === 0 && <p className="hint">No rules yet. For example: move everything from a mailing list into its own folder.</p>}
        <div className="s-stack">
          {rules.map((r, i) => (
            <RuleEditor
              key={r.id}
              index={i}
              rule={r}
              folders={folders}
              onChange={(nr) => (touch(), setRules(rules.map((x, j) => (j === i ? nr : x))))}
              onRemove={() => (touch(), setRules(rules.filter((_, j) => j !== i)))}
            />
          ))}
        </div>
        <div className="s-row-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              touch();
              setRules([
                ...rules,
                { id: crypto.randomUUID().slice(0, 12), name: 'New rule', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'move', value: '' }] },
              ]);
            }}
          >
            <Plus size={14} aria-hidden="true" /> Add rule
          </button>
        </div>
      </Section>

      <Row title="Save filters" hint={problem ?? 'Saved to your mail server and active immediately.'}>
        <div className="s-row-actions">
          {saved && (
            <span className="hint" role="status">
              Saved
            </span>
          )}
          <button type="button" className="btn primary" disabled={busy || !!problem} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save filters'}
          </button>
        </div>
      </Row>
      <InlineError error={err} />
    </>
  );
}
