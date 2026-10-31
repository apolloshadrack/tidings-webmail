# Tidings — product & technical spec (v1)

Tidings is an open-source (AGPL-3.0-or-later, with a branding exception) self-hosted **webmail client**:
a modern alternative to Roundcube. It speaks IMAP, SMTP and ManageSieve to the mail server you already
run (Dovecot, Stalwart, Cyrus, docker-mailserver, Mailcow, Mailu). **It is not a mail server.**

Goal: Superhuman-grade speed and keyboard flow, Gmail-grade familiarity, Proton-grade privacy defaults,
with Roundcube-grade ease of deployment (one container, one volume, env vars).

> v0 of this spec was attacked by three adversarial critics (power user, security/standards engineer,
> self-hosting admin). Every decision below marked *(C)* came out of that review.

## 1. Architecture
- **Server**: Node ≥ 22.13 (image pins Node 24 LTS), Fastify, TypeScript. `imapflow`, `mailparser`,
  `nodemailer`, `better-sqlite3` behind a thin repository module. One process, one port, one `/data` volume.
- **Web**: Vite + React + TypeScript SPA, TanStack Query, virtualized list. Built once; the public base
  path is injected at runtime so the same image works at `/` or `/webmail` *(C)*.
- **Local metadata index** *(C)*: per user, SQLite stores envelope, flags, Message-ID, References,
  INTERNALDATE, size, has-attachment, preview snippet, List-Unsubscribe and a computed thread id for every
  message in subscribed folders. Bodies are NOT stored. Synced incrementally with CONDSTORE (HIGHESTMODSEQ)
  when available, otherwise a UID/FLAGS rescan; rebuilt when UIDVALIDITY changes. Lists, threads, sorting,
  counts and header search are served from the index, so they are fast regardless of IMAP server speed.
- **Connections** *(C)*: pooled **per user, not per session**, hard cap 2 (one command connection plus one
  IDLE connection only while a browser is listening). Events fan out to all tabs over SSE with
  `Last-Event-ID` resume, a 20s heartbeat and `X-Accel-Buffering: no`. Other folders are polled with STATUS.
- **Single instance by design** *(C)*: more than one replica needs sticky sessions; never put `/data` on NFS.

## 2. Security model *(C)*
- Login with IMAP credentials. The password is encrypted with AES-256-GCM using a key derived from the
  server secret and a random per-session key that only the browser's cookie holds. A server disk leak alone
  cannot decrypt credentials. The server can only act for a user while that user has a live session, so
  there is **no unattended send-later and no Web Push in v1**.
- Session cookie `__Host-`-style when at root (httpOnly, Secure, SameSite=Lax); session id rotated on
  login; idle and absolute lifetimes configurable; logout destroys server state and closes IMAP.
- CSRF: every mutating request needs the `X-Tidings-CSRF` header matching the session token.
- Login throttling per IP and per username; fail2ban-friendly log line; the real client IP is passed to
  Dovecot via IMAP `ID` (`x-originating-ip`) so the mail server's fail2ban does not ban the webmail host.
- IMAP/SMTP/Sieve hosts come only from admin config, never from the user (no SSRF via login form).
- From addresses are restricted to admin-allowed identities (login address plus configured aliases unless
  `TIDINGS_ALLOW_CUSTOM_FROM=true`). Header values are CRLF-stripped.
