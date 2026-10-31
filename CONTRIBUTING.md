# Contributing to Tidings

Thanks for helping build a better webmail. Bug reports, fixes, translations and design feedback are
all welcome.

## Development setup

Requirements: Node.js 22.13+ and, for the bundled test mail server, Dovecot 2.4 with Pigeonhole
(`brew install dovecot` on macOS; `apt install dovecot-imapd dovecot-lmtpd dovecot-managesieved
dovecot-sieve` on Debian/Ubuntu).

```bash
npm install
npm run mail:reset            # local Dovecot + SMTP sink on 127.0.0.1, seeded with realistic mail
cp .env.example .env          # then use the dev values from dev/mailserver/README.md
npm run dev                   # API on :5300, web on :5304
```

Sign in at http://localhost:5304 as `alice@tidings.test` / `tidings-dev`. The dev mail server only
listens on loopback and cannot send mail to the internet. Its seed data includes security fixtures
(script-laden HTML, dangerous attachments, a phishing display name); keep them rendering safely.

## Before you open a pull request

```bash
npm run typecheck
npm test
npx tsx scripts/check-contrast.ts   # every theme must stay WCAG AA
node scripts/check-sandbox.mjs      # the message iframe must never gain allow-scripts
```

- Keep pull requests focused; explain the user-visible change and how you tested it.
- UI changes: include a before/after screenshot and check light and dark themes, the three densities
  and a 375px wide viewport.
- Anything touching HTML rendering, attachments, the image proxy, sessions or sending needs a test or a
  new fixture in `dev/mailserver/seed.mjs`.

## Sign-off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Sign
off every commit with `git commit -s`, which certifies you wrote the change or have the right to submit
it under the project licence.

## Where things live

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Good first issues are labelled
[`good first issue`](https://github.com/apolloshadrack/tidings-webmail/labels/good%20first%20issue).
