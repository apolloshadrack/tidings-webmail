import { Horizon } from './Login';

const LINES = [
  ['Inbox zero.', 'Nothing needs you right now.'],
  ['All clear.', 'Go do something wonderful.'],
  ['You’re caught up.', 'New mail will appear here the moment it lands.'],
];

export function InboxZero({ tab }: { tab?: string }) {
  const [title, sub] = LINES[new Date().getDate() % LINES.length];
  return (
    <div className="zero">
      <div>
        <div style={{ width: 'min(340px, 80%)', margin: '0 auto', aspectRatio: '4 / 3', borderRadius: 18, overflow: 'hidden', boxShadow: 'var(--shadow-2)' }} aria-hidden="true">
          <Horizon />
        </div>
        <h3>{tab ? `Nothing in ${tab}` : title}</h3>
        <p>{tab ? 'Conversations that match this tab will show up here.' : sub}</p>
      </div>
    </div>
  );
}
