# rainver deployer — host-level deployment supervisor
#
# Runs as a sidecar container in the Compose stack.
# This is the ONLY container with Docker socket access for deployment purposes.
# The server does not receive Docker socket access.
#
# Responsibilities: receive approved deploy jobs via Unix socket, run whitelisted
# scripts (rebuild/restart/health_check), return result.

FROM python:3.12-slim

# docker CLI — for running docker compose commands against the host daemon
# curl     — used in health_check.sh
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# docker compose plugin (v2)
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL \
       https://github.com/docker/compose/releases/download/v2.24.7/docker-compose-linux-x86_64 \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

WORKDIR /deployer
COPY deployer.py protocol.py ./
COPY scripts/ ./scripts/
RUN chmod +x scripts/*.sh

# /repo — repo root mounted by docker-compose.yml (needed by deploy scripts)
# The socket stays private to this privileged container. Product runtimes and
# agent subprocesses must not be able to submit host-equivalent jobs directly.
ENV DEPLOYER_SOCKET=/tmp/rainver-deployer.sock
ENV REPO_ROOT=/repo

# Non-root user matching server (uid 1000) so socket files are accessible to both
RUN useradd -m -u 1000 deployer && chown -R deployer /deployer
RUN mkdir -p /rainver && chown deployer:deployer /rainver
USER deployer

CMD ["python", "deployer.py"]
