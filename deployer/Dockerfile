# rainver deployer — host-level deployment supervisor
#
# Runs as a sidecar container in the Compose stack.
# This is the ONLY container with Docker socket access for deployment purposes.
# The server does not receive Docker socket access.
#
# Responsibilities: receive approved deploy jobs via Unix socket, run whitelisted
# scripts (rebuild/restart/health_check), return result.

FROM python:3.12-slim

# docker-cli — the client only. Debian 13 split the client out of `docker.io`,
#              which now ships the daemon and no /usr/bin/docker; this container
#              talks to the host daemon over the mounted socket and must never
#              run one of its own.
# curl       — fetches the compose plugin below
# No git: the deployer pulls published images and never touches a checkout.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    docker-cli \
    && rm -rf /var/lib/apt/lists/*

# docker compose plugin (v2), and buildx for reading a tag's manifest digest.
# `docker manifest inspect` cannot answer that question for an image index,
# which is what every buildx-published image is; see poll.py's _manifest_digest.
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL \
       https://github.com/docker/compose/releases/download/v2.24.7/docker-compose-linux-x86_64 \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
    && curl -fsSL \
       https://github.com/docker/buildx/releases/download/v0.29.1/buildx-v0.29.1.linux-amd64 \
       -o /usr/local/lib/docker/cli-plugins/docker-buildx \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

WORKDIR /deployer
COPY deployer.py protocol.py poll.py ./
COPY scripts/ ./scripts/
RUN chmod +x scripts/*.sh

# /repo/ops — read-only ops mount from docker-compose (compose files + scripts).
# The mode root is mounted at its host path (see the compose deployer service),
# so this image declares no fixed instance path.
# The socket stays private to this privileged container. Product runtimes and
# agent subprocesses must not be able to submit host-equivalent jobs directly.
ENV DEPLOYER_SOCKET=/tmp/rainver-deployer.sock
ENV REPO_ROOT=/repo

# Non-root user matching server (uid 1000) so socket files are accessible to both
RUN useradd -m -u 1000 deployer && chown -R deployer /deployer
USER deployer

CMD ["python", "deployer.py"]
