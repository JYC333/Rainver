from __future__ import annotations

import asyncio
import hashlib
import json
import os
import pathlib
import unittest
import unittest.mock
import urllib.error

import poll
from poll import DeploymentPoller, RECREATE_SERVICES, UPDATE_STAGES
from protocol import ALLOWED_JOB_TYPES, PULL_JOB_TYPES


class FakeClient:
    def __init__(self, jobs: list[dict | None] | None = None, running_runs: list[int] | None = None) -> None:
        self.jobs = list(jobs or [])
        self.running = list(running_runs or [0])
        self.heartbeats: list[dict] = []
        self.events: list[tuple[str, dict]] = []
        self.drain_reads = 0
        self.fail_events_until = 0

    async def heartbeat(self, observation: dict) -> dict | None:
        self.heartbeats.append(observation)
        return self.jobs.pop(0) if self.jobs else None

    async def post_event(self, job_id: str, event: dict) -> None:
        if self.fail_events_until > 0:
            self.fail_events_until -= 1
            raise ConnectionRefusedError("server is restarting")
        self.events.append((job_id, event))

    async def running_runs(self) -> int:
        self.drain_reads += 1
        return self.running.pop(0) if len(self.running) > 1 else self.running[0]


class FakeRunner:
    """A docker/script stand-in keyed by the first two words of the command."""

    def __init__(self, failures: dict[str, tuple[int, str, str]] | None = None) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.failures = failures or {}

    async def __call__(self, *args: str, timeout: int = 120, env: dict | None = None) -> tuple[int, str, str]:
        self.calls.append(args)
        if args[0].endswith("update.sh"):
            stage = args[1]
            return self.failures.get(stage, (0, f"[update] {stage} done\n", ""))
        if args[:2] == ("docker", "ps"):
            service = next(a.split("=")[-1] for a in args if a.startswith("label=com.docker.compose.service="))
            return 0, f"container-{service}\n", ""
        if args[:3] == ("docker", "container", "inspect"):
            service = args[3].removeprefix("container-")
            # Two labels, and the deployer's surface deliberately empty so a
            # trailing tab is exercised: stripping it would shift the fields.
            surface = "" if service == "deployer" else "surface-1"
            return 0, f"ghcr.io/x/rainver-{service}:stable\timage-{service}\tabc1234\t{surface}\n", ""
        if args[:3] == ("docker", "image", "inspect"):
            service = args[3].removeprefix("image-")
            return 0, f"ghcr.io/x/rainver-{service}@sha256:{service}-digest\n", ""
        if args[:2] == ("docker", "version"):
            return 0, "27.0.0\n", ""
        if args[:4] == ("docker", "buildx", "imagetools", "inspect"):
            # The raw bytes the registry served for the tag; the digest is
            # their hash, which is what a pull records in RepoDigests.
            return self.failures.get("manifest", (0, REMOTE_MANIFEST, ""))
        return 0, "", ""

    def stages(self) -> list[str]:
        return [args[1] for args in self.calls if args[0].endswith("update.sh")]


#: A published image is an index: the platform manifest plus buildx's
#: provenance attestation. Its digest is the hash of exactly these bytes, which
#: is why this fixture is the registry's own formatting rather than a
#: re-serialized object — an implementation that parsed and re-encoded before
#: hashing must fail, and against canonical JSON it would pass.
REMOTE_MANIFEST = (
    '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json",'
    '"manifests":[{"digest":"sha256:child-amd64","size":4464,'
    '"mediaType":"application/vnd.oci.image.manifest.v1+json"},'
    '{"digest":"sha256:child-attestation","size":838,'
    '"mediaType":"application/vnd.oci.image.manifest.v1+json"}]}'
)
REMOTE_DIGEST = f"sha256:{hashlib.sha256(REMOTE_MANIFEST.encode('utf-8')).hexdigest()}"


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def build(client: FakeClient, runner: FakeRunner, clock: FakeClock | None = None) -> DeploymentPoller:
    clock = clock or FakeClock()

    async def sleep(seconds: float) -> None:
        clock.value += seconds

    return DeploymentPoller(
        client,  # type: ignore[arg-type]
        runner=runner,
        env={"RAINVER_ENV": "prod", "RAINVER_HOME": "/nonexistent-mode-root"},
        sleep=sleep,
        clock=clock,
    )


