import { X } from 'lucide-react';
import { useUi } from '../state/ui';

let announcer: HTMLElement | null = null;
/** Polite screen-reader announcement (new mail, counts) without a visible toast. */
export function announce(text: string) {
  if (!announcer) return;
  announcer.textContent = '';
  setTimeout(() => announcer && (announcer.textContent = text), 50);
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <>
    <div className="sr-only" aria-live="polite" ref={(el) => {
      announcer = el;
    }} />
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.tone === 'error' ? ' error' : ''}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span className="msg-t">{t.message}</span>
          {t.action && (
            <button
              className="act"
              onClick={() => {
                dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={15} />
          </button>
          {t.action && !t.sticky && <span className="bar" style={{ animationDuration: `${t.ttl ?? 7000}ms` }} aria-hidden="true" />}
        </div>
      ))}
    </div>
    </>
  );
}
