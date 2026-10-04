FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
# Tests/eval aren't needed at runtime.
RUN rm -rf tests eval

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://localhost:${PORT:-8080}/" || exit 1

# API (and the in-process worker unless RUN_WORKER_IN_API=false).
# For a separate worker container use: CMD ["node", "worker.js"]
CMD ["node", "server.js"]
