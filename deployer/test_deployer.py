from __future__ import annotations

import asyncio
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import deployer


class FakeWriter:
    def __init__(self) -> None:
        self.buffer = bytearray()

    def get_extra_info(self, _name: str, default: object = None) -> object:
        return default

    def write(self, data: bytes) -> None:
        self.buffer.extend(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None

    def response(self) -> dict:
        return json.loads(self.buffer.decode().strip())


class PollLoopSupervisionTests(unittest.IsolatedAsyncioTestCase):
    """
    Nothing in the product can restart this container, so a pull loop that dies
    must not leave it running with no heartbeat behind it.
    """

    async def run_main(self, run_forever) -> None:
        import tempfile
        from pathlib import Path

        class FakePoller:
            async def run_forever(self) -> None:
                await run_forever()

        with tempfile.TemporaryDirectory() as directory:
            socket_path = str(Path(directory) / "deployer.sock")
            with patch.dict("os.environ", {"DEPLOYER_SOCKET": socket_path}), \
                    patch.object(deployer, "build_poller", return_value=FakePoller()):
                await deployer.main()

    async def test_a_dead_pull_loop_ends_the_process_for_the_restart_policy(self) -> None:
        async def explode() -> None:
            raise RuntimeError("poll loop bug")

        with self.assertRaises(SystemExit) as caught:
            await self.run_main(explode)
        self.assertEqual(caught.exception.code, 1)

    async def test_a_loop_that_simply_returns_is_treated_the_same(self) -> None:
        async def finish() -> None:
            return None

        with self.assertRaises(SystemExit):
            await self.run_main(finish)


class ScriptTimeoutTests(unittest.IsolatedAsyncioTestCase):
    """
    A socket job that runs past its budget is reported as failed. The script
    — and the `docker compose` it started — must stop with it, or the
    instance goes on being changed by work nothing is reporting, beside
    whatever the operator runs next.
    """

    async def test_a_timed_out_script_is_killed_with_its_process_group(self) -> None:
        killed: list[int] = []
        real_killpg = os.killpg

        def spy_killpg(pgid: int, sig: int) -> None:
            killed.append(pgid)
            real_killpg(pgid, sig)

        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "slow.sh"
            script.write_text("#!/bin/sh\nsleep 30\n", encoding="utf-8")
            script.chmod(script.stat().st_mode | stat.S_IXUSR)
            with patch.object(os, "killpg", spy_killpg):
                exit_code, _stdout, stderr = await deployer._run_script(script, timeout=1)

        self.assertNotEqual(exit_code, 0)
        self.assertIn("timed out", stderr)
        self.assertEqual(len(killed), 1)


class DeployerProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_protocol_and_script_map_are_exactly_core_jobs(self) -> None:
        expected = {"rebuild_rainver", "restart_rainver", "health_check"}
        self.assertEqual(deployer.ALLOWED_JOB_TYPES, expected)
        self.assertEqual(set(deployer.JOB_SCRIPTS), expected)

    async def request(self, payload: dict) -> tuple[dict, AsyncMock]:
        reader = asyncio.StreamReader()
        reader.feed_data(json.dumps(payload).encode() + b"\n")
        reader.feed_eof()
        writer = FakeWriter()
        run_script = AsyncMock(return_value=(0, "ok", ""))
        with patch.object(deployer, "_run_script", run_script):
            await deployer.handle_client(reader, writer)  # type: ignore[arg-type]
        return writer.response(), run_script

    async def test_accepts_core_job_without_args(self) -> None:
        response, run_script = await self.request({
            "job_id": "job-1",
            "job_type": "health_check",
            "args": {},
        })
        self.assertEqual(response["status"], "succeeded")
        run_script.assert_awaited_once_with(deployer.JOB_SCRIPTS["health_check"])

    async def test_rejects_request_environment_overrides(self) -> None:
        for args in ({"PATH": "/attacker"}, {"REPO_ROOT": "/tmp/other"}, "invalid"):
            with self.subTest(args=args):
                response, run_script = await self.request({
                    "job_id": "job-2",
                    "job_type": "rebuild_rainver",
                    "args": args,
                })
                self.assertEqual(response["status"], "failed")
                self.assertIn("does not accept request args", response["error"])
                run_script.assert_not_awaited()

    async def test_rejects_unknown_job(self) -> None:
        response, run_script = await self.request({
            "job_id": "job-3",
            "job_type": "unknown_job",
            "args": {},
        })
        self.assertEqual(response["status"], "failed")
        self.assertIn("Unknown job_type", response["error"])
        run_script.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()


class RebuildScriptTests(unittest.TestCase):
    """
    `rebuild.sh` refuses in production before any image is pulled or replaced
    and points at the instance update; dev/test refuse without a checkout.
    Docker is a stub on PATH that records every invocation, so the assertion
    is that it was never reached.
    """

    def _run(self, mode: str) -> tuple[subprocess.CompletedProcess, bool]:
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir)
            (root / "instance").mkdir()
            (root / "instance" / ".env").write_text("RAINVER_ENV=%s\n" % mode)
            (root / "ops" / "compose").mkdir(parents=True)
            (root / "ops" / "compose" / f"docker-compose.{mode}.yml").write_text("services: {}\n")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            marker = root / "docker-invoked"
            docker = fake_bin / "docker"
            docker.write_text(f"#!/usr/bin/env bash\necho \"$@\" >> '{marker}'\n")
            docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
            env = {
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
                "REPO_ROOT": str(root),
                "RAINVER_ENV": mode,
                "RAINVER_HOME": str(root / "instance"),
                "RAINVER_HOST_MODE_ROOT": str(root / "instance"),
            }
            result = subprocess.run(
                ["bash", str(Path(__file__).parent / "scripts" / "rebuild.sh")],
                env=env, capture_output=True, text=True, timeout=30, check=False,
            )
            return result, marker.exists()

    def test_prod_refuses_before_any_docker_command_and_names_the_update_path(self) -> None:
        result, docker_invoked = self._run("prod")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not a production operation", result.stderr)
        self.assertIn("rainver update", result.stderr)
        self.assertIn("update.sh", result.stderr)
        self.assertFalse(docker_invoked, "docker must not run for a prod rebuild")

    def test_dev_without_a_checkout_refuses_and_names_the_host_build(self) -> None:
        result, docker_invoked = self._run("dev")
        self.assertEqual(result.returncode, 1)
        self.assertIn("start.sh --dev --build", result.stderr)
        self.assertFalse(docker_invoked)

