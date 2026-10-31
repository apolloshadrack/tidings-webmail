import { ArrowDown, ArrowUp, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { describeKey, getCommands, onCommandsChanged, type Command } from '../../lib/keys';
import { useConfig } from '../../state/queries';
import { useSettings, type SplitTab } from '../../state/settings';
import { Row, Section, Seg, ToggleRow } from './controls';

const OPERATORS = 'from:  to:  subject:  is:unread  is:starred  is:newsletter  has:attachment  before:2026-01-01  after:  larger:5M';

function SplitTabsEditor() {
  const tabs = useSettings((x) => x.s.splitTabs);
  const set = useSettings((x) => x.set);
  const update = (next: SplitTab[]) => set({ splitTabs: next });
  const edit = (i: number, patch: Partial<SplitTab>) => update(tabs.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= tabs.length) return;
    const next = [...tabs];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };
  return (
    <div className="card s-tabs-card">
      <div className="list-editor">
        {tabs.length === 0 && <p className="hint">No tabs yet. Your inbox shows everything in one list.</p>}
        {tabs.map((t, i) => (
          <div className="item" key={t.id}>
            <input className="input s-tab-name" aria-label={`Tab ${i + 1} name`} value={t.name} onChange={(e) => edit(i, { name: e.target.value })} placeholder="Name" maxLength={40} />
            <input
              className="input s-mono"
              aria-label={`Tab ${i + 1} filter`}
              value={t.query}
              onChange={(e) => edit(i, { query: e.target.value })}
              placeholder="e.g. from:@company.com"
              spellCheck={false}
            />
            <button type="button" className="icon-btn sm" aria-label={`Move ${t.name || 'tab'} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={15} />
            </button>
            <button type="button" className="icon-btn sm" aria-label={`Move ${t.name || 'tab'} down`} disabled={i === tabs.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={15} />
            </button>
            <button type="button" className="icon-btn sm" aria-label={`Remove ${t.name || 'tab'}`} onClick={() => update(tabs.filter((_, j) => j !== i))}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <div className="s-row-actions">
        <button
          type="button"
          className="btn sm"
          disabled={tabs.length >= 6}
          onClick={() => update([...tabs, { id: crypto.randomUUID().slice(0, 8), name: 'New tab', query: '' }])}
        >
          <Plus size={14} aria-hidden="true" /> Add tab
        </button>
        <span className="hint">
          Filters use search operators: <code className="s-mono">{OPERATORS}</code>
        </span>
      </div>
    </div>
  );
}

export function InboxTab() {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

  const toggleNotifications = async (on: boolean) => {
    if (!on) return set({ desktopNotifications: false });
    if (typeof Notification === 'undefined') return;
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setPerm(p);
    set({ desktopNotifications: p === 'granted' });
  };

  return (
    <>
      <Section title="Conversations">
        <ToggleRow
          title="Group messages into conversations"
          hint="Replies are shown together, including the ones you sent. Drafts, Sent and Trash always show single messages."
          checked={s.conversations}
          onChange={(v) => set({ conversations: v })}
        />
        <Row title="After archiving or deleting" hint="Where the cursor goes when the current conversation leaves the list.">
          <Seg
            label="After archiving or deleting"
            value={s.afterAction}
            onChange={(v) => set({ afterAction: v })}
            options={[
              { value: 'next', label: 'Older' },
              { value: 'previous', label: 'Newer' },
              { value: 'list', label: 'Back to list' },
            ]}
          />
        </Row>
        <Row title="Mark as read" hint="Moving past a message with j or k before the delay leaves it unread.">
          <Seg
            label="Mark as read"
            value={s.markReadDelay}
            onChange={(v) => set({ markReadDelay: v })}
            options={[
              { value: 0, label: 'Immediately' },
              { value: 800, label: 'After 0.8 s' },
              { value: 2000, label: 'After 2 s' },
              { value: -1, label: 'Manually' },
            ]}
          />
        </Row>
      </Section>

      <Section title="Split inbox" lead="Tabs across the top of your inbox, each defined by a filter. Messages can appear in more than one tab.">
        <ToggleRow title="Show tabs in the inbox" checked={s.splitInbox} onChange={(v) => set({ splitInbox: v })} />
        {s.splitInbox && <SplitTabsEditor />}
      </Section>

      <Section title="Notifications">
        <ToggleRow
          title="Desktop notifications"
          hint={
            perm === 'denied'
              ? 'Your browser is blocking notifications for this site. Allow them in the site settings to turn this on.'
              : 'Shown for new mail in your inbox while Tidings is open in a tab.'
          }
          checked={s.desktopNotifications}
          onChange={(v) => void toggleNotifications(v)}
        />
        <ToggleRow
          title="Show sender and subject"
          hint="Turn off on shared screens: notifications will only say that new mail arrived."
          checked={s.notificationPreview}
          onChange={(v) => set({ notificationPreview: v })}
        />
      </Section>
    </>
  );
}

export function ReadingTab() {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  return (
    <>
      <Section title="Remote images">
        <Row
          title="Load remote images"
          hint="Images always load through Tidings’ privacy proxy, so senders don’t see your IP address or device. Loading them can still tell the sender you opened the message. Known tracking pixels are never loaded."
        >
          <Seg
            label="Load remote images"
            value={s.remoteImages}
            onChange={(v) => set({ remoteImages: v })}
            options={[
              { value: 'ask', label: 'Ask' },
              { value: 'trusted', label: 'Trusted senders' },
              { value: 'always', label: 'Always' },
            ]}
          />
        </Row>
      </Section>
      <Section title="Links">
        <ToggleRow
          title="Remove tracking parameters"
          hint="Strips utm_ and similar campaign tags from links before you open them."
          checked={s.stripTracking}
          onChange={(v) => set({ stripTracking: v })}
        />
        <ToggleRow
          title="Confirm before opening links"
          hint="Shows the real destination first. Links whose text names a different site always ask, even when this is off."
          checked={s.confirmLinks}
          onChange={(v) => set({ confirmLinks: v })}
        />
      </Section>
      <Section title="Replying">
        <Row title="Default reply" hint="What r does, and the main button under a message.">
          <Seg
            label="Default reply"
            value={s.defaultReply}
            onChange={(v) => set({ defaultReply: v })}
            options={[
              { value: 'reply', label: 'Reply' },
              { value: 'replyAll', label: 'Reply all' },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}

export function ComposeTab() {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  return (
    <>
      <Section title="Writing">
        <Row title="Editor" hint="Plain text sends exactly what you type, with no formatting.">
          <Seg
            label="Editor"
            value={s.composeMode}
            onChange={(v) => set({ composeMode: v })}
            options={[
              { value: 'rich', label: 'Rich text' },
              { value: 'plain', label: 'Plain text' },
            ]}
          />
        </Row>
        <Row title="Quoted text in replies" hint="Your reply and signature go above the quote, or below it.">
          <Seg
            label="Quoted text in replies"
            value={s.quotePosition}
            onChange={(v) => set({ quotePosition: v })}
            options={[
              { value: 'top', label: 'Reply above' },
              { value: 'bottom', label: 'Reply below' },
            ]}
          />
        </Row>
      </Section>
      <Section title="Sending">
        <Row title="Undo send" hint="How long you have to take a message back after pressing Send.">
          <Seg
            label="Undo send"
            value={s.undoSendSeconds}
            onChange={(v) => set({ undoSendSeconds: v })}
            options={[
              { value: 0, label: 'Off' },
              { value: 5, label: '5 s' },
              { value: 10, label: '10 s' },
              { value: 20, label: '20 s' },
              { value: 30, label: '30 s' },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}

export function PrivacyTab() {
  return (
    <>
      <Section title="What Tidings does to protect you">
        <ul className="s-facts">
          <li>
            <b>Remote content is blocked by default.</b> Messages are shown in a sandbox that can’t run scripts or contact other servers until you choose to load
            images.
          </li>
          <li>
            <b>Images load through a proxy.</b> When you do load them, Tidings fetches them for you, so the sender sees the server, not your IP address or
            browser. They can still learn that the message was opened.
          </li>
          <li>
            <b>Trackers are counted and skipped.</b> Invisible tracking pixels and known tracking services are never loaded, even when you allow images. The count
            shown on a message is a best-effort estimate, not a guarantee.
          </li>
          <li>
            <b>Links are cleaned.</b> Campaign tags such as utm_ are removed, and links that pretend to go somewhere else are flagged.
          </li>
          <li>
            <b>No telemetry.</b> Tidings doesn’t send usage data anywhere. Fonts and icons are served by this server.
          </li>
          <li>
            <b>Your password stays encrypted.</b> It’s kept encrypted on the server and can only be unlocked with your browser’s session cookie. Signing out
            removes it.
          </li>
        </ul>
      </Section>
      <Section title="Trusted senders">
        <p className="hint">
          When remote images are set to “Trusted senders”, choose “Always load images from this sender” on a message to add them. You can turn a sender off again
          from the sender panel.
        </p>
      </Section>
      <Section title="Shared and public computers">
        <p className="hint">
          Tick “This is a public computer” when signing in. Your session then ends when the browser closes or after 30 minutes without activity, and signing out
          clears what this browser cached.
        </p>
      </Section>
    </>
  );
}

export function ShortcutsTab() {
  const shortcuts = useSettings((x) => x.s.shortcuts);
  const set = useSettings((x) => x.set);
  const [cmds, setCmds] = useState<Command[]>(() => getCommands());
  useEffect(() => {
    const off = onCommandsChanged(() => setCmds(getCommands()));
    return () => {
      off();
    };
  }, []);
  const groups = new Map<string, Command[]>();
  for (const c of cmds) {
    if (!c.keys?.length) continue;
    const g = groups.get(c.group) ?? [];
    g.push(c);
    groups.set(c.group, g);
  }
  return (
    <>
      <Section title="Keyboard shortcuts" lead="Gmail-compatible keys. Shortcuts are paused while you type in a field.">
        <ToggleRow
          title="Enable keyboard shortcuts"
          hint="The command palette (⌘K or Ctrl+K) keeps working when this is off."
          checked={shortcuts}
          onChange={(v) => set({ shortcuts: v })}
        />
      </Section>
      {[...groups].map(([group, list]) => (
        <section key={group} aria-label={group} className="s-keys">
          <h3>{group}</h3>
          {list.map((c) => (
            <div className="help-row" key={c.id}>
              <span>{c.title}</span>
              <span className="keys">
                {[c.keys!, ...(c.alt ?? [])].map((seq, i) => (
                  <span key={i} className="s-seq">
                    {i > 0 && <span className="s-or">or</span>}
                    {seq.map((k, j) => (
                      <span key={j} className="s-seq">
                        {j > 0 && <span className="s-or">then</span>}
                        <kbd>{describeKey(k)}</kbd>
                      </span>
                    ))}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      {groups.size === 0 && <p className="hint">The shortcut list appears here once the mailbox has loaded.</p>}
    </>
  );
}

export function AboutTab() {
  const { data: cfg } = useConfig();
  const name = cfg?.brand.name ?? 'Tidings';
  const source = cfg?.sourceUrl ?? 'https://github.com/apolloshadrack/tidings-webmail';
  const ids = useId();
  return (
    <>
      <Section title={name}>
        <div className="card s-about">
          <dl aria-labelledby={ids}>
            <div>
              <dt>Version</dt>
              <dd className="num">{cfg?.version ?? '—'}</dd>
            </div>
            <div>
              <dt>Licence</dt>
              <dd>GNU Affero General Public License v3.0 or later</dd>
            </div>
            <div>
              <dt>Source code</dt>
              <dd>
                <a href={source} target="_blank" rel="noopener noreferrer">
                  {source.replace(/^https?:\/\//, '')} <ExternalLink size={12} aria-hidden="true" />
                </a>
              </dd>
            </div>
            <div>
              <dt>Security</dt>
              <dd>
                <a href={`${source.replace(/\/$/, '')}/blob/main/SECURITY.md`} target="_blank" rel="noopener noreferrer">
                  Report a security issue <ExternalLink size={12} aria-hidden="true" />
                </a>
              </dd>
            </div>
          </dl>
        </div>
        <p className="hint" id={ids}>
          {name === 'Tidings' ? 'Tidings is' : `${name} is based on Tidings,`} free software: you can study, change and share it. If this server runs a modified
          version, the source link above must point to that version.
        </p>
        <p className="hint">
          Press <kbd>?</kbd> anywhere for shortcuts.
        </p>
      </Section>
    </>
  );
}
