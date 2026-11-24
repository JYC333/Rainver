#!/usr/bin/env python3
"""Atomic publication helpers for backup archives and credential directories."""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import errno
import os
import pathlib
import shutil
import sys
import tempfile


def publish_no_clobber(temp_path: str, desired_path: str) -> str:
    """Atomically publish a same-filesystem temp file without replacing a peer."""
    temp = pathlib.Path(temp_path)
    desired = pathlib.Path(desired_path)
    suffixes = "".join(desired.suffixes)
    stem = desired.name.removesuffix(suffixes)
    counter = 0
    while True:
        candidate = desired if counter == 0 else desired.with_name(f"{stem}-{counter}{suffixes}")
        try:
            os.link(temp, candidate)
        except OSError as error:
            if error.errno == errno.EEXIST:
                counter += 1
                continue
            raise
        temp.unlink()
        return str(candidate)


class ExchangeUnsupported(OSError):
    """The platform or filesystem cannot swap two paths in one step; nothing was changed."""


_AT_FDCWD = -100
_LINUX_RENAME_EXCHANGE = 2
_DARWIN_RENAME_SWAP = 0x2


def _libc() -> ctypes.CDLL:
    return ctypes.CDLL(ctypes.util.find_library("c") or None, use_errno=True)


def exchange(first: str, second: str) -> None:
    """Swap two existing paths in one system call (Linux renameat2 RENAME_EXCHANGE, macOS renamex_np RENAME_SWAP).

    There is no fallback to two renames: between them the target would not
    exist. Where the swap is unavailable this raises ExchangeUnsupported with
    both paths unchanged.
    """
    try:
        libc = _libc()
        if sys.platform.startswith("linux"):
            call = libc.renameat2
            call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            args = (_AT_FDCWD, os.fsencode(first), _AT_FDCWD, os.fsencode(second), _LINUX_RENAME_EXCHANGE)
        elif sys.platform == "darwin":
            call = libc.renamex_np
            call.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            args = (os.fsencode(first), os.fsencode(second), _DARWIN_RENAME_SWAP)
        else:
            raise ExchangeUnsupported(errno.ENOSYS, f"no atomic exchange on {sys.platform}")
    except (AttributeError, OSError) as error:
        if isinstance(error, ExchangeUnsupported):
            raise
        raise ExchangeUnsupported(errno.ENOSYS, f"no atomic exchange available: {error}") from error
    call.restype = ctypes.c_int
    if call(*args) == 0:
        return
    code = ctypes.get_errno()
    if code in (errno.EINVAL, errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP):
        raise ExchangeUnsupported(code, f"this filesystem cannot swap {second} atomically: {os.strerror(code)}")
    raise OSError(code, os.strerror(code), second)


def _remove(path: pathlib.Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)


def replace_directory(new_path: str, target_path: str) -> None:
    """Put new_path at target_path so the target is always wholly old or wholly new.

    An existing target is swapped with new_path in one atomic exchange; only
    then is the previous content, now at new_path, removed. Interrupted at any
    point (SIGTERM, crash), the target still exists: before the swap it is the
    old content (new_path still the new copy); after it, the new content, with
    the old content at new_path until removed. A platform or filesystem that
    cannot exchange fails closed with both untouched (ExchangeUnsupported).
    """
    new = pathlib.Path(new_path)
    target = pathlib.Path(target_path)
    if not (target.exists() or target.is_symlink()):
        os.rename(new, target)
        return
    exchange(str(new), str(target))
    _remove(new)


def check_directory_replace(new_path: str, target_path: str) -> None:
    """Probe directory exchange beside the target without moving live files."""
    target = pathlib.Path(target_path)
    if not (target.exists() or target.is_symlink()):
        return
    new_device = os.stat(new_path).st_dev
    if os.lstat(target).st_dev != new_device or os.path.ismount(target):
        raise OSError(errno.EXDEV, "target is on a separate filesystem", target_path)
    with tempfile.TemporaryDirectory(dir=target.parent, prefix=".restore-probe-") as probe:
        first, second = pathlib.Path(probe) / "first", pathlib.Path(probe) / "second"
        first.mkdir()
        second.mkdir()
        exchange(str(first), str(second))


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    publish = subparsers.add_parser("publish")
    publish.add_argument("temp_path")
    publish.add_argument("desired_path")
    replace = subparsers.add_parser("replace-directory")
    replace.add_argument("new_path")
    replace.add_argument("target_path")
    check = subparsers.add_parser("check-directory-replace")
    check.add_argument("new_path")
    check.add_argument("target_path")
    args = parser.parse_args()
    if args.command == "publish":
        print(publish_no_clobber(args.temp_path, args.desired_path))
    else:
        try:
            operation = check_directory_replace if args.command == "check-directory-replace" else replace_directory
            operation(args.new_path, args.target_path)
        except OSError as error:
            if args.command != "check-directory-replace" and not isinstance(error, ExchangeUnsupported):
                raise
            raise SystemExit(f"ERROR: {error}; {args.target_path} and {args.new_path} are unchanged") from None


if __name__ == "__main__":
    main()
