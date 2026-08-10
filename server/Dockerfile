# agent-space server — multi-stage build
#
# Build context: the REPO ROOT (not server), because the server package has a
# file: dependency on ../packages/protocol that must be present at install time.
# Compose sets `context: ../../` and `dockerfile: server/Dockerfile`.
#
# This image serves the backend. The production image runs compiled JS
# (not tsx/ts-node).

# ---- deps: install node_modules and build the local protocol package ----------
FROM node:24.18.0-slim AS deps
WORKDIR /app

ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

# Build toolchain for native modules (node-pty hosts the CLI login PTY).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.build.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src

COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci
RUN ln -s /app/server/node_modules ../packages/protocol/node_modules \
    && ./node_modules/.bin/tsc -p ../packages/protocol/tsconfig.build.json

# ---- build: compile TS -> dist ------------------------------------------------
FROM deps AS build
COPY server/tsconfig.json ./
COPY server/drizzle.config.ts ./
COPY server/drizzle ./drizzle
COPY server/src ./src
COPY server/migrations ./migrations
COPY server/scripts ./scripts
COPY plugins /app/plugins
RUN npm run schema:check
RUN npm run build

# ---- dev-runtime: full deps + writable dist for compose hot reload ------------
FROM deps AS dev-runtime
ENV NODE_ENV=development

COPY catalog /app/catalog
COPY server/tsconfig.json ./
COPY server/drizzle.config.ts ./
COPY server/drizzle ./drizzle
COPY server/scripts ./scripts
COPY server/src ./src
COPY server/migrations ./migrations
COPY plugins /app/plugins
COPY --from=build /app/server/dist ./dist

# CLI login helper processes need a writable HOME before their state is synced
# into the managed profile dir under AGENT_SPACE_HOME. Dev/test compose also
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

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY packages/protocol/package.json ./packages/protocol/package.json
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci --omit=dev

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
COPY server/package.json server/package-lock.json ./server/
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
WORKDIR /app/server
RUN ln -s /app/server/node_modules ../packages/protocol/node_modules

COPY server/migrations ./migrations
COPY --from=build /app/server/dist ./dist

# CLI login helper processes need a writable HOME before their state is synced
# into the managed profile dir under AGENT_SPACE_HOME.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node
USER node
ENV HOME=/home/node

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "fetch('http://localhost:8010/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