class ProtocolSeparationTests(unittest.TestCase):
    def test_pull_job_types_are_separate_from_the_socket_allowlist(self) -> None:
        self.assertEqual(PULL_JOB_TYPES, {"update", "check_update"})
        self.assertEqual(ALLOWED_JOB_TYPES, {"rebuild_rainver", "restart_rainver", "health_check"})
        self.assertEqual(PULL_JOB_TYPES & ALLOWED_JOB_TYPES, set())

    def test_the_deployer_never_recreates_itself(self) -> None:
        self.assertEqual(RECREATE_SERVICES, ("server", "frontend", "sandbox-runner"))
        self.assertNotIn("deployer", RECREATE_SERVICES)
        script = (poll.SCRIPT_DIR / "update.sh").read_text(encoding="utf-8")
        # The shell array and the Python constant are two copies of the same
        # decision; derive one from the other so they cannot drift.
        self.assertIn(f"UPDATED_SERVICES=({' '.join(RECREATE_SERVICES)})", script)
        code = [line for line in script.splitlines() if line.strip() and not line.strip().startswith("#")]
        self.assertEqual([line for line in code if "deployer" in line], [])


class HeartbeatTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_heartbeat_names_the_deployer_that_sends_it(self) -> None:
        client = FakeClient()
        poller = build(client, FakeRunner())
        poller.deployer_id = "deployer-container-a"

        await poller.tick()

        # The server scopes its abandoned-job release by this: another
        # deployer's beat must not fail a job this one is still executing.
        self.assertEqual(client.heartbeats[0]["deployer_id"], "deployer-container-a")

    async def test_a_retried_report_keeps_its_event_id(self) -> None:
        client = FakeClient(jobs=[{"id": "job-9", "job_type": "update", "drain_timeout_seconds": 1}])
        client.fail_events_until = 2
        poller = build(client, FakeRunner())

        await poller.tick()

        ids = [event["event_id"] for _, event in client.events]
        self.assertEqual(len(ids), len(set(ids)), "each report has its own id")
        # The first report was refused twice before it landed, and it landed
        # once: the retries carried the same id rather than making new events.
        self.assertEqual(client.fail_events_until, 0)
        self.assertEqual([event["stage"] for _, event in client.events][:2], ["pull", "pull"])

    async def test_heartbeat_reports_every_service_by_compose_label(self) -> None:
        client = FakeClient()
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        observation = client.heartbeats[0]
        self.assertEqual(
            [service["service"] for service in observation["services"]],
            ["server", "frontend", "sandbox-runner", "deployer"],
        )
        self.assertEqual(observation["services"][0], {
            "service": "server",
            "image_ref": "ghcr.io/x/rainver-server:stable",
            "digest": "sha256:server-digest",
            "revision": "abc1234",
            "surface": "surface-1",
        })
        # An absent label is None, not the field after it: the format ends in a
        # tab whenever the last label is empty.
        deployer_observed = observation["services"][-1]
        self.assertEqual(deployer_observed["service"], "deployer")
        self.assertEqual(deployer_observed["revision"], "abc1234")
        self.assertIsNone(deployer_observed["surface"])
        self.assertEqual(observation["docker_version"], "27.0.0")
        self.assertEqual(observation["remote"], {
            "tag": "stable",
            "digest": REMOTE_DIGEST,
            "checked_at": observation["remote"]["checked_at"],
        })
        # Containers are found by compose labels, never by name.
        ps_calls = [args for args in runner.calls if args[:2] == ("docker", "ps")]
        self.assertTrue(ps_calls)
        for call in ps_calls:
            self.assertIn("label=com.docker.compose.project=rainver-prod", call)

    async def test_remote_check_runs_once_a_day(self) -> None:
        client = FakeClient()
        runner = FakeRunner()
        clock = FakeClock()
        poller = build(client, runner, clock)

        await poller.tick()
        await poller.tick()
        manifest_calls = [c for c in runner.calls if c[:4] == ("docker", "buildx", "imagetools", "inspect")]
        self.assertEqual(len(manifest_calls), 1)

        clock.value += poll.REMOTE_CHECK_INTERVAL_SECONDS
        await poller.tick()
        manifest_calls = [c for c in runner.calls if c[:4] == ("docker", "buildx", "imagetools", "inspect")]
        self.assertEqual(len(manifest_calls), 2)


