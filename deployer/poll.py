"""
Instance update pull loop (ADR 0020).

The deployer polls the server over the Compose network with the internal
token, reports what it can see through docker.sock, and executes the job it is
handed. This is a second entry beside the Unix socket, not a widening of it: it
carries exactly two job types, `update` and `check_update`, and neither takes
caller arguments. The server never pushes into this container and never gains
Docker authority itself.

Every stage is reported as it happens. Because the `recreate` stage restarts
the server, a report may have to wait for its own control plane to come back —
posting an event retries across that gap rather than losing the job's audit.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import signal
import socket
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Awaitable, Callable

from protocol import PULL_JOB_TYPES

log = logging.getLogger("deployer.poll")

SCRIPT_DIR = Path(__file__).parent / "scripts"
UPDATE_SCRIPT = SCRIPT_DIR / "update.sh"

POLL_INTERVAL_SECONDS = 30
REMOTE_CHECK_INTERVAL_SECONDS = 24 * 60 * 60
#: A failed registry read is retried well before the daily cadence, but not on
#: every heartbeat: a registry that is down stays down for more than a minute.
REMOTE_CHECK_RETRY_SECONDS = 15 * 60
DRAIN_POLL_SECONDS = 5
LOG_TAIL_BYTES = 8 * 1024
#: A stage reports nothing between its `started` and terminal event, so this
#: must stay well inside the server's lost-deployer threshold (60 minutes);
#: otherwise a slow pull would be swept while it is still working.
STAGE_TIMEOUT_SECONDS = 30 * 60
INTERNAL_TOKEN_HEADER = "x-rainver-internal-token"

#: The services an update recreates. The deployer is deliberately absent: it
#: does not update itself, and its own image changes only when a person runs
#: start.sh on the host (ADR 0020 section 6).
RECREATE_SERVICES = ("server", "frontend", "sandbox-runner")

#: The services whose running image the heartbeat reports. The deployer is
#: included because a person needs to see that its own image did not move.
OBSERVED_SERVICES = ("server", "frontend", "sandbox-runner", "deployer")

#: The update stages, in order. `backup` is not separate: migrate.sh takes the
#: required dump and refuses to migrate on a failed one, so it is one stage
#: whose log tail carries the dump path.
UPDATE_STAGES = ("pull", "drain", "migrate", "recreate", "health")

CommandRunner = Callable[..., Awaitable[tuple[int, str, str]]]


def tail(text: str, limit: int = LOG_TAIL_BYTES) -> str | None:
    """The end of a stage's output, bounded, on a character boundary."""
    if not text:
        return None
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text
    return encoded[-limit:].decode("utf-8", errors="ignore")


def _kill_process_group(process: asyncio.subprocess.Process) -> None:
    """
    Kill the whole group, not just the process that was started.

    A stage is `update.sh`, and the work is the `docker compose` it starts.
    Killing only the shell would leave a pull, a migration or a recreate
    running against the instance after the job was recorded as failed — and a
    later update could then run a second migration beside it.
    """
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()


async def run_command(*args: str, timeout: int = 120, env: dict[str, str] | None = None) -> tuple[int, str, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            # Its own session, so the whole tree can be killed together.
            start_new_session=True,
        )
    except OSError as error:
        # A missing or unexecutable binary is this command's failure, not the
        # loop's: every caller reads the exit code.
        return 127, "", f"{args[0]}: {error}"
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        _kill_process_group(process)
        await process.wait()
        return 124, "", f"command timed out after {timeout}s: {' '.join(args)}"
    except asyncio.CancelledError:
        # Shutdown: do not leave the stage's work behind, still changing the
        # instance while nothing is reporting it.
        _kill_process_group(process)
        await process.wait()
        raise
    return process.returncode or 0, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


