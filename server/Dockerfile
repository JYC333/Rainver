# rainver server — multi-stage build
#
# Build context: the REPO ROOT (not server), because the server and protocol are
# installed together from the repository pnpm workspace.
# Compose sets `context: ../../` and `dockerfile: server/Dockerfile`.
#
# This image serves the backend. The production image runs compiled JS
# (not tsx/ts-node).

# ---- deps: install workspace dependencies and build the protocol package ------
FROM node:24.18.0-slim AS deps
WORKDIR /app

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PNPM_CONFIG_FETCH_RETRIES=5 \
    PNPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN corepack enable

# Build toolchain for native modules (node-pty hosts the CLI login PTY).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/protocol/package.json ./packages/protocol/
COPY server/package.json ./server/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile \
    --filter @rainver/protocol \
    --filter @rainver/server

COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.build.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
RUN pnpm --filter @rainver/protocol build

# ---- build: compile TS -> dist ------------------------------------------------
FROM deps AS build
COPY server/tsconfig.json ./server/
COPY server/drizzle.config.ts ./server/
COPY server/drizzle ./server/drizzle
COPY server/src ./server/src
COPY server/migrations ./server/migrations
COPY server/scripts ./server/scripts
COPY plugins /app/plugins
RUN pnpm --filter @rainver/server schema:check
RUN pnpm --filter @rainver/server build

# ---- dev-runtime: full deps + writable dist for compose hot reload ------------
FROM deps AS dev-runtime
ENV NODE_ENV=development

COPY catalog /app/catalog
COPY server/tsconfig.json ./server/
COPY server/drizzle.config.ts ./server/
COPY server/drizzle ./server/drizzle
COPY server/scripts ./server/scripts
COPY server/src ./server/src
COPY server/migrations ./server/migrations
COPY plugins /app/plugins
COPY --from=build /app/server/dist /app/server/dist
WORKDIR /app/server

# CLI login helper processes need a writable HOME before their state is synced
# into the managed profile dir under RAINVER_HOME. Dev/test compose also
# runs TypeScript watch builds, so the compiled dist trees must be writable by
# the non-root runtime user.
RUN mkdir -p /home/node/.claude \
    && chown -R node:node /home/node /app/server/dist /app/packages/protocol/dist
USER node
ENV HOME=/home/node

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "fetch('http://localhost:8010/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]

# ---- prod-deps: production node_modules (with native builds) -------------------
FROM node:24.18.0-slim AS prod-deps
WORKDIR /app

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/protocol/package.json ./packages/protocol/
COPY server/package.json ./server/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --prod --frozen-lockfile \
    --filter @rainver/protocol \
    --filter @rainver/server

# ---- runtime: prod deps + compiled output -------------------------------------
FROM node:24.18.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY packages/protocol/package.json ./packages/protocol/package.json
COPY --from=deps /app/packages/protocol/dist ./packages/protocol/dist
# Built-in catalog definitions served read-only by the catalog module
# (default SERVER_CATALOG_ROOT resolves to /app/catalog).
COPY catalog ./catalog
COPY server/package.json ./server/package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
WORKDIR /app/server

COPY server/migrations ./migrations
COPY --from=build /app/server/dist ./dist

# CLI login helper processes need a writable HOME before their state is synced
# into the managed profile dir under RAINVER_HOME.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node
USER node
ENV HOME=/home/node

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "fetch('http://localhost:8010/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
