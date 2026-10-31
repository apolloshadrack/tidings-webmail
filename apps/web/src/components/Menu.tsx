import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

export type MenuItem =
  | { divider: true }
  | { label: string; run?: () => void; danger?: boolean; hint?: string; swatch?: string; submenu?: MenuItem[]; divider?: false };

/** Keyboard-navigable floating menu, positioned within the viewport. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.menu')) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  return (
    <>
      <div
        ref={ref}
        className="menu"
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={(e) => {
          const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            buttons[(i + 1) % buttons.length]?.focus();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
          }
          e.stopPropagation();
        }}
      >
        {items.map((it, i) =>
          it.divider ? (
            <hr key={i} />
          ) : (
            <button
              key={i}
              role="menuitem"
              style={it.danger ? { color: 'var(--danger)' } : undefined}
              onMouseEnter={(e) => {
                if (it.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ items: it.submenu, x: r.right + 4, y: r.top - 5 });
                } else setSub(null);
              }}
              onClick={(e) => {
                if (it.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ items: it.submenu, x: r.right + 4, y: r.top - 5 });
                  return;
                }
                onClose();
                it.run?.();
              }}
            >
              {it.swatch && <span className="dot" style={{ width: 12, height: 12, borderRadius: 4, background: it.swatch }} />}
              {it.swatch ? '' : it.label}
              {it.hint && <small>{it.hint}</small>}
              {it.submenu && <ChevronRight size={14} style={{ marginLeft: 'auto' }} />}
            </button>
          ),
        )}
      </div>
      {sub && <Menu x={sub.x} y={sub.y} items={sub.items} onClose={onClose} />}
    </>
  );
}