class ServerClient:
    """The internal channel to the server. Nothing here can create a job."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                INTERNAL_TOKEN_HEADER: self.token,
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read().decode("utf-8")
        return json.loads(payload) if payload else {}

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._request, method, path, body)

    async def heartbeat(self, observation: dict[str, Any]) -> dict[str, Any] | None:
        response = await self.request("POST", "/internal/deployment/heartbeat", observation)
        return response.get("job")

    async def post_event(self, job_id: str, event: dict[str, Any]) -> None:
        await self.request("POST", f"/internal/deployment/jobs/{job_id}/events", event)

    async def running_runs(self) -> int:
        response = await self.request("GET", "/internal/deployment/drain")
        return int(response.get("running_runs", 0))


class DeploymentPoller:
    def __init__(
        self,
        client: ServerClient,
        *,
        runner: CommandRunner = run_command,
        env: dict[str, str] | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.runner = runner
        self.env = dict(env if env is not None else os.environ)
        self.sleep = sleep
        self.clock = clock
        # The container's own name: stable across a restart of this process
        # inside one container, different between containers. It is what lets
        # the server tell "the process that claimed this job died" from "a
        # second deployer is beating".
        self.deployer_id = self.env.get("HOSTNAME") or socket.gethostname()
        self.mode = self.env.get("RAINVER_ENV", "dev")
        self.project = f"rainver-{self.mode}"
        self.remote: dict[str, Any] | None = None
        self.next_remote_check_at: float | None = None

    # ── Observation ─────────────────────────────────────────────────────────

    async def container_id(self, service: str) -> str | None:
        # `compose run --rm server` (migrate.sh does exactly that) carries the
        # same project and service labels, so the one-off label and the running
        # filter are what keep a migration container from being reported as the
        # running build.
        code, out, _ = await self.runner(
            "docker", "ps", "--no-trunc",
            "--filter", "status=running",
            "--filter", f"label=com.docker.compose.project={self.project}",
            "--filter", f"label=com.docker.compose.service={service}",
            "--filter", "label=com.docker.compose.oneoff=False",
            "--format", "{{.ID}}",
            timeout=30,
        )
        if code != 0:
            return None
        first = out.strip().splitlines()
        return first[0].strip() if first else None

    async def service_observation(self, service: str) -> dict[str, Any] | None:
        # Compose labels, never container names: a name is a convention, the
        # labels are what the project actually is.
        container = await self.container_id(service)
        if not container:
            return None
        code, out, _ = await self.runner(
            "docker", "container", "inspect", container,
            "--format",
            '{{.Config.Image}}\t{{.Image}}'
            '\t{{index .Config.Labels "org.opencontainers.image.revision"}}'
            '\t{{index .Config.Labels "com.rainver.deployment-surface"}}',
            timeout=30,
        )
        if code != 0:
            return None
        # Only newlines are stripped: a trailing tab is an empty label, and
        # dropping it would shift the fields after it.
        parts = out.strip("\r\n").split("\t")
        if len(parts) < 2:
            return None
        image_ref, image_id = parts[0], parts[1]

        def label(index: int) -> str | None:
            value = parts[index].strip() if len(parts) > index else ""
            return value or None

        return {
            "service": service,
            "image_ref": image_ref,
            "digest": await self.image_digest(image_id, image_ref),
            "revision": label(2),
            # What an update cannot carry: this image and the ops/ tree beside
            # it. Two services disagreeing means the host step is due.
            "surface": label(3),
        }

    async def image_digest(self, image_id: str, image_ref: str) -> str | None:
        """The registry digest of the image a container runs, or None locally."""
        code, out, _ = await self.runner(
            "docker", "image", "inspect", image_id,
            "--format", "{{join .RepoDigests \",\"}}",
            timeout=30,
        )
        if code != 0:
            return None
        repository = image_ref.rsplit(":", 1)[0]
        for entry in out.strip().split(","):
            entry = entry.strip()
            if not entry or "@" not in entry:
                continue
            repo, digest = entry.rsplit("@", 1)
            if repo == repository:
                return digest
        return None

    async def daemon_version(self) -> str | None:
        code, out, _ = await self.runner("docker", "version", "--format", "{{.Server.Version}}", timeout=30)
        return out.strip() or None if code == 0 else None

    async def observation(self) -> dict[str, Any]:
        services = []
        for service in OBSERVED_SERVICES:
            observed = await self.service_observation(service)
            if observed:
                services.append(observed)
        return {
            "deployer_id": self.deployer_id,
            "services": services,
            "remote": self.remote,
            "docker_version": await self.daemon_version(),
        }

    # ── Remote check ────────────────────────────────────────────────────────

    def configured_tag(self) -> str:
        """
        `RAINVER_IMAGE_TAG` as the instance `.env` has it; the deployer never
        writes it. Parsed the way Compose reads that file — Compose is what
        performs the pull, so its answer is the one that matters: the last
        assignment wins, an `export` prefix is ignored, quotes are stripped,
        and an unquoted value ends at a comment.
        """
        env_file = Path(self.env.get("RAINVER_HOME", "")) / ".env"
        found = "stable"
        try:
            lines = env_file.read_text(encoding="utf-8").splitlines()
        except OSError:
            return found
        for line in lines:
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if not line.startswith("RAINVER_IMAGE_TAG="):
                continue
            value = line.split("=", 1)[1].strip()
            if value[:1] in {'"', "'"}:
                quote = value[0]
                end = value.find(quote, 1)
                value = value[1:end] if end > 0 else value[1:]
            else:
                value = value.split("#", 1)[0].strip()
            if value:
                found = value
        return found

    async def server_repository(self) -> str | None:
        observed = await self.service_observation("server")
        image_ref = observed.get("image_ref") if observed else None
        if not image_ref or "@" in image_ref:
            return None
        repository = image_ref.rsplit(":", 1)[0]
        return repository if "/" in repository else None

    async def check_remote(self) -> tuple[dict[str, Any] | None, str]:
        """
        The digest the configured tag points at now, read from the registry.

        A failed read leaves the last known result alone and returns the
        reason. Recording a null digest would erase what was known and, worse,
        would report "no update available" as if it had been checked.
        """
        repository = await self.server_repository()
        if not repository:
            self._schedule_remote_retry()
            return None, "the running server image is not a registry reference, so there is no remote to check"
        tag = self.configured_tag()
        code, out, err = await self.runner(
            "docker", "buildx", "imagetools", "inspect", "--raw", f"{repository}:{tag}", timeout=120,
        )
        if code != 0:
            self._schedule_remote_retry()
            reason = f"reading {repository}:{tag} failed: {tail(err, 512) or f'exit {code}'}"
            log.warning("remote check failed: %s", reason)
            return None, reason
        digest = _manifest_digest(out)
        if digest is None:
            self._schedule_remote_retry()
            reason = f"{repository}:{tag} returned no manifest digest"
            log.warning("remote check failed: %s", reason)
            return None, reason
        self.remote = {"tag": tag, "digest": digest, "checked_at": _utc_now()}
        self.next_remote_check_at = self.clock() + REMOTE_CHECK_INTERVAL_SECONDS
        return self.remote, f"{tag} -> {digest}"

    def _schedule_remote_retry(self) -> None:
        self.next_remote_check_at = self.clock() + REMOTE_CHECK_RETRY_SECONDS

    # ── Job execution ───────────────────────────────────────────────────────

    async def report(self, job_id: str, event: dict[str, Any]) -> None:
        """
        Post one stage event, waiting out a server that is restarting.

        The recreate stage takes the control plane down; without this the
        stages after it would be lost from the job's audit even though they ran.
        """
        # One id for this report, kept across every retry: a report whose
        # response was lost must not become a second event, and a retried
        # terminal report must not be refused by the job its own first attempt
        # ended.
        event = {"event_id": str(uuid.uuid4()), **event}
        deadline = self.clock() + STAGE_TIMEOUT_SECONDS
        delay = 2.0
        while True:
            try:
                await self.client.post_event(job_id, event)
                return
            except urllib.error.HTTPError as error:
                # A 4xx is the server's answer — the job is terminal, cancelled,
                # or the body was rejected — and retrying cannot change it. A
                # 5xx is a server that has not finished coming back up.
                if error.code < 500:
                    raise
                if self.clock() >= deadline:
                    log.error("giving up reporting stage %s of job %s: %s", event.get("stage"), job_id, error)
                    raise
                await self.sleep(delay)
                delay = min(delay * 2, 30.0)
            except Exception as error:  # noqa: BLE001 — transport is down, keep waiting
                if self.clock() >= deadline:
                    log.error("giving up reporting stage %s of job %s: %s", event.get("stage"), job_id, error)
                    raise
                await self.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def run_stage_script(self, stage: str) -> tuple[int, str | None, str]:
        code, out, err = await self.runner(
            str(UPDATE_SCRIPT), stage, timeout=STAGE_TIMEOUT_SECONDS, env=self.env,
        )
        output = f"{out}{err}"
        return code, tail(output), output

    async def stage_result(self, stage: str, output: str) -> dict[str, Any]:
        """What a succeeded stage records on the job beyond its log tail."""
        if stage == "migrate":
            dump_path = _dump_path(output)
            return {"dump_path": dump_path} if dump_path else {}
        if stage == "recreate":
            return {"digests": await self.pulled_digests()}
        if stage == "health":
            return {"health": "ok"}
        return {}

    async def drain(self, timeout_seconds: int) -> tuple[int, str | None]:
        """Wait until no Run is running, or until the job's drain timeout."""
        deadline = self.clock() + max(0, timeout_seconds)
        last: int | None = None
        last_error = ""
        while True:
            try:
                last = await self.client.running_runs()
            except Exception as error:  # noqa: BLE001 — one failed read is not a failed drain
                last_error = str(error)
                log.warning("drain read failed: %s", error)
            if last == 0:
                return 0, "no Runs running"
            if self.clock() >= deadline:
                if last is None:
                    # Never once read the count: proceeding would recreate the
                    # server without knowing what it would interrupt.
                    return 1, f"drain could not read the running Run count: {last_error}"
                # ADR 0020 section 4: a timeout with a known count is not a
                # failure. Runs still running are handled by the existing lease
                # retry and orphan rules.
                return 0, f"drain timed out after {timeout_seconds}s with {last} Run(s) running"
            await self.sleep(DRAIN_POLL_SECONDS)

    async def execute_update(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        target_tag = self.configured_tag()
        for stage in UPDATE_STAGES:
            await self.report(job_id, {"stage": stage, "status": "started", "target_tag": target_tag})
            if stage == "drain":
                code, log_tail = await self.drain(int(job.get("drain_timeout_seconds") or 0))
                output = ""
            else:
                code, log_tail, output = await self.run_stage_script(stage)
            if code != 0:
                # The dump path matters most when migrate is what failed, so it
                # is recorded on the job rather than left to survive inside a
                # bounded log tail the migration's own output can push it out of.
                dump_path = _dump_path(output)
                await self.report(job_id, {
                    "stage": stage,
                    "status": "failed",
                    "log_tail": log_tail,
                    **({"result_json": {"dump_path": dump_path}} if dump_path else {}),
                })
                log.error("update job %s failed at stage %s", job_id, stage)
                return
            result = await self.stage_result(stage, output)
            await self.report(job_id, {
                "stage": stage,
                "status": "succeeded",
                "log_tail": log_tail,
                "terminal": stage == UPDATE_STAGES[-1],
                **({"result_json": result} if result else {}),
            })
        log.info("update job %s finished", job_id)

    async def pulled_digests(self) -> dict[str, str | None]:
        return {
            service: (await self.service_observation(service) or {}).get("digest")
            for service in RECREATE_SERVICES
        }

    async def execute_check_update(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        await self.report(job_id, {"stage": "remote_check", "status": "started"})
        remote, detail = await self.check_remote()
        if remote is None:
            await self.report(job_id, {"stage": "remote_check", "status": "failed", "log_tail": detail})
            return
        await self.report(job_id, {
            "stage": "remote_check",
            "status": "succeeded",
            "terminal": True,
            "target_tag": remote["tag"],
            "result_json": {"remote": remote},
            "log_tail": detail,
        })

    async def execute(self, job: dict[str, Any]) -> None:
        job_type = job.get("job_type")
        if job_type not in PULL_JOB_TYPES:
            log.error("ignoring job %s of unknown type %r", job.get("id"), job_type)
            return
        try:
            if job_type == "update":
                await self.execute_update(job)
            else:
                await self.execute_check_update(job)
        except Exception:
            log.exception("job %s aborted", job.get("id"))

    # ── Loop ────────────────────────────────────────────────────────────────

    def remote_check_due(self) -> bool:
        return self.next_remote_check_at is None or self.clock() >= self.next_remote_check_at

    async def tick(self) -> dict[str, Any] | None:
        if self.remote_check_due():
            await self.check_remote()
        job = await self.client.heartbeat(await self.observation())
        if job:
            log.info("claimed deployment job %s (%s)", job.get("id"), job.get("job_type"))
            await self.execute(job)
        return job

    async def run_forever(self) -> None:
        while True:
            worked = False
            try:
                worked = await self.tick() is not None
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 — a poll failure must not stop the loop
                log.warning("deployment poll failed: %s", error)
            if worked:
                # A finished job changed what there is to see. Beat again now so
                # the panel shows the new build rather than the old one for
                # another interval.
                continue
            await self.sleep(POLL_INTERVAL_SECONDS)


def _manifest_digest(raw: str) -> str | None:
    """
    The digest a pull of this tag would record, from the exact manifest bytes
    the registry served.

    `docker manifest inspect --verbose` cannot answer this. Every image buildx
    publishes is an index — the provenance attestation is a second manifest —
    and that command reports the *child* platform manifests, while the running
    container's `RepoDigests` names the index. Comparing the two would report
    an available update forever. Hashing the raw bytes is what the registry
    itself does to name them.
    """
    try:
        json.loads(raw)
    except json.JSONDecodeError:
        return None
    return f"sha256:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


def _dump_path(output: str) -> str | None:
    """The pre-migration dump migrate.sh reports, so recovery does not read logs."""
    marker = "pre-migration backup written: "
    for line in output.splitlines():
        index = line.find(marker)
        if index != -1:
            return line[index + len(marker):].split(" (")[0].strip() or None
    return None


def _utc_now() -> str:
    from datetime import datetime, UTC

    return datetime.now(UTC).isoformat()


def build_poller(env: dict[str, str] | None = None) -> DeploymentPoller | None:
    """None when this deployment did not configure the pull loop."""
    environment = dict(env if env is not None else os.environ)
    base_url = environment.get("DEPLOYER_SERVER_URL", "").strip()
    token = environment.get("SERVER_INTERNAL_TOKEN", "").strip()
    if not base_url or not token:
        return None
    return DeploymentPoller(ServerClient(base_url, token), env=environment)
