FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

WORKDIR /app/services/api

COPY services/api/package*.json ./
RUN npm ci --omit=dev

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
