"""Static and fixture checks for .github/workflows/host-daemon-release.yml.

Nothing here talks to GitHub: each `run:` block is executed by bash with fake
`gh` and recorded `git` pushes in a throwaway repository, so the release
logic is exercised without a real release, tag push, or CI run.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "host-daemon-release.yml"


def load() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def step(job: dict, name_or_id: str) -> dict:
    for candidate in job["steps"]:
        if candidate.get("id") == name_or_id or candidate.get("name") == name_or_id:
            return candidate
    raise AssertionError(f"no step {name_or_id}")


def substitute(script: str, values: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        expression = match.group(1).strip()
        if expression not in values:
            raise AssertionError(f"unexpected expression in run block: {expression}")
        return values[expression]

    return re.sub(r"\$\{\{(.*?)\}\}", replace, script)


class Sandbox:
    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="rainver-release-wf-"))
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.log = self.dir / "calls.log"
        self.repo = self.dir / "repo"
        self.repo.mkdir()
        self.remote = self.dir / "remote.git"
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)
        subprocess.run(["git", "init", "-q", "-b", "dev", str(self.repo)], check=True)
        subprocess.run([*git, "-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "c"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "remote", "add", "origin", str(self.remote)], check=True)
        self.sha = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
        (self.repo / "release").mkdir()
        (self.repo / "release" / "a.tar.gz").write_text("a")
        self.existing_releases: set[str] = set()

    def fake_gh(self) -> None:
        existing = " ".join(sorted(self.existing_releases))
        script = textwrap.dedent(
            f"""\
            #!/bin/bash
            [[ -n "${{GH_TOKEN:-}}" ]] || {{ echo "gh: no GH_TOKEN" >&2; exit 4; }}
            echo "gh $*" >> {self.log}
            if [[ "$1 $2" == "release view" ]]; then
              for known in {existing}; do [[ "$3" == "$known" ]] && exit 0; done
              exit 1
            fi
            exit 0
            """
        )
        path = self.bin / "gh"
        path.write_text(script)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def run(self, script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        self.fake_gh()
        full_env = {"PATH": f"{self.bin}:{os.environ['PATH']}", "HOME": str(self.dir), **env}
        return subprocess.run(["bash", "-e", "-c", script], cwd=self.repo, env=full_env, capture_output=True, text=True)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def remote_tag(self, tag: str) -> str | None:
        result = subprocess.run(["git", "-C", str(self.remote), "rev-parse", "--verify", "-q", f"refs/tags/{tag}"], capture_output=True, text=True)
        return result.stdout.strip() or None

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


class HostReleaseWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.workflow = load()
        self.jobs = self.workflow["jobs"]
        self.sandbox = Sandbox()

    def tearDown(self) -> None:
        self.sandbox.close()

    def test_every_run_block_parses_and_every_gh_step_has_a_token(self) -> None:
        for job_name, job in self.jobs.items():
            for candidate in job["steps"]:
                script = candidate.get("run")
                if not script:
                    continue
                stripped = re.sub(r"\$\{\{.*?\}\}", "X", script)
                result = subprocess.run(["bash", "-n", "-c", stripped], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, f"{job_name}/{candidate.get('name')}: {result.stderr}")
                if re.search(r"(^|\s)gh\s", script):
                    self.assertIn("GH_TOKEN", candidate.get("env", {}), f"{job_name}/{candidate.get('name')} calls gh without GH_TOKEN")

    def test_resolve_checks_out_an_exact_branch_before_reading_its_commit(self) -> None:
        steps = self.jobs["resolve"]["steps"]
        names = [s.get("id") or s.get("uses") for s in steps]
        checkout = next(i for i, s in enumerate(steps) if str(s.get("uses", "")).startswith("actions/checkout"))
        self.assertLess(checkout, names.index("release"))
        self.assertEqual(steps[checkout]["with"]["ref"], "refs/heads/${{ steps.channel.outputs.branch }}")
        self.assertNotIn("origin/", step(self.jobs["resolve"], "release")["run"])

    def test_channel_mapping_and_unknown_channel_refusal(self) -> None:
        channel = step(self.jobs["resolve"], "channel")
        script = substitute(channel["run"], {})
        cases = [
            ({"GITHUB_EVENT_NAME": "schedule"}, "nightly", "dev"),
            ({"GITHUB_EVENT_NAME": "workflow_dispatch", "INPUT_CHANNEL": "stable"}, "stable", "master"),
            ({"GITHUB_EVENT_NAME": "push", "GITHUB_REF_NAME": "master"}, "stable", "master"),
            ({"GITHUB_EVENT_NAME": "push", "GITHUB_REF_NAME": "dev"}, "edge", "dev"),
        ]
        for env, expected_channel, expected_branch in cases:
            output = self.sandbox.dir / "out"
            output.write_text("")
            result = self.sandbox.run(script, {"GITHUB_OUTPUT": str(output), "INPUT_CHANNEL": "", **env})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_text().split(), [f"channel={expected_channel}", f"branch={expected_branch}"])
        output = self.sandbox.dir / "out"
        result = self.sandbox.run(script, {"GITHUB_OUTPUT": str(output), "GITHUB_EVENT_NAME": "workflow_dispatch", "INPUT_CHANNEL": "x; rm -rf /"})
        self.assertNotEqual(result.returncode, 0)

    def test_pin_step_outputs_the_full_commit(self) -> None:
        output = self.sandbox.dir / "out"
        result = self.sandbox.run(substitute(step(self.jobs["resolve"], "release")["run"], {}), {"GITHUB_OUTPUT": str(output)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text().strip(), f"ref={self.sandbox.sha}")

    def test_build_waits_for_tests_at_the_pinned_commit(self) -> None:
        self.assertEqual(sorted(self.jobs["build"]["needs"]), ["resolve", "verify"])
        verify = self.jobs["verify"]
        self.assertEqual(verify["needs"], "resolve")
        self.assertEqual(step(verify, "Check out repository")["with"]["ref"], "${{ needs.resolve.outputs.ref }}")
        self.assertIn("pnpm --filter @rainver/host-daemon test", step(verify, "Typecheck and test daemon packages")["run"])
        self.assertIn("build", self.jobs["publish"]["needs"])

    def publish_script(self) -> tuple[str, dict[str, str]]:
        publish = step(self.jobs["publish"], "Publish the build and move the rolling channel")
        return substitute(publish["run"], {}), {"GH_TOKEN": "synthetic"}

    def test_exactly_one_step_owns_release_creation(self) -> None:
        creators = [s["name"] for s in self.jobs["publish"]["steps"] if "host-build-" in (s.get("run") or "")]
        self.assertEqual(creators, ["Publish the build and move the rolling channel"])

    def test_publish_creates_the_immutable_release_once_and_moves_the_channel(self) -> None:
        script, env = self.publish_script()
        result = self.sandbox.run(script, {**env, "RELEASE_CHANNEL": "edge", "RELEASE_REF": self.sandbox.sha})
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.sandbox.calls()
        creates = [c for c in calls if c.startswith("gh release create")]
        self.assertEqual(len([c for c in creates if f"host-build-{self.sandbox.sha}" in c]), 1)
        self.assertTrue(any(f"Rainver Host {self.sandbox.sha[:12]}" in c for c in creates), creates)
        self.assertTrue(any(c.startswith("gh release create host-edge") and "--prerelease" in c for c in creates))
        self.assertEqual(self.sandbox.remote_tag("host-edge"), self.sandbox.sha)
        self.assertIsNone(self.sandbox.remote_tag("host-installer"))

    def test_publish_replaces_existing_releases_without_recreating(self) -> None:
        self.sandbox.existing_releases = {f"host-build-{self.sandbox.sha}", "host-stable"}
        script, env = self.publish_script()
        result = self.sandbox.run(script, {**env, "RELEASE_CHANNEL": "stable", "RELEASE_REF": self.sandbox.sha})
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.sandbox.calls()
        self.assertEqual([c for c in calls if c.startswith("gh release create")], [])
        self.assertTrue(any(c.startswith("gh release upload host-stable") and "--clobber" in c for c in calls))
        self.assertTrue(any(c.startswith("gh release edit host-stable") and "--latest" in c for c in calls))

    def test_publish_refuses_a_checkout_that_is_not_the_pinned_commit(self) -> None:
        script, env = self.publish_script()
        result = self.sandbox.run(script, {**env, "RELEASE_CHANNEL": "edge", "RELEASE_REF": "0" * 40})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.sandbox.calls(), [])
        self.assertIsNone(self.sandbox.remote_tag("host-edge"))

    def test_installer_tag_moves_only_in_the_stable_installer_step(self) -> None:
        installer = step(self.jobs["publish"], "Publish unified installer")
        self.assertEqual(installer["if"], "needs.resolve.outputs.channel == 'stable'")
        moving = [s["name"] for job in self.jobs.values() for s in job["steps"] if "host-installer" in (s.get("run") or "") and "git tag" in (s.get("run") or "")]
        self.assertEqual(moving, ["Publish unified installer"])


if __name__ == "__main__":
    unittest.main()
