# agent-space-sandbox-runner — dedicated scoped CLI execution service
#
# This long-lived service has only the managed authority roots mounted by
# Compose. Each launch creates a fresh bubblewrap mount/PID namespace and
# exposes only the request's allowlisted ids to the vendor CLI.
#
# Build:
#   docker build -f sandbox/Dockerfile -t agent-space-sandbox .
#
# Vendor CLIs are not baked into this image. The Runner resolves one selected
# version below its read-only runtime-tools authority root.

FROM node:24.18.0-slim

# Install system tools agents commonly need
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap \
    git \
    curl \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Rename the built-in node user (UID 1000) to sandbox
# The Node base image ships with UID 1000 already claimed, so we reuse it.
RUN usermod -l sandbox -d /home/sandbox -m node \
    && groupmod -n sandbox node

WORKDIR /runner
COPY sandbox/runner.mjs /runner/runner.mjs
RUN mkdir -p /runner/workspaces /runner/sandboxes /runner/runtime-tools /runner/run-homes /runner/conversation-homes /runner/login-homes \
    && chown -R sandbox:sandbox /runner

USER sandbox

EXPOSE 8020
CMD ["node", "/runner/runner.mjs"]
