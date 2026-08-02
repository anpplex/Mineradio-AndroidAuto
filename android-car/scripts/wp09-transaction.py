#!/usr/bin/env python3
"""WP-09 dual-repo / evidence transaction helper (Task 9).

State machine surface for dual-origin exact readback and evidence containment.
Does not write RED/GREEN/REFACTOR/VERIFY phase events (generic wallpaper-task runner does).

Commands:
  reconcile --create-if-missing --file ... --plugin-repo ... --mineradio-repo ...
  allocate-evidence --file ... --root ... --exclusive-create
  evidence-path --file ...
  assert-evidence-path --file ... --root ... --path ...
  status --file ...
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any


SCHEMA = "wp09-transaction/v1"


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def fail(code: int, msg: str) -> int:
    eprint(msg)
    return code


def load_txn(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def cmd_reconcile(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if path.exists() and not args.create_if_missing:
        data = load_txn(path)
        eprint(f"reconcile: existing revision={data.get('revision')}")
        print(json.dumps({"ok": True, "command": "reconcile", "existed": True, "path": str(path)}))
        return 0
    if path.exists() and args.create_if_missing:
        # Strict reuse — no clobber
        data = load_txn(path)
        eprint("reconcile: file exists; reusing (no-clobber)")
        print(
            json.dumps(
                {
                    "ok": True,
                    "command": "reconcile",
                    "existed": True,
                    "path": str(path),
                    "transactionId": data.get("transactionId"),
                }
            )
        )
        return 0

    if not args.create_if_missing:
        return fail(2, "file missing; pass --create-if-missing")

    txn_id = str(uuid.uuid4())
    data: dict[str, Any] = {
        "schema": SCHEMA,
        "transactionId": txn_id,
        "taskId": "WP-09",
        "revision": 1,
        "state": "INIT",
        "plugin": {
            "repo": args.plugin_repo,
            "branch": args.plugin_branch,
            "base": args.plugin_base,
        },
        "mineradio": {
            "repo": args.mineradio_repo,
            "branch": args.mineradio_branch,
            "base": args.mineradio_base,
        },
        "evidence": {"root": None, "runDir": None},
        "pluginCommitSha": None,
        "verifierCommitSha": None,
        "legs": {
            "plugin": None,
            "verifier": None,
            "progress": None,
            "closure": None,
        },
        # static / certificate / split schema anchors
        "staticChecks": {
            "packages": [
                "com.mineradio.app",
                "com.motif.wallpaperengine",
                "io.wallpaperengine.weclient",
            ],
            "we_runtime": True,
            "arm64-v8a": True,
            "tools": ["aapt", "apksigner", "zipalign"],
            "BrowseActivity": "io.wallpaperengine.weclient.BrowseActivity",
            "WEWallpaperService": "io.wallpaperengine.weclient.WEWallpaperService",
            "mineradioCallerCertSha256": True,
            "certificate": "sha256",
            "split": "sort -u unique certs == 1",
        },
        "mismatchFixtures": [
            "wrongPackage",
            "missingProvider",
            "missingWeRuntime",
            "certMismatch",
            "splitSignerMismatch",
            "officialMissing",
            "apkPathMissing",
        ],
    }
    atomic_write(path, data)
    print(
        json.dumps(
            {
                "ok": True,
                "command": "reconcile",
                "created": True,
                "path": str(path),
                "transactionId": txn_id,
            }
        )
    )
    return 0


def cmd_evidence_path(args: argparse.Namespace) -> int:
    """Stdout exactly one line: evidence directory path."""
    path = Path(args.file)
    if not path.is_file():
        return fail(2, f"missing transaction file: {path}")
    data = load_txn(path)
    run_dir = (data.get("evidence") or {}).get("runDir")
    if not run_dir:
        # deterministic path under default root if allocated
        tid = data.get("transactionId") or "unknown"
        run_dir = str(
            Path("/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin/runs")
            / f"wp09-{tid}"
        )
    # Exactly one line on stdout
    sys.stdout.write(f"{run_dir}\n")
    return 0


def cmd_allocate_evidence(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not path.is_file():
        return fail(2, f"missing transaction: {path}")
    data = load_txn(path)
    tid = data.get("transactionId")
    if not tid:
        return fail(2, "transactionId missing")
    root = Path(args.root)
    run_dir = root / f"wp09-{tid}"
    if args.exclusive_create:
        if run_dir.exists():
            return fail(3, f"evidence dir already exists (no-clobber): {run_dir}")
        run_dir.mkdir(parents=True, exist_ok=False)
    else:
        run_dir.mkdir(parents=True, exist_ok=True)

    pending = {
        "schemaVersion": "wp09-evidence/v1",
        "transactionId": tid,
        "runUuid": str(uuid.uuid4()),
        "pluginCommitSha": None,
        "verifierCommitSha": None,
        "certificate": {"sha256": None},
        "split": [],
        "tools": {"aapt": None, "apksigner": None, "zipalign": None},
    }
    pending_path = run_dir / "evidence.pending.json"
    if pending_path.exists() and args.exclusive_create:
        return fail(3, f"evidence.pending.json exists (no-clobber): {pending_path}")
    pending_path.write_text(json.dumps(pending, indent=2) + "\n", encoding="utf-8")

    data.setdefault("evidence", {})
    data["evidence"]["root"] = str(root)
    data["evidence"]["runDir"] = str(run_dir.resolve())
    data["revision"] = int(data.get("revision") or 1) + 1
    atomic_write(path, data)
    eprint(f"allocated {run_dir}")
    print(json.dumps({"ok": True, "command": "allocate-evidence", "path": str(run_dir)}))
    return 0


def cmd_assert_evidence_path(args: argparse.Namespace) -> int:
    path = Path(args.file)
    root = Path(args.root).resolve()
    candidate = Path(args.path).resolve()
    if not path.is_file():
        return fail(2, "transaction missing")
    data = load_txn(path)
    tid = data.get("transactionId")
    try:
        candidate.relative_to(root)
    except ValueError:
        return fail(4, f"path not contained in root: {candidate}")
    if f"wp09-{tid}" not in str(candidate):
        return fail(4, "path not bound to transactionId")
    if candidate.is_symlink():
        return fail(4, "evidence path must not be symlink")
    if not candidate.is_dir():
        return fail(4, f"not a directory: {candidate}")
    print(json.dumps({"ok": True, "command": "assert-evidence-path", "path": str(candidate)}))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not path.is_file():
        return fail(2, f"missing: {path}")
    data = load_txn(path)
    print(
        json.dumps(
            {
                "ok": True,
                "command": "status",
                "transactionId": data.get("transactionId"),
                "state": data.get("state"),
                "revision": data.get("revision"),
                "schema": data.get("schema"),
            }
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="wp09-transaction.py")
    sub = p.add_subparsers(dest="command", required=True)

    r = sub.add_parser("reconcile")
    r.add_argument("--file", required=True)
    r.add_argument("--create-if-missing", action="store_true")
    r.add_argument("--plugin-repo", default="")
    r.add_argument("--plugin-branch", default="")
    r.add_argument("--plugin-base", default="main")
    r.add_argument("--mineradio-repo", default="")
    r.add_argument("--mineradio-branch", default="")
    r.add_argument("--mineradio-base", default="huawei-android12-car")
    r.set_defaults(func=cmd_reconcile)

    a = sub.add_parser("allocate-evidence")
    a.add_argument("--file", required=True)
    a.add_argument("--root", required=True)
    a.add_argument("--exclusive-create", action="store_true")
    a.set_defaults(func=cmd_allocate_evidence)

    e = sub.add_parser("evidence-path")
    e.add_argument("--file", required=True)
    e.set_defaults(func=cmd_evidence_path)

    ae = sub.add_parser("assert-evidence-path")
    ae.add_argument("--file", required=True)
    ae.add_argument("--root", required=True)
    ae.add_argument("--path", required=True)
    ae.set_defaults(func=cmd_assert_evidence_path)

    s = sub.add_parser("status")
    s.add_argument("--file", required=True)
    s.set_defaults(func=cmd_status)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