class UpdateJobTests(unittest.IsolatedAsyncioTestCase):
    def job(self, job_type: str = "update") -> dict:
        return {"id": "job-1", "job_type": job_type, "drain_timeout_seconds": 30}

    async def test_runs_every_stage_in_order_and_reports_each(self) -> None:
        client = FakeClient(jobs=[self.job()])
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        self.assertEqual(runner.stages(), ["pull", "migrate", "recreate", "health"])
        reported = [(event["stage"], event["status"]) for _, event in client.events]
        self.assertEqual(reported, [
            (stage, status)
            for stage in UPDATE_STAGES
            for status in ("started", "succeeded")
        ])
        terminal = [event for _, event in client.events if event.get("terminal")]
        self.assertEqual(len(terminal), 1)
        self.assertEqual(terminal[0]["stage"], "health")
        recreate = next(event for _, event in client.events
                        if event["stage"] == "recreate" and event["status"] == "succeeded")
        self.assertEqual(recreate["result_json"]["digests"], {
            "server": "sha256:server-digest",
            "frontend": "sha256:frontend-digest",
            "sandbox-runner": "sha256:sandbox-runner-digest",
        })

    async def test_a_job_is_claimed_and_run_at_most_once(self) -> None:
        client = FakeClient(jobs=[self.job(), None])
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()
        await poller.tick()

        self.assertEqual(runner.stages().count("pull"), 1)
        self.assertEqual(len(client.heartbeats), 2)

    async def test_failure_stops_at_the_stage_and_reports_it(self) -> None:
        client = FakeClient(jobs=[self.job()])
        runner = FakeRunner(failures={"migrate": (1, "dump written /rainver/db/dumps/pre-migrate-1.dump\n", "boom")})
        poller = build(client, runner)

        await poller.tick()

        self.assertEqual(runner.stages(), ["pull", "migrate"])
        last = client.events[-1][1]
        self.assertEqual((last["stage"], last["status"]), ("migrate", "failed"))
        self.assertIn("pre-migrate-1.dump", last["log_tail"])
        self.assertNotIn("recreate", [event["stage"] for _, event in client.events])

    async def test_a_failed_migrate_still_records_its_dump_path(self) -> None:
        client = FakeClient(jobs=[self.job()])
        runner = FakeRunner(failures={"migrate": (
            1,
            "[migrate] pre-migration backup written: /rainver/db/dumps/pre-migrate-7.dump (4.0M)\n",
            "relation already exists\n",
        )})
        poller = build(client, runner)

        await poller.tick()

        last = client.events[-1][1]
        self.assertEqual((last["stage"], last["status"]), ("migrate", "failed"))
        # The dump is what a recovery restores; it must not depend on the path
        # surviving inside a bounded log tail.
        self.assertEqual(last["result_json"], {"dump_path": "/rainver/db/dumps/pre-migrate-7.dump"})

    async def test_drain_waits_for_running_runs_then_proceeds_on_timeout(self) -> None:
        client = FakeClient(jobs=[self.job()], running_runs=[2, 1, 0])
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        self.assertEqual(client.drain_reads, 3)
        drain = next(event for _, event in client.events
                     if event["stage"] == "drain" and event["status"] == "succeeded")
        self.assertEqual(drain["log_tail"], "no Runs running")

        # A Run that never finishes is not a failed update: the drain timeout
        # hands over to the existing lease retry and orphan rules.
        stuck = FakeClient(jobs=[self.job()], running_runs=[3])
        poller = build(stuck, FakeRunner())
        await poller.tick()
        drain = next(event for _, event in stuck.events
                     if event["stage"] == "drain" and event["status"] == "succeeded")
        self.assertIn("drain timed out", drain["log_tail"])

    async def test_reporting_waits_out_the_server_restart_it_caused(self) -> None:
        client = FakeClient(jobs=[self.job()])
        client.fail_events_until = 3
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        # Nothing was lost: the refused reports were retried, so every stage
        # still has both of its events and the audit is complete.
        self.assertEqual(client.fail_events_until, 0)
        reported = [(event["stage"], event["status"]) for _, event in client.events]
        self.assertEqual(len(reported), 2 * len(UPDATE_STAGES))
        self.assertEqual(reported[0], ("pull", "started"))
        self.assertEqual(reported[-1], ("health", "succeeded"))

    async def test_a_rejected_event_is_not_retried(self) -> None:
        client = FakeClient(jobs=[self.job()])

        async def reject(job_id: str, event: dict) -> None:
            raise urllib.error.HTTPError("url", 409, "conflict", {}, None)  # type: ignore[arg-type]

        client.post_event = reject  # type: ignore[assignment]
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        # The job was cancelled or swept; the deployer stops instead of
        # hammering the server for the rest of the stage timeout.
        self.assertEqual(runner.stages(), [])


