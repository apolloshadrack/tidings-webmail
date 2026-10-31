import { Filter, Inbox, Info, Keyboard, MailOpen, Palette, PenLine, Quote, Shield, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { AppearanceTab } from './AppearanceTab';
import { IdentitiesTab, SnippetsTab } from './AccountTabs';
import { FiltersTab } from './FiltersTab';
import { AboutTab, ComposeTab, InboxTab, PrivacyTab, ReadingTab, ShortcutsTab } from './PreferenceTabs';

interface TabDef {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  Component: ComponentType;
  lead: string;
}

const TABS: TabDef[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette, Component: AppearanceTab, lead: 'Themes, colour, density and text.' },
  { id: 'inbox', label: 'Inbox', icon: Inbox, Component: InboxTab, lead: 'Conversations, split inbox and notifications.' },
  { id: 'reading', label: 'Reading', icon: MailOpen, Component: ReadingTab, lead: 'Images, links and replies.' },
  { id: 'compose', label: 'Writing', icon: PenLine, Component: ComposeTab, lead: 'Editor, quoting and undo send.' },
  { id: 'identities', label: 'Identities', icon: UserRound, Component: IdentitiesTab, lead: 'Names, addresses and signatures.' },
  { id: 'snippets', label: 'Snippets', icon: Quote, Component: SnippetsTab, lead: 'Text you reuse.' },
  { id: 'filters', label: 'Filters & vacation', icon: Filter, Component: FiltersTab, lead: 'Rules that run on your mail server.' },
  { id: 'privacy', label: 'Privacy', icon: Shield, Component: PrivacyTab, lead: 'How Tidings protects you.' },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, Component: ShortcutsTab, lead: 'Every key, in one place.' },
  { id: 'about', label: 'About', icon: Info, Component: AboutTab, lead: 'Version, licence and source.' },
];

export function SettingsDialog({ tab, onClose }: { tab?: string; onClose: () => void }) {
  const [active, setActive] = useState(() => (TABS.some((t) => t.id === tab) ? tab! : 'appearance'));
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    ref.current?.querySelector<HTMLElement>('.settings-nav [aria-current="page"]')?.focus();
    return () => {
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    // Keep the global single-key shortcuts from firing while the dialog is open.
    e.stopPropagation();
    if (e.key === 'Tab' && ref.current) {
      const focusables = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const onNavKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = TABS[(i + (e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length];
    setActive(next.id);
    ref.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  const current = TABS.find((t) => t.id === active)!;
  const Body = current.Component;

  return (
    <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={ref} onKeyDown={onKeyDown}>
      <div className="dialog-head s-head">
        <h2 id="settings-title">Settings</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
          <X size={18} />
        </button>
      </div>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t, i) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                data-tab={t.id}
                className={`nav-item${t.id === active ? ' active' : ''}`}
                aria-current={t.id === active ? 'page' : undefined}
                onClick={() => setActive(t.id)}
                onKeyDown={(e) => onNavKey(e, i)}
              >
                <Icon size={16} aria-hidden={true} />
                <span className="label">{t.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="settings-body" ref={bodyRef} role="region" aria-labelledby="settings-section-title">
          <h2 className="s-title" id="settings-section-title">
            {current.label}
          </h2>
          <p className="lead">{current.lead}</p>
          <Body />
        </div>
      </div>
    </div>
  );
}
