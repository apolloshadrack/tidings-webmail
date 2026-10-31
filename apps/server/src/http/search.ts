/**
 * Tier-1 search over the local index. Gmail-style operators:
 *   from: to: subject: in: is:unread|read|starred|unstarred|answered|snoozed|newsletter
 *   has:attachment  before:YYYY-MM-DD  after:YYYY-MM-DD  larger:5M  smaller:1M  "exact phrase"
 * Free text goes through FTS5 (prefix matching). Returns a SQL fragment + params.
 */
export interface ParsedQuery {
  where: string[];
  params: unknown[];
  mailbox?: string;
  freeText: string[];
  hasFolderScope: boolean;
}

function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(-?[a-z_]+:)?("([^"]*)"|\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[0]);
  return out;
}

const unquote = (s: string) => s.replace(/^"|"$/g, '');

function parseSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(s);
  if (!m) return null;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * mult);
}

function parseDate(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function ftsQuery(terms: string[]): string {
  return terms
    .map((t) => t.replace(/["*^():]/g, ' ').trim())
    .filter(Boolean)
    .map((t) => (t.includes(' ') ? `"${t}"` : `"${t}"*`))
    .join(' AND ');
}

export function parseSearch(q: string, mailboxRoles: Map<string, string>): ParsedQuery {
  const where: string[] = [];
  const params: unknown[] = [];
  const freeText: string[] = [];
  let mailbox: string | undefined;
  let hasFolderScope = false;
  for (const tok of tokenize(q.trim())) {
    const m = /^(-?)([a-z_]+):(.+)$/i.exec(tok);
    if (!m) {
      freeText.push(unquote(tok));
      continue;
    }
    const neg = m[1] === '-';
    const key = m[2].toLowerCase();
    const val = unquote(m[3]);
    const lv = `%${val.toLowerCase()}%`;
    const add = (sql: string, ...p: unknown[]) => {
      where.push(neg ? `NOT (${sql})` : sql);
      params.push(...p);
    };
    switch (key) {
      case 'from':
        add('(lower(m.from_addr) LIKE ? OR lower(m.from_name) LIKE ?)', lv, lv);
        break;
      case 'to':
        add('(lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?)', lv, lv);
        break;
      case 'subject':
        add('lower(m.subject) LIKE ?', lv);
        break;
      case 'label':
      case 'in': {
        hasFolderScope = true;
        const role = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', spam: '\\Junk', junk: '\\Junk', archive: '\\Archive' }[
          val.toLowerCase()
        ];
        if (val.toLowerCase() === 'anywhere' || val.toLowerCase() === 'all') {
          hasFolderScope = true;
          where.push('1=1');
          break;
        }
        const path = role ? [...mailboxRoles].find(([, r]) => r === role)?.[0] : undefined;
        if (path) mailbox = path;
        else {
          // Folders match case-insensitively by full path or by their last segment.
          where.push("(lower(m.mailbox) = ? OR lower(m.mailbox) LIKE ? OR lower(m.mailbox) LIKE ?)");
          params.push(val.toLowerCase(), `%/${val.toLowerCase()}`, `%.${val.toLowerCase()}`);
        }
        break;
      }
      case 'is':
        switch (val.toLowerCase()) {
          case 'unread':
            add('m.seen = 0');
            break;
          case 'read':
            add('m.seen = 1');
            break;
          case 'starred':
          case 'flagged':
            add('m.flagged = 1');
            break;
          case 'unstarred':
            add('m.flagged = 0');
            break;
          case 'answered':
          case 'replied':
            add('m.answered = 1');
            break;
          case 'newsletter':
          case 'subscription':
            add('m.list_unsubscribe IS NOT NULL');
            break;
          default:
            freeText.push(tok);
        }
        break;
      case 'has':
        if (/^attach/i.test(val)) add('m.has_attachments = 1');
        else freeText.push(tok);
        break;
      case 'before': {
        const d = parseDate(val);
        if (d) add('m.date < ?', d);
        break;
      }
      case 'after': {
        const d = parseDate(val);
        if (d) add('m.date >= ?', d);
        break;
      }
      case 'older_than':
      case 'newer_than': {
        const m2 = /^(\d+)([dwmy])$/i.exec(val);
        if (m2) {
          const days = Number(m2[1]) * { d: 1, w: 7, m: 30, y: 365 }[m2[2].toLowerCase() as 'd' | 'w' | 'm' | 'y'];
          const cutoff = Date.now() - days * 86_400_000;
          add(key === 'older_than' ? 'm.date < ?' : 'm.date >= ?', cutoff);
        }
        break;
      }
      case 'larger': {
        const n = parseSize(val);
        if (n) add('m.size > ?', n);
        break;
      }
      case 'smaller': {
        const n = parseSize(val);
        if (n) add('m.size < ?', n);
        break;
      }
      default:
        freeText.push(tok);
    }
  }
  return { where, params, mailbox, freeText, hasFolderScope };
}
