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

ALLOWED_JOB_TYPES: set[str] = {
    *[v for v in CoreJobType.__args__],
}
