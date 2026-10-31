# Configuration

Tidings is configured entirely with environment variables. Any secret can instead be read from a file
by appending `_FILE` (for example `TIDINGS_SECRET_FILE=/run/secrets/tidings`), which suits Docker and
Kubernetes secrets.

## Required

| Variable | Example | Notes |
|---|---|---|
| `TIDINGS_SECRET` | `openssl rand -base64 48` | At least 32 characters. Changing it signs everyone out. |
| `TIDINGS_PUBLIC_URL` | `https://mail.example.com/webmail/` | The URL users open. Sets cookie path, CSRF origin and sub-path. |
| `TIDINGS_IMAP_URL` | `imaps://mail.example.com:993` | `imap://` uses STARTTLS (required) on 143. |
| `TIDINGS_SMTP_URL` | `smtp://mail.example.com:587` | `smtp://` = submission with STARTTLS; `smtps://` = 465. |

Endpoint URLs accept `?servername=` (verify the certificate for a different name than the host you
connect to, for example inside a compose network) and `?tls=none` (plaintext, **loopback only**).

## Optional

| Variable | Default | Notes |
|---|---|---|
| `TIDINGS_SIEVE_URL` | — | `sieve://host:4190` enables filters and vacation replies. |
| `TIDINGS_DEFAULT_DOMAIN` | — | Lets users sign in with only the part before `@`. |
| `TIDINGS_PORT` / `TIDINGS_BIND` | `5300` / `0.0.0.0` | The Docker image uses port 8080. |
| `TIDINGS_DATA_DIR` | `./data` | Holds the SQLite database, backups and temporary uploads. Do not put it on NFS. |
| `TIDINGS_TRUSTED_PROXIES` | — | Comma-separated CIDRs whose `X-Forwarded-*` headers are trusted. Never trust everyone. |
| `TIDINGS_IDENTITY_POLICY` | `login-only` | `login-only`, `aliases` (from `TIDINGS_ALIASES`) or `free`. `free` lets users send as anyone your SMTP server accepts. |
| `TIDINGS_ALIASES` | — | `alice@ex.com=sales@ex.com|info@ex.com;bob@ex.com=b@ex.com` |
| `TIDINGS_SAVE_SENT` | `auto` | `auto` skips the Sent copy on Gmail (which saves it itself); `append`; `never`. |
| `TIDINGS_SESSION_IDLE_MINUTES` | `1440` | Public-computer sessions always expire after 30 idle minutes. |
| `TIDINGS_SESSION_MAX_DAYS` | `14` | |
| `TIDINGS_MAX_UPLOAD_MB` | `25` | Per message. Check your SMTP server's size limit too. |
| `TIDINGS_MAX_RECIPIENTS` | `100` | Per message. |
| `TIDINGS_MAX_MESSAGES_PER_DAY` | `500` | Per user; limits damage from a compromised account. |
| `TIDINGS_TRUSTED_AUTHSERV_IDS` | — | Your MTA's `Authentication-Results` id(s); enables DKIM-based warnings and one-click unsubscribe checks. |
| `TIDINGS_TLS_INSECURE` | `false` | Skip certificate verification. Logs a loud warning. Prefer `TIDINGS_CA_FILE`. |
| `TIDINGS_CA_FILE` | — | PEM bundle for a private CA. |
| `TIDINGS_EGRESS_ALLOW_PRIVATE` | `false` | Allow the image proxy to reach private networks. Leave off. |
| `TIDINGS_LOG_LEVEL` | `info` | JSON logs to stdout. Passwords, cookies and message content are never logged. |
| `TIDINGS_SOURCE_URL` | upstream repo | The AGPL "Source code" link. Point it at your fork if you modify Tidings. |

## Branding

| Variable | Notes |
|---|---|
| `TIDINGS_BRAND_NAME` | Product name in the title bar, sidebar and sign-in page. |
| `TIDINGS_BRAND_LOGO_URL` | Logo shown instead of the Tidings mark. |
| `TIDINGS_BRAND_ACCENT` | Default accent colour (`#rrggbb`) for users who have not picked one. |
| `TIDINGS_BRAND_LOGIN_MESSAGE` | One line under the sign-in heading. |
| `TIDINGS_BRAND_SUPPORT_URL` | "Trouble signing in?" link. |
| `TIDINGS_CUSTOM_CSS_FILE` | Path to a CSS file served to every user. See [THEMING.md](THEMING.md). |

## Mail server tips

- **Dovecot:** add the Tidings host to `login_trusted_networks` so Dovecot accepts the real client IP
  that Tidings forwards with the IMAP `ID` command. Its auth penalties and your fail2ban then target the
  attacker, not Tidings.
- **Connection limits:** Tidings uses at most three IMAP connections per user, however many tabs and
  devices they have open. Dovecot's default of 10 per user and IP is enough.
- Run `tidings doctor` (or `docker exec <container> tidings doctor --user you@example.com
  --password-file /path`) to check connectivity, TLS and server capabilities.