- HTML mail: sanitized server-side with an allow-list; rendered in a sandboxed iframe with no scripts, a
  strict CSP, remote content blocked by default and loaded through a server-side image proxy when allowed;
  `cid:` images served from the API; attachments are served with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff` and a sandbox CSP, never inline as active content.
- Strict app CSP, `frame-ancestors 'none'`, no third-party assets (fonts are self-hosted), no telemetry.

## 3. UX — borrowed from the best
**From Superhuman**
- Keyboard-first everything, a ⌘K command palette that can perform any action, `?` cheat sheet.
- **Split inbox**: configurable tabs over the inbox defined by search queries (e.g. "Newsletters" =
  has List-Unsubscribe, "VIP" = from: a list, "Team" = from:@company.com).
- **Snooze / remind me** ("tomorrow morning", "next week", custom): moves to a Snoozed folder and returns
  to the inbox, marked unread, the next time you are online after the due time (honest about the limit).
- **Snippets**: reusable text templates insertable in the composer with `;`/palette.
- **Sender sidebar**: who this is, recent conversations with them, shared attachments — all from the index.
- **Inbox zero** moment, instant optimistic actions, undo for everything.

**From Gmail**
- Gmail-compatible shortcut map (with the `u` / `Shift+U` mapping done correctly).
- Conversation view with collapsed older messages; conversations or messages mode.
- Search operators with chips and autocomplete; hover actions on rows; stars.
- **Manage subscriptions**: every sender with List-Unsubscribe, grouped, with message counts and one-click
  RFC 8058 unsubscribe.
- Undo send (persisted outbox), "forgot the attachment?" check, reply-all that removes yourself.

**From Proton Mail**
- Privacy by default: remote images blocked, **tracker counter** ("3 trackers blocked"), image proxy,
  link confirmation showing the real destination and flagging text/href mismatch.
- **Themes and layout control**: several first-class themes, accent colour, density, font size, layout
  (columns / rows / list-only), conversation toggle, folder colours.
- Block sender, report phishing → Junk, clean and calm visual hierarchy.

## 4. Interaction rules *(C)*
- **Cursor vs selection**: cursor is the focused row, selection is checked rows. Actions apply to the
  selection if any, else the cursor.
- **After archive/delete/move**: setting next (older, default) / previous (newer) / back to list. The cursor
  takes the slot of the removed row; never jumps to top. Live-inserted mail never moves the cursor; a
  "N new" pill appears when scrolled.
- **Undo**: `z` undoes the last action (stack of 10, works after the toast is gone). Moves record the new
  UID (UIDPLUS COPYUID, fallback Message-ID search). Failed optimistic actions restore rows with a
  persistent Retry toast. Permanent deletes (in Trash/Junk, empty folder) confirm instead of undo.
- **Mark as read**: timer starts on display (default 0.8s, configurable or "manual"); cancelled if the
  cursor moves first. Bodies are prefetched for next 3 / previous 1 rows using BODY.PEEK.
- **Latency budgets** (p95): j/k < 16 ms, open prefetched < 50 ms, cold open < 300 ms LAN, archive row
  removal < 16 ms, folder switch from index < 100 ms.
- **Keyboard**: matched on `event.key`; two-key sequences (`g i`) time out at 1s and are disabled while an
  input is focused; Delete/Backspace alias `#`; keydown is forwarded out of the message iframe; ⌘K in the
  composer inserts a link (palette is ⌘⇧K there); ⌘/Ctrl+Enter sends; Esc minimises the composer, never
  discards.
- **Shortcuts**: j/k, o/Enter, u back, e archive, # delete, ! spam, v move-to, l label/folder colour, s star,
  Shift+I / Shift+U read/unread, x select, r/a/f reply/all/forward, c compose, / search, z undo, h snooze,
  ⌘K palette, g i/s/d/t/a/l jumps, ; expand all, n/p within conversation, ? help.

## 5. Reading
- Conversation threading (JWZ over References/In-Reply-To with subject fallback), forced off in Drafts,
  Sent and Trash. Opening a thread expands unread + last message, scrolls to first unread.
- Auto-height sandboxed iframe; wide newsletters scroll inside the frame; optional dark transform with
  "original colours" toggle; quoted text collapsed; plain text with format=flowed and monospace toggle.
- Attachment strip with image thumbnails, download, "download all"; "show original" (raw source);
  export .eml; print view.
- Mislabelled charsets handled by mailparser/iconv; encrypted/signed parts shown as attachments.

## 6. Composer
- Docked panel (desktop, up to 3 stacked, minimise), full screen on mobile, inline reply.
- Rich text and true plain text; paste/drag attachments; recipient chips with frecency autocomplete from
  sent mail + contacts; paste lists → chips.
- Identity auto-picked from whichever of your addresses received the message; per-identity signature
  (above quote when top-posting); correct In-Reply-To/References; Re:/Fwd: normalisation.
