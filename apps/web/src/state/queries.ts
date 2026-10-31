import { QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, qs } from '../api/client';
import type { FullMessage, Identity, ListItem, ListPage, Mailbox, OutboxItem, ServerConfig, SessionInfo } from '../api/types';
import { useSettings } from './settings';
import type { View } from './ui';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (n, err) => n < 2 && (err as { status?: number }).status !== 401 && (err as { status?: number }).status !== 404, refetchOnWindowFocus: true },
  },
});

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => api<ServerConfig>('/api/config'), staleTime: Infinity });

export const useSession = () =>
  useQuery({ queryKey: ['session'], queryFn: () => api<SessionInfo>('/api/session'), retry: false, staleTime: Infinity });

export const useMailboxes = (enabled = true) =>
  useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api<{ mailboxes: Mailbox[] }>('/api/mailboxes').then((r) => r.mailboxes),
    enabled,
    refetchInterval: 120_000,
  });

export interface ListParams {
  mailbox?: string;
  q?: string;
  filter?: string;
  threads: boolean;
}

export function listParams(view: View): ListParams | null {
  const s = useSettings.getState().s;
  if (view.kind === 'mailbox') {
    // Split inbox: the first tab is the default view of the Inbox; "__all" shows everything.
    const tabId = view.tab ?? s.splitTabs[0]?.id;
    const tab = view.path === 'INBOX' && s.splitInbox && tabId !== '__all' ? s.splitTabs.find((t) => t.id === tabId) : undefined;
    return { mailbox: view.path, filter: tab?.query, threads: s.conversations };
  }
  if (view.kind === 'search') return { q: view.q, threads: false };
  return null;
}

export const listKey = (p: ListParams) => ['list', p.mailbox ?? '*', p.filter ?? '', p.q ?? '', p.threads] as const;

export function useList(p: ListParams | null) {
  return useInfiniteQuery({
    queryKey: p ? listKey(p) : ['list', 'none'],
    enabled: !!p,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<ListPage>(`/api/list?${qs({ mailbox: p!.mailbox, q: p!.q, filter: p!.filter, threads: p!.threads ? 1 : 0, cursor: pageParam ?? undefined, limit: 60 })}`, { signal }),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
  });
}

export const threadKey = (threadId: string, mailbox?: string) => ['thread', threadId, mailbox ?? ''] as const;

export function useThread(item: ListItem | null, threads: boolean) {
  return useQuery({
    queryKey: item ? (threads ? threadKey(item.threadId, item.mailbox) : ['single', item.key]) : ['thread', 'none'],
    enabled: !!item,
    queryFn: async () => {
      if (!threads) return [item!];
      const r = await api<{ messages: ListItem[] }>(`/api/thread?${qs({ threadId: item!.threadId, mailbox: item!.mailbox })}`);
      return r.messages.length ? r.messages : [item!];
    },
    placeholderData: item ? [item] : undefined,
  });
}

export const messageKey = (m: { mailbox: string; uidValidity: string; uid: number }) => ['message', m.mailbox, m.uidValidity, m.uid] as const;

export function fetchMessage(m: { mailbox: string; uidValidity: string; uid: number }, prefetch = false) {
  return api<FullMessage>(`/api/message?${qs({ mailbox: m.mailbox, uidValidity: m.uidValidity, uid: m.uid, prefetch: prefetch ? 1 : undefined })}`);
}

export function useMessage(m: { mailbox: string; uidValidity: string; uid: number } | null) {
  return useQuery({
    queryKey: m ? messageKey(m) : ['message', 'none'],
    enabled: !!m,
    queryFn: () => fetchMessage(m!),
    staleTime: 5 * 60_000,
  });
}

export function prefetchMessage(m: { mailbox: string; uidValidity: string; uid: number }) {
  return queryClient.prefetchQuery({ queryKey: messageKey(m), queryFn: () => fetchMessage(m, true), staleTime: 5 * 60_000 });
}

export const useIdentities = () =>
  useQuery({ queryKey: ['identities'], queryFn: () => api<{ identities: Identity[]; allowed: string[] | null }>('/api/identities'), staleTime: 300_000 });

export const useOutbox = () => useQuery({ queryKey: ['outbox'], queryFn: () => api<{ items: OutboxItem[] }>('/api/outbox').then((r) => r.items) });

export const useSnippets = () =>
  useQuery({ queryKey: ['snippets'], queryFn: () => api<{ snippets: { id: number; title: string; bodyHtml: string }[] }>('/api/snippets').then((r) => r.snippets) });

/** Every list item currently cached, flattened (used to update or remove rows optimistically). */
export function allCachedLists() {
  return queryClient.getQueriesData<{ pages: ListPage[]; pageParams: unknown[] }>({ queryKey: ['list'] });
}
