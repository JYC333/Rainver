"""
Shared protocol definitions for the deployer Unix socket interface.

The same file is importable by both the deployer process and the server client.
Wire format: one JSON object per line (newline-delimited JSON).
"""
from __future__ import annotations
from typing import Literal

# ── Core deployment jobs ──────────────────────────────────────────────────────

CoreJobType = Literal[
    "rebuild_rainver",   # docker compose build + up -d server frontend
    "restart_rainver",   # docker compose restart server frontend
    "health_check",          # server /health check
]

JobType = CoreJobType

#: The Unix socket allowlist. Exactly these three, no request arguments (B43).
ALLOWED_JOB_TYPES: set[str] = {
    *[v for v in CoreJobType.__args__],
}

# ── Instance update pull loop (ADR 0020) ─────────────────────────────────────
#
# A second entry, not a widening of the first: the deployer *pulls* these from
# the server over the internal-token channel. They never reach the socket
# allowlist above, and neither takes caller arguments.

PullJobType = Literal[
    "update",        # pull, drain, dump+migrate, recreate, health
    "check_update",  # read the digest the configured tag points at
]

PULL_JOB_TYPES: set[str] = {
    *[v for v in PullJobType.__args__],
}