- Drafts are local-first (saved in SQLite 1s after typing stops) and synced to IMAP Drafts every 30s and
  on close (APPEND + delete previous copy, matched by `X-Tidings-Draft-ID`).
- Outbox: undo-send window (default 10s) persisted in SQLite, survives restarts while the session lives;
  failures show a sticky banner and reopen the draft. Sent copy appended unless the host saves it itself.

## 7. Search
- Tier 1 instant over the index: free text over from/to/subject/snippet plus `from: to: subject: in:
  is:unread is:starred has:attachment before: after: larger:`. Default scope all folders except
  Trash/Junk.
- Tier 2 body search via IMAP SEARCH TEXT, per folder, cancellable, progressive.

## 8. Mail rules (ManageSieve) *(C)*
- Vacation responder (dates, subject, body, addresses) and a simple rule builder (from/to/subject contains
  → move to / mark read / star / discard / forward). Tidings writes its own script `tidings` and never
  overwrites scripts it did not write without asking; raw script editor fallback. Hidden if no Sieve.

## 9. Customisation
- **Themes**: Daylight, Paper, Midnight, Carbon, Nord, Solarized, Rosé, Forest, High contrast (light and
  dark). Follow-system option picks a light and a dark theme.
- **Personalisation**: accent colour, density (comfortable/cozy/compact), font size, font (Inter or system),
  layout (columns/rows/list), show snippets/avatars, conversation mode, mark-read delay, after-action
  behaviour, undo-send delay, remote images policy, split-inbox tabs, folder colours, keyboard shortcuts
  on/off.
- **Admin branding** (per domain): product name, logo, accent, login message, support URL, custom CSS on a
  documented set of CSS variables.

## 10. Ops *(C)*
- All config is `TIDINGS_*`; secrets accept `*_FILE`. Hosts as URLs: `imaps://host:993`,
  `imap://host:143` (STARTTLS required unless loopback), `smtp://host:587`, `smtps://host:465`,
  `sieve://host:4190`; `TIDINGS_TLS_SERVERNAME` and `TIDINGS_TLS_INSECURE` (loud warning).
- `TIDINGS_PUBLIC_URL`, `TIDINGS_TRUSTED_PROXIES` (CIDR list; never trust-all).
- Numbered forward-only migrations with `schema_version`; snapshot before migrating; refuse to run on a
  newer schema.
- `/healthz`, `/readyz`; JSON logs; no PII in logs by default.
- `tidings doctor` CLI tests IMAP/SMTP/Sieve connectivity, TLS and capabilities.
- Docker image (non-root), compose files for dev (bundled Dovecot + SMTP sink) and docker-mailserver.
- Licence: AGPL-3.0-or-later with a §7 additional permission for branding assets, custom CSS and config;
  mandatory Source link in About; DCO for contributions.

## 11. Release plan
**v0.1 (this build)**: everything in sections 1–10 except the roadmap items below.

**Roadmap**: OIDC / XOAUTH2 login, TOTP 2FA, CardDAV + LDAP address books, Roundcube import tool,
multiple accounts per browser, password-change drivers, translations beyond English (Weblate), MDN read
receipts, TNEF, mbox export, Prometheus metrics, signed multi-arch images, offline mode.

## Appendix A — binding security decisions *(C, from the security review)*
1. **Untrusted bytes never execute in the app origin.** Parts/attachments are served with `nosniff`,
   `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`. They are
   `inline` only when a magic-byte sniff says png/jpeg/gif/webp; everything else (HTML, SVG, XML, PDF,
   rfc822, unknown) is `attachment` + `application/octet-stream`. Filenames are RFC 2231/2047 decoded,
   stripped of controls/bidi/path characters, and emitted with an ASCII fallback plus `filename*`.
