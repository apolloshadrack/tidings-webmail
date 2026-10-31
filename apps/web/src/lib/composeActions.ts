import { api } from '../api/client';
import type { Address, ComposeState, FullMessage, Identity, SessionInfo } from '../api/types';
import { queryClient } from '../state/queries';
import { ui } from '../state/ui';
import { type ComposeSeed, forwardCompose, newCompose, replyCompose, textToHtml } from './compose';
import { sanitizeForComposer } from './sanitize';

let currentMessage: FullMessage | null = null;
let selectionText = '';

/** The Reader tells us which message replies/forwards should target (the focused/latest one). */
export function setCurrentMessage(m: FullMessage | null) {
  currentMessage = m;
}
export function getCurrentMessage() {
  return currentMessage;
}
export function setQuoteSelection(text: string) {
  selectionText = text;
}

async function identities(): Promise<Identity[]> {
  const r = await queryClient.fetchQuery({
    queryKey: ['identities'],
    queryFn: () => api<{ identities: Identity[]; allowed: string[] | null }>('/api/identities'),
    staleTime: 300_000,
  });
  return r.identities;
}

function me(): string {
  return queryClient.getQueryData<SessionInfo>(['session'])?.email ?? '';
}

function open(seed: ComposeSeed, inlineThread?: string, focus: 'to' | 'body' = 'body') {
  ui().openComposer({
    id: seed.state.draftId,
    state: { ...seed.state, html: seed.bodyHtml },
    minimized: false,
    inlineThread,
    quotedHtml: seed.quotedHtml,
    quotedText: seed.quotedText,
    forwardFiles: seed.forwardFiles,
    focus,
  });
}

export async function composeNew(to: Address[] = [], subject = '', body = '') {
  const seed = newCompose(await identities(), me(), to, subject, body);
  open(seed, undefined, to.length ? 'body' : 'to');
}

export async function reply(all: boolean, msg = currentMessage, threadKey?: string) {
  if (!msg) return;
  const seed = replyCompose(msg, all, await identities(), me(), selectionText || undefined);
  selectionText = '';
  open(seed, threadKey ?? ui().open ?? undefined, 'body');
}

export async function forward(msg = currentMessage) {
  if (!msg) return;
  const seed = forwardCompose(msg, await identities(), me());
  open(seed, undefined, 'to');
}

/** mailto: links (RFC 6068): only to/cc/bcc/subject/body are honoured; never from, attachments or auto-send. */
export async function composeFromMailto(mailto: string) {
  let url: URL;
  try {
    url = new URL(mailto);
  } catch {
    return;
  }
  const split = (v: string | null) =>
    (v ?? '')
      .split(',')
      .map((s) => decodeURIComponent(s).trim())
      .filter(Boolean)
      .map((address) => ({ name: '', address }));
  const to = [...split(url.pathname), ...split(url.searchParams.get('to'))];
  const seed = newCompose(await identities(), me(), to, url.searchParams.get('subject') ?? '', url.searchParams.get('body') ?? '');
  seed.state.cc = split(url.searchParams.get('cc'));
  seed.state.bcc = split(url.searchParams.get('bcc'));
  open(seed, undefined, 'body');
}

export function openComposeState(state: ComposeState) {
  ui().openComposer({ id: state.draftId, state, minimized: false, focus: 'body' });
}

/** Opening a message that lives in Drafts edits it instead of reading it. */
export async function editDraftMessage(msg: FullMessage) {
  const seed = newCompose(await identities(), me(), msg.to, msg.subject);
  seed.state.cc = msg.cc;
  seed.state.bcc = msg.bcc;
  // Drafts can contain mail written by other clients: never trust it.
  seed.bodyHtml = msg.html ? sanitizeForComposer(msg.html) : msg.text ? textToHtml(msg.text) : '<p></p>';
  open(seed, undefined, 'body');
}
