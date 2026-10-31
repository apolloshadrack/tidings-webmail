# Security policy

Webmail is a high-value target: historically, most serious webmail vulnerabilities have been in HTML
sanitisation and attachment handling. We treat reports in those areas as top priority.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub security advisories](https://github.com/apolloshadrack/tidings-webmail/security/advisories/new).
Include the Tidings version, a description, and a proof of concept (a sample `.eml` is ideal).

We aim to acknowledge reports within 3 working days and to ship a fix for critical issues within
14 days. We follow coordinated disclosure with a default 90-day window and will credit you unless you
prefer otherwise.

## Supported versions

Security fixes are released for the latest minor version and backported to the previous minor version.

## How Tidings defends itself

The binding design is in [docs/SPEC.md, Appendix A](docs/SPEC.md). In short:

- Mail HTML is sanitised in the browser with DOMPurify and rendered in a sandboxed iframe with no
  script permission and its own restrictive Content-Security-Policy. CI fails if the sandbox ever
  gains `allow-scripts` or if `dangerouslySetInnerHTML` appears in the client.
- Attachments are never rendered as active content in the Tidings origin: only magic-byte-verified
  raster images are served inline; everything else downloads as `application/octet-stream` with a
  sandbox CSP and `nosniff`.
- Remote images are blocked by default and, when allowed, fetched through a signed server-side proxy
  that refuses private and reserved addresses (DNS-rebinding safe) and hides the reader's IP.
- Passwords are encrypted at rest with a key that requires both the server secret and the browser's
  session cookie; the database alone cannot decrypt them. This does not protect against a compromised
  running server.
- Every state-changing request needs a CSRF token, a same-origin `Origin` and a JSON or multipart body.
- Outgoing mail is built from an allow-list of fields; `From` is restricted by the admin's identity
  policy; header values are stripped of control characters.
- IMAP mutations are guarded by UIDVALIDITY, and Tidings never issues a plain `EXPUNGE` that could
  destroy other clients' deleted mail.
