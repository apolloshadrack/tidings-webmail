# syntax=docker/dockerfile:1.7
# Tidings — open-source webmail. Build: docker build -t tidings .
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="Tidings" \
      org.opencontainers.image.description="Fast, keyboard-first, privacy-respecting webmail for any IMAP server" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/apolloshadrack/tidings-webmail"
ENV NODE_ENV=production \
    TIDINGS_PORT=8080 \
    TIDINGS_BIND=0.0.0.0 \
    TIDINGS_DATA_DIR=/data \
    TIDINGS_WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown node:node /data \
 && printf '#!/bin/sh\nexec node /app/apps/server/dist/cli.js "$@"\n' > /usr/local/bin/tidings && chmod +x /usr/local/bin/tidings
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "const p=new URL(process.env.TIDINGS_PUBLIC_URL||'http://x/').pathname.replace(/\/$/,'');fetch('http://127.0.0.1:'+process.env.TIDINGS_PORT+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
