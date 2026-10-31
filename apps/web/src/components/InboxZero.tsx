import { Horizon } from './Login';

const LINES = [
  ['Inbox zero.', 'Nothing needs you right now.'],
  ['All clear.', 'Everything has been answered, filed or snoozed.'],
  ['You’re caught up.', 'New mail will appear here the moment it lands.'],
];

export function InboxZero({ tab }: { tab?: string }) {
  const [title, sub] = LINES[new Date().getDate() % LINES.length];
  return (
    <div className="zero">
      <div>
        <div className="zero-art" aria-hidden="true">
          <Horizon />
        </div>
        <h3>{tab ? `Nothing in ${tab}` : title}</h3>
        <p>{tab ? 'Conversations that match this tab will show up here.' : sub}</p>
      </div>
    </div>
  );
}
