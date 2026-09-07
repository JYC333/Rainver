#!/usr/bin/env python3
"""
rainver host deployer — Unix domain socket server.

Runs on the HOST (outside the main app container) and handles deployment
requests from the server. The server cannot restart itself; this process can.

Only core operator deployment jobs are accepted. Product code does not have
access to this socket.

Start:
    python deployer/deployer.py

Or via systemd — see deployer/README.md.

Socket path: $DEPLOYER_SOCKET or /tmp/rainver-deployer.sock
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import stat
from datetime import datetime, UTC
from pathlib import Path

from poll import build_poller
from protocol import ALLOWED_JOB_TYPES

log = logging.getLogger("deployer")

SCRIPT_DIR = Path(__file__).parent / "scripts"

JOB_SCRIPTS: dict[str, Path] = {
    "rebuild_rainver":          SCRIPT_DIR / "rebuild.sh",
    "restart_rainver":          SCRIPT_DIR / "restart.sh",
    "health_check":                 SCRIPT_DIR / "health_check.sh",
}


async def _run_script(script: Path, timeout: int = 300) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        str(script),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    return proc.returncode, stdout.decode(), stderr.decode()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername", "unknown")
    try:
        raw = await asyncio.wait_for(reader.readline(), timeout=10)
        request: dict = json.loads(raw)

        job_id   = request.get("job_id", "unknown")
        job_type = request.get("job_type", "")
        args     = request.get("args", {})

        log.info("job %s type=%s args=%s peer=%s", job_id, job_type, args, peer)

        if job_type not in ALLOWED_JOB_TYPES:
            result = {"job_id": job_id, "status": "failed",
                      "error": f"Unknown job_type '{job_type}'. Allowed: {sorted(ALLOWED_JOB_TYPES)}"}
            _write(writer, result)
            return

        if not isinstance(args, dict) or args:
            result = {"job_id": job_id, "status": "failed",
                      "error": f"job_type '{job_type}' does not accept request args"}
            _write(writer, result)
            return

        script = JOB_SCRIPTS[job_type]
        if not script.exists():
            result = {"job_id": job_id, "status": "failed",
                      "error": f"Script not found: {script}"}
            _write(writer, result)
            return

        started_at = datetime.now(UTC).isoformat()
        try:
            exit_code, stdout, stderr = await _run_script(script)
        except asyncio.TimeoutError:
            result = {"job_id": job_id, "status": "failed", "error": "Script timed out",
                      "started_at": started_at, "completed_at": datetime.now(UTC).isoformat()}
            _write(writer, result)
            return

        status = "succeeded" if exit_code == 0 else "failed"
        log.info("job %s finished status=%s exit_code=%d", job_id, status, exit_code)

        result = {
            "job_id":       job_id,
            "job_type":     job_type,
            "status":       status,
            "exit_code":    exit_code,
            "stdout":       stdout,
            "stderr":       stderr,
            "started_at":   started_at,
            "completed_at": datetime.now(UTC).isoformat(),
        }
        _write(writer, result)

    except json.JSONDecodeError as exc:
        _write(writer, {"status": "failed", "error": f"Invalid JSON: {exc}"})
    except Exception as exc:
        log.exception("unhandled error for job from %s", peer)
        try:
            _write(writer, {"status": "failed", "error": str(exc)})
        except Exception:
            pass
    finally:
        try:
            await writer.drain()
            writer.close()
        except Exception:
            pass


def _write(writer: asyncio.StreamWriter, obj: dict) -> None:
    writer.write(json.dumps(obj).encode() + b"\n")


async def main() -> None:
    socket_path = os.environ.get(
        "DEPLOYER_SOCKET",
        "/tmp/rainver-deployer.sock",
    )
    sock_file = Path(socket_path)
    sock_file.parent.mkdir(parents=True, exist_ok=True)

    if sock_file.exists():
        try:
            sock_file.unlink()
        except PermissionError:
            # Socket owned by another user (e.g. previous run as root) — try to use it anyway
            pass

    server = await asyncio.start_unix_server(handle_client, path=socket_path)
    os.chmod(socket_path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)

    log.info("deployer listening on %s", socket_path)

    # The instance-update pull loop runs beside the socket server. It is
    # configured by the generated .deployer.env; without it this container is
    # exactly the operator-only deployer it has always been.
    poller = build_poller()
    poll_task = asyncio.create_task(poller.run_forever()) if poller else None
    if poll_task is None:
        log.info("instance update pull loop disabled: DEPLOYER_SERVER_URL or SERVER_INTERNAL_TOKEN is unset")

    # Graceful shutdown on SIGTERM/SIGINT
    shutdown_event = asyncio.Event()

    async def shutdown() -> None:
        log.info("shutdown signal received, stopping server...")
        shutdown_event.set()
        server.close()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(shutdown()))

    # The pull loop is supervised, not fired and forgotten. If it ever ends on
    # its own the container would go on running — socket served, no heartbeat —
    # and nothing would notice or restart it: this container is the one thing
    # an instance update cannot recreate, so its restart policy is the only way
    # back. Ending the process hands the decision to that policy.
    stop = asyncio.create_task(shutdown_event.wait())
    await asyncio.wait(
        {stop, *([poll_task] if poll_task is not None else [])},
        return_when=asyncio.FIRST_COMPLETED,
    )
    loop_ended = poll_task is not None and poll_task.done()
    if loop_ended:
        assert poll_task is not None
        error = None if poll_task.cancelled() else poll_task.exception()
        log.error("instance update pull loop ended (%s); exiting so the container restarts", error)
        server.close()
    stop.cancel()
    if poll_task is not None and not poll_task.done():
        poll_task.cancel()
        try:
            await poll_task
        except asyncio.CancelledError:
            pass
    await server.wait_closed()
    log.info("deployer shutdown complete")
    if loop_ended:
        # Non-zero so `restart: unless-stopped` brings both entries back.
        raise SystemExit(1)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    asyncio.run(main())