class CheckUpdateJobTests(unittest.IsolatedAsyncioTestCase):
    async def test_reports_the_remote_digest(self) -> None:
        client = FakeClient(jobs=[{"id": "job-2", "job_type": "check_update"}])
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        self.assertEqual(runner.stages(), [])
        stages = [(event["stage"], event["status"]) for _, event in client.events]
        self.assertEqual(stages, [("remote_check", "started"), ("remote_check", "succeeded")])
        self.assertEqual(client.events[-1][1]["result_json"]["remote"]["digest"], REMOTE_DIGEST)

    async def test_unknown_job_types_are_ignored(self) -> None:
        client = FakeClient(jobs=[{"id": "job-3", "job_type": "rebuild_rainver"}])
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        self.assertEqual(client.events, [])
        self.assertEqual(runner.stages(), [])


class ManifestDigestTests(unittest.TestCase):
    def test_the_remote_digest_is_the_hash_of_the_served_manifest_bytes(self) -> None:
        # This is exactly what a pull records in RepoDigests, which is the
        # value the running side reports. `docker manifest inspect` would give
        # a child manifest instead, and the two could never be equal.
        self.assertEqual(poll._manifest_digest(REMOTE_MANIFEST), REMOTE_DIGEST)
        self.assertIsNone(poll._manifest_digest("not json"))
        # Re-serializing the document before hashing is the mistake this test
        # exists to catch: the registry's bytes are the name of the manifest.
        recanonicalized = json.dumps(json.loads(REMOTE_MANIFEST))
        self.assertNotEqual(recanonicalized, REMOTE_MANIFEST)
        self.assertNotEqual(poll._manifest_digest(recanonicalized), REMOTE_DIGEST)


class RemoteCheckFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_failed_read_keeps_the_last_known_digest_and_fails_the_job(self) -> None:
        client = FakeClient()
        runner = FakeRunner()
        clock = FakeClock()
        poller = build(client, runner, clock)

        await poller.tick()
        self.assertEqual(poller.remote["digest"], REMOTE_DIGEST)

        # The registry goes away. Recording a null digest would erase what is
        # known and read as "no update available".
        runner.failures["manifest"] = (1, "", "unauthorized")
        clock.value += poll.REMOTE_CHECK_INTERVAL_SECONDS
        await poller.tick()
        self.assertEqual(poller.remote["digest"], REMOTE_DIGEST)
        self.assertEqual(client.heartbeats[-1]["remote"]["digest"], REMOTE_DIGEST)

        # And it is retried well before the daily cadence.
        self.assertFalse(poller.remote_check_due())
        clock.value += poll.REMOTE_CHECK_RETRY_SECONDS
        self.assertTrue(poller.remote_check_due())

    async def test_check_update_reports_the_failure_rather_than_a_null_digest(self) -> None:
        client = FakeClient(jobs=[{"id": "job-4", "job_type": "check_update"}])
        runner = FakeRunner(failures={"manifest": (1, "", "unauthorized")})
        poller = build(client, runner)

        await poller.tick()

        last = client.events[-1][1]
        self.assertEqual((last["stage"], last["status"]), ("remote_check", "failed"))
        self.assertIn("unauthorized", last["log_tail"])


class StageResultTests(unittest.IsolatedAsyncioTestCase):
    async def test_records_the_dump_path_and_health_result_on_the_job(self) -> None:
        client = FakeClient(jobs=[{"id": "job-5", "job_type": "update", "drain_timeout_seconds": 5}])
        runner = FakeRunner(failures={
            "migrate": (0, "[migrate] pre-migration backup written: /rainver/db/dumps/pre-migrate-9.dump (4.0M)\n", ""),
        })
        poller = build(client, runner)

        await poller.tick()

        results = {
            event["stage"]: event.get("result_json")
            for _, event in client.events
            if event["status"] == "succeeded"
        }
        self.assertEqual(results["migrate"], {"dump_path": "/rainver/db/dumps/pre-migrate-9.dump"})
        self.assertEqual(results["health"], {"health": "ok"})

    async def test_a_drain_that_never_reads_the_server_fails_the_update(self) -> None:
        client = FakeClient(jobs=[{"id": "job-6", "job_type": "update", "drain_timeout_seconds": 5}])

        async def unreachable() -> int:
            raise ConnectionRefusedError("server is unreachable")

        client.running_runs = unreachable  # type: ignore[assignment]
        runner = FakeRunner()
        poller = build(client, runner)

        await poller.tick()

        last = client.events[-1][1]
        self.assertEqual((last["stage"], last["status"]), ("drain", "failed"))
        self.assertIn("could not read the running Run count", last["log_tail"])
        self.assertNotIn("migrate", runner.stages())


