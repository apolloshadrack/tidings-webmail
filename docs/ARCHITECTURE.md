# Architecture

```
browser (React SPA) ──HTTPS──▶ Tidings server (Node, Fastify) ──IMAP──▶ your mail server
        ▲   │                         │   │                    ──SMTP──▶
        │   └── SSE (live updates) ◀──┘   └── SQLite (/data)   ──ManageSieve──▶
```

Tidings is a single Node process that serves the web client and a JSON API. It keeps no mail bodies;
your mail server stays the source of truth.

## Server (`apps/server/src`)

| Path | Responsibility |
|---|---|
| `config.ts` | `TIDINGS_*` environment parsing, endpoint URLs, validation |
| `db/` | SQLite (better-sqlite3), forward-only migrations with automatic pre-migration snapshots |
| `lib/sessions.ts`, `lib/crypto.ts` | Sessions and credential encryption (HKDF + AES-256-GCM, split key) |
| `imap/account.ts` | One connection manager per user: two command connections plus IDLE while a browser listens |
| `imap/sync.ts` | The local metadata index: envelopes, flags, threads and previews, kept current with CONDSTORE |
| `imap/ops.ts` | Flag, move and delete operations, guarded by UIDVALIDITY, never a plain EXPUNGE |
| `imap/message.ts` | Fetches only the body parts it needs; an LRU of parsed bodies |
| `imap/realtime.ts` | IDLE → resync, STATUS polling for other folders, snooze wake-ups |
| `mail/outbox.ts` | Building MIME from an allow-list, encrypted persisted outbox, undo send, Sent copy |
| `mail/sieve.ts` | ManageSieve client and the round-trippable Tidings filter model |
| `lib/egress.ts` | The only path for fetching attacker-chosen URLs (image proxy, one-click unsubscribe) |
| `http/` | Routes, CSRF/origin checks, search parsing |
| `cli.ts` | `tidings doctor` |

### Why a local index?

IMAP alone cannot sort by date, thread across folders, or search headers instantly on large mailboxes.
Tidings indexes metadata (never bodies) in SQLite, so lists, conversations, counts and search
stay fast, whatever the mail server's speed. The index rebuilds itself when a folder's UIDVALIDITY
changes and can be deleted at any time.

## Web client (`apps/web/src`)

| Path | Responsibility |
|---|---|
| `state/ui.ts` | Cursor, selection, open conversation, composers, toasts, undo stack, dialogs |
| `state/settings.ts` | User preferences and the theme engine (tokens → CSS custom properties) |
| `state/queries.ts` | TanStack Query hooks for the API |
| `lib/actions.ts` | Every triage action: optimistic, undoable, rolled back on failure |
| `lib/keys.ts`, `lib/commands.ts` | Keyboard engine and the single command registry (shortcuts, palette, cheat sheet) |
| `lib/sanitize.ts`, `components/MessageFrame.tsx` | The only place untrusted HTML is rendered |
| `components/` | Shell, sidebar, list, reader, composer, dialogs, settings, pages |
