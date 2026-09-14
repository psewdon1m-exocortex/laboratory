FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81

WORKDIR /app/services/api

COPY services/api/package*.json ./
RUN apk upgrade --no-cache \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY services/api/src ./src
COPY services/web/static /app/services/web/static
COPY data/defaults /app/defaults

RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production \
    LABORATORY_DATA_DIR=/app/data \
    LABORATORY_DEFAULTS_DIR=/app/defaults

USER node

HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.LABORATORY_LISTEN_PORT || '18380') + '/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
