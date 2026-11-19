from __future__ import annotations

import pathlib
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from unittest.mock import patch

import atomic_ops

HERE = pathlib.Path(__file__).resolve().parent


class AtomicOpsTests(unittest.TestCase):
    def root(self) -> pathlib.Path:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return pathlib.Path(temporary.name)

    def test_concurrent_publish_never_clobbers(self) -> None:
        root = self.root()
        temps = [root / f"temp-{index}" for index in range(2)]
        for index, path in enumerate(temps):
            path.write_text(f"archive-{index}")
        barrier = threading.Barrier(2)
        results: list[str] = []

        def publish(path: pathlib.Path) -> None:
            barrier.wait()
            results.append(atomic_ops.publish_no_clobber(str(path), str(root / "backup.tar.gz")))

        threads = [threading.Thread(target=publish, args=(path,)) for path in temps]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(set(results)), 2)
        self.assertEqual({pathlib.Path(path).read_text() for path in results}, {"archive-0", "archive-1"})
        self.assertTrue(all(not path.exists() for path in temps))

    def pair(self) -> tuple[pathlib.Path, pathlib.Path]:
        root = self.root()
        target = root / "secrets"
        new = root / ".secrets-new"
        target.mkdir()
        new.mkdir()
        (target / "key").write_text("old")
        (target / "other").write_text("old")
        (new / "key").write_text("new")
        return target, new

    def terminate_at(self, phase: str, target: pathlib.Path, new: pathlib.Path, module_dir: pathlib.Path = HERE) -> int:
        """Run replace_directory in a real process that sends itself SIGTERM at `phase`."""
        script = textwrap.dedent(
            f"""
            import os, signal, sys
            sys.path.insert(0, {str(module_dir)!r})
            import atomic_ops
            def die():
                os.kill(os.getpid(), signal.SIGTERM)
            def after(owner, name):
                real = getattr(owner, name)
                def wrapped(*args, **kwargs):
                    result = real(*args, **kwargs)
                    die()
                    return result
                setattr(owner, name, wrapped)
            phase = {phase!r}
            if phase == "before-swap":
                atomic_ops.exchange = lambda *args: die()
            elif phase == "after-first-step":
                # Whichever call moves something first: a rename or the exchange.
                after(atomic_ops.os, "rename")
                if hasattr(atomic_ops, "exchange"):
                    after(atomic_ops, "exchange")
            elif phase == "mid-removal":
                after(atomic_ops.shutil.os, "unlink")
            atomic_ops.replace_directory({str(new)!r}, {str(target)!r})
            """
        )
        return subprocess.run([sys.executable, "-I", "-c", script], check=False).returncode

    def assert_wholly(self, directory: pathlib.Path, content: str) -> None:
        self.assertTrue(directory.is_dir(), f"{directory} is missing")
        self.assertEqual((directory / "key").read_text(), content)
        self.assertEqual((directory / "other").exists(), content == "old")

    def test_sigterm_before_the_swap_leaves_both_unchanged(self) -> None:
        target, new = self.pair()
        self.assertEqual(self.terminate_at("before-swap", target, new), -signal.SIGTERM)
        self.assert_wholly(target, "old")
        self.assert_wholly(new, "new")

    def test_sigterm_right_after_the_first_step_never_leaves_the_target_missing(self) -> None:
        target, new = self.pair()
        self.assertEqual(self.terminate_at("after-first-step", target, new), -signal.SIGTERM)
        self.assert_wholly(target, "new")
        # The previous content stays whole at the staging path until it is removed.
        self.assert_wholly(new, "old")

    def test_sigterm_while_removing_the_old_content_keeps_the_new_target(self) -> None:
        target, new = self.pair()
        self.assertEqual(self.terminate_at("mid-removal", target, new), -signal.SIGTERM)
        self.assert_wholly(target, "new")

    def test_unsupported_exchange_fails_closed_with_both_unchanged(self) -> None:
        target, new = self.pair()
        with patch.object(atomic_ops, "_libc", side_effect=OSError("no libc")):
            with self.assertRaises(atomic_ops.ExchangeUnsupported):
                atomic_ops.replace_directory(str(new), str(target))
        self.assert_wholly(target, "old")
        self.assert_wholly(new, "new")

    def test_cli_reports_an_unsupported_platform_without_changing_anything(self) -> None:
        target, new = self.pair()
        script = (
            f"import sys; sys.path.insert(0, {str(HERE)!r})\n"
            f"sys.argv = ['atomic_ops', 'replace-directory', {str(new)!r}, {str(target)!r}]\n"
            "import atomic_ops; atomic_ops.sys.platform = 'plan9'; atomic_ops.main()"
        )
        completed = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 1)
        self.assertIn("are unchanged", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)
        self.assert_wholly(target, "old")
        self.assert_wholly(new, "new")

    def test_a_symlink_target_is_swapped_as_a_link_and_its_destination_kept(self) -> None:
        target, new = self.pair()
        elsewhere = target.with_name("elsewhere")
        target.rename(elsewhere)
        target.symlink_to(elsewhere)
        atomic_ops.replace_directory(str(new), str(target))
        self.assertFalse(target.is_symlink())
        self.assert_wholly(target, "new")
        self.assert_wholly(elsewhere, "old")
        self.assertFalse(new.exists() or new.is_symlink())

    def test_missing_target_is_published_with_one_rename(self) -> None:
        root = self.root()
        new = root / ".secrets-new"
        new.mkdir()
        (new / "key").write_text("new")
        atomic_ops.replace_directory(str(new), str(root / "secrets"))
        self.assertEqual((root / "secrets" / "key").read_text(), "new")
        self.assertFalse(new.exists())

    def test_directory_replace_publishes_new_and_removes_old(self) -> None:
        target, new = self.pair()
        atomic_ops.replace_directory(str(new), str(target))
        self.assert_wholly(target, "new")
        self.assertFalse(new.exists())


if __name__ == "__main__":
    unittest.main()