2. **Mail HTML is sanitized in the browser with DOMPurify** (same parser that renders) and shown in
   `<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc>`, whose
   document carries its own meta CSP (`default-src 'none'; script-src 'none'; style-src 'unsafe-inline';
   img-src data: blob:` — plus the image-proxy path only when the user allows images). A test asserts the
   sandbox string; `allow-scripts` is banned from the repo. Forbidden tags include form, input, button,
   meta, link, base, script, iframe, object, embed, svg, math, template, video, audio; forbidden attributes
   include srcset, ping, action, formaction, poster. Links get `target=_blank rel="noopener noreferrer"`
   and only http(s)/mailto/tel hrefs survive. CSS `@import`/`@font-face` and `url()` (unless proxied) dropped.
3. **Quoted HTML in the composer** is parsed only via inert `DOMParser` after DOMPurify, then into a
   schema-whitelisting editor (TipTap). `dangerouslySetInnerHTML` is allowed in exactly one component.
4. **nodemailer** runs with `disableFileAccess` and `disableUrlAccess`; the message object is built from an
   allow-list; never `envelope`, `raw` or client headers. Control characters and U+2028/9 are stripped from
   every header value. In-Reply-To/References are derived server-side from the original message.
5. **Identity policy** `TIDINGS_IDENTITY_POLICY=login-only|aliases|free` (default login-only). Envelope
   MAIL FROM is always the login. A per-user recipient cap per message and per day.
6. **Egress** (image proxy, one-click unsubscribe) goes through one module: http(s) on 80/443 only, every
   resolved IP checked against private/reserved ranges (blocks DNS rebinding), ≤ 3 re-validated redirects,
   timeouts, size cap, no cookies/referrer. Proxy URLs are HMAC-signed per user. Unsubscribe POSTs only
   when `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is present, after user confirmation.
7. **Login** is rate-limited per IP and per (username, IP) with progressive delay; one generic error;
   usernames/passwords length- and control-character-checked.
8. **Sessions**: 32-byte random token in an HttpOnly cookie; DB stores only `HMAC(secret, token)`;
   credential key = HKDF(token, salt from secret, info includes sid); AES-256-GCM with AAD binding the row.
   Logout is POST, deletes the row, closes connections, sends `Clear-Site-Data`. This protects against
   database/backup theft, not against a compromised running server.
9. **Outbox**: final MIME persisted (encrypted under the session key) before the send call returns; the
   Message-ID is the idempotency key; after a restart queued items are never sent late automatically —
   the user is asked "Send / Discard". A Sent-copy failure is reported as "sent, copy failed".
10. **Mutations** carry `{mailbox, uidValidity, uids}`; a UIDVALIDITY mismatch returns 409 and the client
    resyncs. MOVE is used when available; the fallback is UID COPY + UID STORE \Deleted + **UID EXPUNGE
    only with UIDPLUS**. Plain EXPUNGE is never issued.
11. **CSRF/headers**: no CORS; mutations need the CSRF header, a same-origin `Origin`, and JSON/multipart
    content types. GET handlers have no side effects (BODY.PEEK everywhere). `X-Frame-Options: DENY`,
    `frame-ancestors 'none'`, COOP same-origin, HSTS on https, restrictive Permissions-Policy.
12. **Phishing UI**: show the real address for non-contacts, flag display names containing addresses, wrap
    names/subjects in `<bdi>` and strip bidi controls, show punycode for mixed-script domains, warn on link
    text/href host mismatch. Authentication-Results trusted only from `TIDINGS_TRUSTED_AUTHSERV_IDS`.
13. **Connections**: one manager per `(host, user)` shared across sessions; `BYE`/`[LIMIT]`/`[UNAVAILABLE]`
    back off; `[AUTHENTICATIONFAILED]` stops retries and ends that user's sessions.
14. **Sync**: store `{uidValidity, highestModseq (string), uidNext}` per mailbox; IDLE re-issued every
    ≤ 4 min; every reconnect triggers a CONDSTORE resync.
15. **Limits**: decoded HTML ≤ 5 MB, JSON body ≤ 1 MB, uploads streamed to disk with per-file and
    per-draft quotas; temp files swept on send, discard, logout and boot.
16. **Isolation**: `userKey = sha256(host:port \0 username)`; every repository query requires it; the data
    files are mode 0600; the service worker never caches `/api/*`; no message bodies in browser storage.
