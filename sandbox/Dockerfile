# rainver-sandbox-runner — the instance's built-in execution host
#
# Build context: the REPO ROOT, because the daemon is installed together with
# its workspace packages from the repository pnpm workspace. Compose sets
# `context: ../../` and `dockerfile: sandbox/Dockerfile`.
#
# This container runs `rainver-host` — the same daemon a paired personal
# machine runs — in **strict** mode: it registers itself with the control plane
# using the credential the server publishes into the shared mount, and wraps
# every Run in its own rootless bubblewrap namespace — one execution protocol
# for every host (see .agent/decisions/0016-control-plane-execution-hosts.md).
# The private Runner protocol it replaced is gone; this container has one
# process.
#
# Vendor CLIs are not baked in. The daemon installs a managed copy on the
# instance admin's request, into its own config directory.

# ---- deps: workspace install + build the packages the daemon depends on -------
FROM node:24.18.0-slim AS deps
WORKDIR /app

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PNPM_CONFIG_FETCH_RETRIES=5 \
    PNPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN corepack enable

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/agent-cli/package.json ./packages/agent-cli/
COPY packages/folder-read/package.json ./packages/folder-read/
COPY packages/outbound-guard/package.json ./packages/outbound-guard/
COPY packages/host-daemon/package.json ./packages/host-daemon/
RUN pnpm install --frozen-lockfile \
    --filter @rainver/protocol \
    --filter @rainver/agent-cli \
    --filter @rainver/folder-read \
    --filter @rainver/outbound-guard \
    --filter @rainver/host-daemon

COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.build.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
RUN pnpm --filter @rainver/protocol build
COPY packages/agent-cli/tsconfig.json packages/agent-cli/tsconfig.build.json ./packages/agent-cli/
COPY packages/agent-cli/src ./packages/agent-cli/src
RUN pnpm --filter @rainver/agent-cli build
COPY packages/folder-read/tsconfig.json packages/folder-read/tsconfig.build.json ./packages/folder-read/
COPY packages/folder-read/src ./packages/folder-read/src
RUN pnpm --filter @rainver/folder-read build
# The one outbound boundary: the block list and the pinned-address fetch the
# control plane's Source fetches go through.
COPY packages/outbound-guard/tsconfig.json packages/outbound-guard/tsconfig.build.json ./packages/outbound-guard/
COPY packages/outbound-guard/src ./packages/outbound-guard/src
RUN pnpm --filter @rainver/outbound-guard build
COPY packages/host-daemon/tsconfig.json packages/host-daemon/tsconfig.build.json ./packages/host-daemon/
COPY packages/host-daemon/src ./packages/host-daemon/src
RUN pnpm --filter @rainver/host-daemon build

# ---- runtime -----------------------------------------------------------------
FROM node:24.18.0-slim

# bubblewrap builds the per-Run namespace; `script` gives the daemon a PTY for
# an interactive vendor login without a native addon to compile. git, curl and
# python are what an agent ordinarily reaches for inside its workspace.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap \
    util-linux \
    git \
    curl \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The Node base image ships UID 1000 as `node`; reuse it rather than claiming
# another. Runs execute as this user, never as root.
RUN usermod -l sandbox -d /home/sandbox -m node \
    && groupmod -n sandbox node

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Each package brings its own `node_modules` as well as the workspace root's:
# pnpm resolves a dependency (protocol's `zod`, say) through the package's own
# tree, and a daemon that starts without it fails at the first import.
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY --from=deps /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY packages/agent-cli/package.json ./packages/agent-cli/package.json
COPY --from=deps /app/packages/agent-cli/dist ./packages/agent-cli/dist
COPY packages/folder-read/package.json ./packages/folder-read/package.json
COPY --from=deps /app/packages/folder-read/dist ./packages/folder-read/dist
COPY packages/outbound-guard/package.json ./packages/outbound-guard/package.json
COPY --from=deps /app/packages/outbound-guard/dist ./packages/outbound-guard/dist
COPY packages/host-daemon/package.json ./packages/host-daemon/package.json
COPY --from=deps /app/packages/host-daemon/dist ./packages/host-daemon/dist
COPY --from=deps /app/packages/host-daemon/node_modules ./packages/host-daemon/node_modules

# Everything the daemon owns lives under one persisted mount: its registration,
# managed copies of runtimes, each Agent's runtime profile, managed workspaces,
# and the per-Run directories. Workspaces are the instance's own root, the same
# directory the control plane creates a server Location under.
RUN mkdir -p /runner/host /runner/workspaces /runner/builtin-host /home/sandbox \
    && chown -R sandbox:sandbox /runner /home/sandbox

USER sandbox
# HOME lives on the daemon's persisted mount, not on the container's read-only
# root: a strict Run's HOME is bound read-write into its namespace, and
# `/home/sandbox` is not writable here. The entrypoint creates it, because a
# volume is empty until the container runs.
ENV HOME=/runner/host/home \
    RAINVER_HOST_CONFIG_DIR=/runner/host \
    RAINVER_HOST_WORKSPACES_ROOT=/runner/workspaces \
    RAINVER_BUILTIN_HOST_CREDENTIAL=/runner/builtin-host/registration.json

CMD ["node", "/app/packages/host-daemon/dist/daemon.js"]
