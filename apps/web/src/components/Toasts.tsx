import { X } from 'lucide-react';
import { useUi } from '../state/ui';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
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
        </div>
      ))}
    </div>
  );
}
