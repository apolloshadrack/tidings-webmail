import { useId, type ReactNode } from 'react';

/** One labelled setting: title + description on the left, control on the right. */
export function Row({ title, hint, children, htmlFor }: { title: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="setting-row">
      <div className="txt">
        {htmlFor ? (
          <label htmlFor={htmlFor}>
            <b>{title}</b>
          </label>
        ) : (
          <b>{title}</b>
        )}
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  );
}

/** Segmented control. Each option is a toggle button; the group is labelled for screen readers. */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A setting whose control is an on/off switch. The whole title is the switch's label. */
export function ToggleRow({ title, hint, checked, onChange }: { title: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <Row title={title} hint={hint} htmlFor={id}>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  );
}

export function Section({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {lead && <p className="hint s-lead">{lead}</p>}
      {children}
    </section>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = (error as Error)?.message ?? String(error);
  return (
    <div className="s-error" role="alert">
      {msg}
    </div>
  );
}

export function SkeletonRows({ n = 3 }: { n?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="s-skel">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 44, marginTop: 10, width: `${92 - i * 9}%` }} />
      ))}
    </div>
  );
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Plain text -> minimal safe HTML (escaped, line breaks only). */
export function plainToHtml(s: string) {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

/** Minimal HTML -> plain text for editing in a textarea. */
export function htmlToPlainText(html: string) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n'), 'text/html');
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}
