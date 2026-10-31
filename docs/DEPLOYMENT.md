# Deployment

Tidings is one container with one volume. Put it behind your existing TLS reverse proxy.

## Docker

```bash
docker run -d --name tidings --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v tidings-data:/data \
  -e TIDINGS_SECRET="$(openssl rand -base64 48)" \
  -e TIDINGS_PUBLIC_URL=https://mail.example.com/ \
  -e TIDINGS_IMAP_URL=imaps://mail.example.com:993 \
  -e TIDINGS_SMTP_URL=smtp://mail.example.com:587 \
  -e TIDINGS_SIEVE_URL=sieve://mail.example.com:4190 \
  -e TIDINGS_TRUSTED_PROXIES=172.16.0.0/12 \
  ghcr.io/apolloshadrack/tidings-webmail:latest
docker exec tidings tidings doctor
```

Keep the secret stable (store it in a file and use `TIDINGS_SECRET_FILE`); changing it signs everyone
out. See [`deploy/`](../deploy) for compose files, including one for docker-mailserver.

Tidings is single-instance by design: run one replica per data volume. If you need more, use sticky
sessions and separate volumes.

## Without Docker

```bash
npm ci && npm run build
NODE_ENV=production node --env-file=.env apps/server/dist/index.js
```

## Reverse proxy

Server-sent events need buffering disabled and a long read timeout. Tidings sends a heartbeat every
20 seconds.

### nginx, at the root

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 30m;
}
```

### nginx, under /webmail

Set `TIDINGS_PUBLIC_URL=https://example.com/webmail/`, and pass the path through unchanged (no
trailing slash on `proxy_pass`):

```nginx
location /webmail/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 30m;
}
```

### Caddy

```caddy
mail.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
    }
}
```

For a sub-path, use `handle /webmail/*` with the same `reverse_proxy` block. Don't use `handle_path`:
it strips the prefix, and Tidings expects it.

### Traefik (labels)

```yaml
labels:
  - traefik.http.routers.tidings.rule=Host(`mail.example.com`)
  - traefik.http.routers.tidings.tls.certresolver=letsencrypt
  - traefik.http.services.tidings.loadbalancer.server.port=8080
```

## Health checks

- `GET /healthz`: the process is up. Does not touch the mail server.
- `GET /readyz`: the database is writable.

Both live under the public path, so they're `/webmail/healthz` with a sub-path.

## Backups and upgrades

Everything stateful is in `/data`: `tidings.db` with settings, contacts, identities, drafts, the outbox
and the rebuildable mail index. Before each schema migration, Tidings writes a snapshot to
`/data/backups/`. It refuses to start on a database written by a newer version, so a downgrade cannot
corrupt your data: restore the matching snapshot instead.

## fail2ban

Failed sign-ins are logged as one JSON line with `"event":"login_failed"` and the client IP. A filter
and jail are in [`contrib/fail2ban/`](../contrib/fail2ban). Also configure Dovecot's
`login_trusted_networks` (see [CONFIGURATION.md](CONFIGURATION.md)).
