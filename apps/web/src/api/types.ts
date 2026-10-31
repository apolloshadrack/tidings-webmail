export interface Address {
  name: string;
  address: string;
}

export type Role = '\\Inbox' | '\\Drafts' | '\\Sent' | '\\Archive' | '\\Junk' | '\\Trash' | '\\All' | '\\Flagged' | null;

export interface Mailbox {
  path: string;
  name: string;
  delimiter: string | null;
  parent: string | null;
  role: Role;
  total: number;
  unread: number;
  synced: number;
  subscribed: boolean;
  color: string | null;
  uidValidity: string | null;
}

export interface ListItem {
  key: string;
  mailbox: string;
  uid: number;
  uids: number[];
  uidValidity: string;
  messageId: string | null;
  threadId: string;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  participants: Address[];
  date: number;
  size: number;
  flags: string[];
  unread: boolean;
  unreadCount: number;
  count: number;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  snippet: string;
  newsletter: boolean;
}

export interface ListPage {
  items: ListItem[];
  nextCursor: string | null;
  threads: boolean;
}

export interface Attachment {
  part: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  cid?: string;
}

export interface FullMessage {
  mailbox: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Address[];
  sender: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  date: number;
  flags: string[];
  html: string | null;
  text: string | null;
  truncated: boolean;
  attachments: Attachment[];
  listUnsubscribe: string | null;
  listUnsubscribeOneClick: boolean;
  listPost: string | null;
  deliveredTo: string[];
  dispositionNotificationTo: string | null;
  auth: { dkim?: string; spf?: string; dmarc?: string; trusted: boolean } | null;
  size: number;
  senderKnown: boolean;
  imagesTrusted: boolean;
}

export interface Target {
  mailbox: string;
  uidValidity: string;
  uids: number[];
}

export interface Identity {
  id?: number;
  name: string;
  email: string;
  replyTo?: string | null;
  signatureHtml: string;
  isDefault: number | boolean;
}

export interface SessionInfo {
  username: string;
  email: string;
  csrf: string;
  publicComputer: boolean;
  settings: Partial<import('../state/settings').Settings> | null;
  identityPolicy: 'login-only' | 'aliases' | 'free';
  allowedFrom: string[] | null;
}

export interface ServerConfig {
  brand: { name: string; accent?: string; logoUrl?: string; loginMessage?: string; supportUrl?: string; customCss?: string };
  basePath: string;
  sourceUrl: string;
  version: string;
  features: { sieve: boolean };
  demo: boolean;
  defaultDomain: string | null;
}

export interface ComposeState {
  draftId: string;
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html?: string;
  text: string;
  attachments: string[];
  kind: 'new' | 'reply' | 'replyAll' | 'forward';
  inReplyTo?: { mailbox: string; uidValidity: string; uid: number };
  forwardAttachments?: { mailbox: string; uidValidity: string; uid: number; parts: string[] };
  requestReceipt: boolean;
  delaySeconds: number;
}

export interface OutboxItem {
  id: string;
  state: 'queued' | 'sending' | 'sent' | 'failed' | 'stalled' | 'unknown';
  sendAt: number;
  createdAt: number;
  subject: string;
  to: string[];
  error: string | null;
  draftId: string;
}

export interface ServerEvent {
  type: 'mailbox' | 'mailboxes' | 'outbox' | 'resync' | 'snooze' | 'auth';
  path?: string;
  added?: number;
  removed?: number;
  updated?: number;
  sent?: string;
  failed?: string;
  error?: string;
  warnings?: string[];
  reason?: string;
}
