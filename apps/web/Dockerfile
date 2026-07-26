# agent-space Web UI — multi-stage build
#
# Build context: repo root
# Run via docker-compose in ops/compose/ — the compose file selects a stage
# with `build.target`:
#   - dev / test  → target: dev   (Vite dev server, hot reload, source mounted)
#   - prod        → target: prod  (static `dist` built by Vite, served by nginx)
#
# The default (last) stage is `prod`, so any build that forgets `target:` gets the
# production image rather than a dev server.

# ---- shared dependency layer ----------------------------------------------
FROM node:24.18.0-slim AS base

# npm retry config — guards against transient ECONNRESET in WSL2/Docker builds
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

WORKDIR /repo/apps/web

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci \
    && mkdir -p node_modules/.cache/agent-space \
    && sha256sum package.json package-lock.json \
      | sha256sum \
      | awk '{print $1}' > node_modules/.cache/agent-space/package-inputs.sha256

# ---- dev: Vite dev server -------------------------------------------------
# Source is bind-mounted by docker-compose, so we don't COPY it here. The PWA
# service worker is intentionally disabled in this stage (vite-plugin-pwa dev
# default), matching how the dev/test environments run.
FROM base AS dev

COPY apps/web/docker/dev-entrypoint.sh /usr/local/bin/web-dev-entrypoint
RUN chmod +x /usr/local/bin/web-dev-entrypoint

EXPOSE 5173

# The Vite proxy defaults to http://server:8010 inside the compose network.
ENTRYPOINT ["web-dev-entrypoint"]
CMD ["node_modules/.bin/vite"]

# ---- build: produce the static production bundle --------------------------
FROM base AS build

COPY apps/web ./
COPY plugins /repo/plugins
RUN npm run build

# ---- prod: serve the built bundle via nginx -------------------------------
# This is what makes the PWA installable: real `dist/` output (manifest +
# service worker + precached assets) served over a static web server.
FROM nginx:1.27-alpine AS prod

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
