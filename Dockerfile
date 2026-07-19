FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The official node:alpine image already ships a non-root `node` user
# (uid 1000) — run as that instead of root, standard container hardening.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
EXPOSE 3000
# Alpine's busybox wget is already on the image — no extra package needed.
# Lets Docker/Compose/orchestrators see a hung-but-running process as
# unhealthy instead of just "up".
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