class NonProductionRefusalTests(unittest.TestCase):
    def test_update_sh_refuses_outside_prod_before_touching_anything(self) -> None:
        import subprocess

        result = subprocess.run(
            ["bash", str(poll.UPDATE_SCRIPT), "pull"],
            capture_output=True,
            text=True,
            env={"PATH": os.environ["PATH"], "RAINVER_ENV": "dev"},
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("production operation", result.stderr)


class MissingBinaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_unrunnable_command_fails_its_stage_instead_of_the_tick(self) -> None:
        code, out, err = await poll.run_command("definitely-not-a-real-binary", timeout=5)
        self.assertEqual(code, 127)
        self.assertIn("definitely-not-a-real-binary", err)


class ProcessGroupTests(unittest.IsolatedAsyncioTestCase):
    """
    A stage is `update.sh`; the work is the `docker compose` it starts. Killing
    only the shell would leave a pull, a migration or a recreate running
    against the instance after the job was recorded as failed — and a later
    update could then run a second migration beside it.
    """

    async def test_a_stage_runs_in_its_own_session(self) -> None:
        seen: dict[str, object] = {}
        real = asyncio.create_subprocess_exec

        async def spy(*args, **kwargs):
            seen.update(kwargs)
            return await real(*args, **kwargs)

        with unittest.mock.patch.object(asyncio, "create_subprocess_exec", spy):
            code, out, _ = await poll.run_command("bash", "-c", "exit 0", timeout=5)

        self.assertEqual(code, 0)
        self.assertIs(seen.get("start_new_session"), True)

    async def test_a_timed_out_stage_kills_the_whole_group(self) -> None:
        killed: list[int] = []
        real_killpg = os.killpg

        def spy_killpg(pgid: int, sig: int) -> None:
            killed.append(pgid)
            real_killpg(pgid, sig)

        with unittest.mock.patch.object(poll.os, "killpg", spy_killpg):
            code, _, err = await poll.run_command("bash", "-c", "sleep 30", timeout=1)

        self.assertEqual(code, 124)
        self.assertIn("timed out", err)
        # The group, not the process: the shell's children go with it.
        self.assertEqual(len(killed), 1)


class ConfiguredTagTests(unittest.TestCase):
    """
    The tag comes from the instance `.env`, read the way Compose reads it —
    Compose is what performs the pull, so a disagreement here would pull one
    image and report another as the channel.
    """

    def tag_for(self, contents: str) -> str:
        import tempfile

        with tempfile.TemporaryDirectory() as home:
            (pathlib.Path(home) / ".env").write_text(contents, encoding="utf-8")
            poller = build(FakeClient(), FakeRunner())
            poller.env["RAINVER_HOME"] = home
            return poller.configured_tag()

    def test_defaults_to_stable_without_a_readable_env_file(self) -> None:
        self.assertEqual(build(FakeClient(), FakeRunner()).configured_tag(), "stable")
        self.assertEqual(self.tag_for("POSTGRES_USER=rainver\n"), "stable")

    def test_reads_the_last_assignment_and_ignores_the_commented_out_one(self) -> None:
        self.assertEqual(
            self.tag_for("# RAINVER_IMAGE_TAG=stable\nRAINVER_IMAGE_TAG=edge\n"), "edge"
        )
        self.assertEqual(
            self.tag_for("RAINVER_IMAGE_TAG=edge\nRAINVER_IMAGE_TAG=sha-abc123\n"), "sha-abc123"
        )

    def test_strips_quotes_export_and_a_trailing_comment(self) -> None:
        self.assertEqual(self.tag_for('RAINVER_IMAGE_TAG="edge"\n'), "edge")
        self.assertEqual(self.tag_for("export RAINVER_IMAGE_TAG=edge\n"), "edge")
        self.assertEqual(self.tag_for("RAINVER_IMAGE_TAG=edge # the dev channel\n"), "edge")
        # An empty assignment is what `${RAINVER_IMAGE_TAG:-stable}` falls back
        # from, so it must not become the tag.
        self.assertEqual(self.tag_for("RAINVER_IMAGE_TAG=\n"), "stable")

    def test_does_not_match_a_longer_variable_name(self) -> None:
        self.assertEqual(self.tag_for("RAINVER_IMAGE_TAG_PREVIOUS=edge\n"), "stable")


class LogTailTests(unittest.TestCase):
    def test_bounds_the_tail_without_splitting_a_character(self) -> None:
        text = "中" * 6000 + "END"
        bounded = poll.tail(text)
        assert bounded is not None
        self.assertTrue(bounded.endswith("END"))
        self.assertLessEqual(len(bounded.encode("utf-8")), poll.LOG_TAIL_BYTES)
        self.assertNotIn("�", bounded)
        self.assertIsNone(poll.tail(""))


if __name__ == "__main__":
    unittest.main()
