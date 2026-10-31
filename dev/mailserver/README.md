# Tidings dev mail stack

A local, unprivileged mail server for developing and testing Tidings. It runs as your own user, listens on
loopback only, and **cannot send mail to the internet**.

```bash
npm run mail:start   # start Dovecot + dev SMTP (idempotent)
npm run mail:seed    # add fixture mail (skips if already seeded; add -- --force to re-seed)
npm run mail:reset   # wipe everything, start, seed
npm run mail:stop
```

Requires Dovecot 2.4 with Pigeonhole (`brew install dovecot` on macOS). Set `DOVECOT_PREFIX` if it lives
elsewhere. All runtime state (config, maildirs, logs, pid files, captured outbound mail) lives in `run/`,
which is gitignored.

## Ports (127.0.0.1 only)

| Service      | Port  | Notes                                                        |
|--------------|-------|--------------------------------------------------------------|
| IMAP         | 1143  | plaintext (loopback only), AUTH PLAIN/LOGIN                  |
| SMTP submit  | 2525  | Node `smtp-server`; AUTH PLAIN/LOGIN; no STARTTLS            |
| ManageSieve  | 14190 | Pigeonhole; plaintext; vacation, fileinto, include, date …   |
| LMTP         | 12024 | internal: SMTP → Dovecot delivery, runs Sieve                |

## Accounts

`alice@tidings.test`, `bob@tidings.test`, `carol@tidings.test`, all with password `tidings-dev`
(see `users.example`). Alice holds the fixtures.

## Tidings configuration

```bash
TIDINGS_IMAP_URL=imap://127.0.0.1:1143?tls=none
TIDINGS_SMTP_URL=smtp://127.0.0.1:2525?tls=none
TIDINGS_SIEVE_URL=sieve://127.0.0.1:14190?tls=none
TIDINGS_DEFAULT_DOMAIN=tidings.test
```

## Delivery rules of the dev SMTP

- Recipients `@tidings.test` are delivered to Dovecot over LMTP (so Sieve filters and vacation replies run).
- Every other recipient is written to `run/outbound/*.eml` and dropped. Nothing is ever relayed.
- An authenticated user may only use their own address as envelope sender (like Postfix
  `reject_sender_login_mismatch`).
- Unauthenticated submissions are accepted from loopback so Dovecot's vacation/redirect messages can be sent.

## Fixtures (seed.mjs)

Ordinary fixtures for alice, dated over the last ~60 days:
- a 7-message work thread across INBOX and Sent (plus one reply delivered through SMTP), shorter threads
- newsletters with `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, remote images,
  1×1 tracking pixels and `utm_` links (one newsletter uses real `picsum.photos` images to exercise the image proxy)
- attachments: PDF, PNG, inline `cid:` image, a .docx-like file
- international: Hebrew RTL HTML, windows-1252 bytes labelled iso-8859-1, ISO-2022-JP Japanese, a long
  format=flowed plain-text message with nested quotes
- flagged / unread / answered mixes; mail in Junk, Trash, Archive, Receipts, Travel
- `Projects/2025 Archive`: 2,500 generated messages (with some threads) for performance testing

**Security fixtures** (subjects start with `[Security fixture]`) — nothing in them may execute or load:
- HTML soup: `<script>`, `onerror`, `javascript:`/`data:` links, `<form>`, `<iframe>`, `<svg onload>`, `<math>`,
  `<object>`/`<embed>`, CSS `@import`/`@font-face`/`url()`/`:hover` tracking, `srcset`, `ping`, `poster`,
  `<meta refresh>`, `<base href>`, a noscript mXSS payload
- phishing: display name `security@bank.example` on `phish@evil.example`, link text vs href mismatch,
  a Cyrillic homograph domain, an RLO character in the body
- attachments: SVG with `<script>`, HTML with `<script>`, an RLO-spoofed `report‮fdp.exe` filename,
  and an HTML document labelled `image/png` (must not sniff as an image)

## Known quirks

- macOS refuses Dovecot's RLIMIT_NPROC change for unprivileged users; the log line
  `setrlimit(RLIMIT_NPROC, …): Operation not permitted` is harmless.
- `default_vsz_limit` is set to 2^63−1 bytes because macOS only accepts "infinity" for RLIMIT_DATA.
