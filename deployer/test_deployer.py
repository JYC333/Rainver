from __future__ import annotations

import asyncio
import json
import unittest
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


class DeployerProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_protocol_and_script_map_are_exactly_core_jobs(self) -> None:
        expected = {"rebuild_agent_space", "restart_agent_space", "health_check"}
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
                    "job_type": "rebuild_agent_space",
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
