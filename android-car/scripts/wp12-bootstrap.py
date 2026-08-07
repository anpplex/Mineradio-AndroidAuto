#!/usr/bin/env python3
"""WP-12 dual-repo bootstrap surface (scaffold / local dry-run).

Fail-closed entrypoint for WP-12A preconditions:
  - worktree path + branch presence
  - baseSha freeze from known receipts (never guessed when missing)
  - local state ledger under a sandbox path (no origin mutation)

Commands:
  status       Print bootstrap ledger + worktree inventory (JSON)
  plan         Print required bootstrap plan (no side effects)
  init-local   Create / refresh local ledger only (NO push, NO BOOTSTRAP_PUSHED)
  assert-worktrees  Fail-closed path/branch check

This tool never force-pushes, never forges BOOTSTRAP_PUSHED / EffectiveDone.
BOOTSTRAP_STATE remains SCAFFOLD_ONLY or LOCAL_ONLY until a real dual-repo
exact push+readback is performed by a human-approved pipeline.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, NoReturn

EXIT_FAIL = 2
SCHEMA = "wp12-bootstrap/v1"
LEDGER_MODE = 0o600

# Frozen expected surfaces from WP-12A brief (do not invent alternatives as "ok").
DEFAULT_PLUGIN_WORKTREE = (
    "/Users/anpple/Codex/WallpaperEngine/.worktrees/mineradio-plugin-embedded-runtime"
)
DEFAULT_MINERADIO_WORKTREE = (
    "/Users/anpple/Codex/Mineradio/.worktrees/wallpaper-plugin-experimental"
)
# Legacy brief name; keep as primary label for ledger/docs.
EXPECTED_PLUGIN_BRANCH = "codex/mineradio-plugin-embedded-runtime"
# Actual WP-12A plugin PR / worktree branch observed on the embedded-runtime worktree.
PLUGIN_BRANCH_WP12A = "codex/wallpaper-plugin-embedded-runtime-wp12a"
# Accept either name — do not rename remote branch; document both as aliases.
ACCEPTED_PLUGIN_BRANCHES = frozenset(
    {
        EXPECTED_PLUGIN_BRANCH,  # legacy brief
        PLUGIN_BRANCH_WP12A,  # observed PR branch
    }
)
# Experimental worktree may already be on a WP-12A working branch; status reports both.
EXPECTED_MINERADIO_BRANCH = "codex/wallpaper-plugin-experimental"

# Receipt anchors for baseSha freeze (read-only; missing → reported, not invented).
WP09_PLUGIN_CLOSE = Path(
    "/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin"
    "/bootstrap/WP-09-CLOSE-VERIFY-FINAL.json"
)
WP11B_E6_CLOSE = Path(
    "/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin"
    "/runs/wp-11b-e6-green-20260803T135324Z/CLOSE-SUMMARY.json"
)

# Default local ledger (under Mineradio verification runs; not a product claim).
DEFAULT_LEDGER = Path(
    "/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin"
    "/runs/wp-12a-bootstrap-local.json"
)

# Bootstrap product files expected on Plugin worktree after real bootstrap commit.
PLUGIN_BOOTSTRAP_FILES = (
    "runtime-import/wp12-evidence.schema.json",
    "runtime-import/wp12-evidence-contract.json",
    "scripts/wp12-transaction.py",
    "scripts/collect-wp12-evidence.py",
    "scripts/seal-wp12-evidence.py",
    "scripts/update-wp12-progress.py",
    "scripts/tests/test-wp12-evidence.py",
)

LEGAL_BOOTSTRAP_STATES = frozenset(
    {
        "SCAFFOLD_ONLY",
        "LOCAL_ONLY",
        "WORKTREES_VERIFIED",
        "BASESHA_FROZEN_LOCAL",
        "BOOTSTRAP_PUSHED",  # only after real dual push+readback
    }
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def emit_failure(reason: str, message: str = "", exit_code: int = EXIT_FAIL) -> NoReturn:
    payload = {"ok": False, "failureReason": reason, "message": message or reason}
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    print(text, file=sys.stderr)
    print(text, file=sys.stdout)
    raise SystemExit(exit_code)


def fail(reason: str, message: str = "") -> NoReturn:
    emit_failure(reason, message)


def emit_ok(command: str, **fields: Any) -> int:
    payload = {"ok": True, "command": command, **fields}
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


def run_git(repo: Path, *args: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def atomic_write_json(path: Path, value: Mapping[str, Any], mode: int = LEDGER_MODE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def inspect_worktree(
    path: str,
    expected_branch: str,
    *,
    accepted_branches: frozenset[str] | None = None,
) -> dict[str, Any]:
    """Probe a worktree path/branch.

    expected_branch is the primary/legacy label reported in inventory.
    accepted_branches (if set) is the fail-closed allow-list for matchBranch;
    when None, only expected_branch is accepted.
    """
    allowed = accepted_branches if accepted_branches is not None else frozenset({expected_branch})
    root = Path(path)
    info: dict[str, Any] = {
        "path": path,
        "exists": root.is_dir(),
        "expectedBranch": expected_branch,
        "acceptedBranches": sorted(allowed),
        "branch": None,
        "head": None,
        "dirty": None,
        "matchBranch": False,
        "ok": False,
        "blockers": [],
    }
    if not root.is_dir():
        info["blockers"].append("MISSING_WORKTREE")
        return info
    if not (root / ".git").exists():
        info["blockers"].append("NOT_A_GIT_WORKTREE")
        return info

    br = run_git(root, "branch", "--show-current")
    head = run_git(root, "rev-parse", "HEAD")
    porcelain = run_git(root, "status", "--porcelain")
    if br.returncode != 0 or head.returncode != 0:
        info["blockers"].append("GIT_PROBE_FAILED")
        return info

    info["branch"] = (br.stdout or "").strip() or None
    info["head"] = (head.stdout or "").strip() or None
    dirty_lines = [ln for ln in (porcelain.stdout or "").splitlines() if ln.strip()]
    info["dirty"] = len(dirty_lines)
    info["matchBranch"] = info["branch"] in allowed if info["branch"] else False
    if not info["matchBranch"]:
        info["blockers"].append("BRANCH_MISMATCH")
    # dirty is reported but not a hard blocker for status/plan; init-local still records it
    # Treat BRANCH_MISMATCH as soft for inventory ok (still surfaces in blockers list).
    info["ok"] = info["exists"] and "MISSING_WORKTREE" not in info["blockers"]
    return info


def resolve_plugin_base_sha() -> dict[str, Any]:
    """Plugin baseSha from WP-09 merge base-containment / close receipt."""
    data = load_json(WP09_PLUGIN_CLOSE)
    out: dict[str, Any] = {
        "source": str(WP09_PLUGIN_CLOSE),
        "baseSha": None,
        "found": False,
        "fields": {},
    }
    if not data:
        out["error"] = "MISSING_OR_UNREADABLE_RECEIPT"
        return out
    impl = data.get("implementation") if isinstance(data.get("implementation"), dict) else {}
    sha = impl.get("pluginMergeSha") or data.get("pluginMergeSha")
    out["fields"] = {
        "pluginMergeSha": impl.get("pluginMergeSha"),
        "pluginPr": impl.get("pluginPr"),
        "liveBaseSha": data.get("liveBaseSha"),
        "EffectiveDone": data.get("EffectiveDone"),
    }
    if isinstance(sha, str) and len(sha) >= 7:
        out["baseSha"] = sha
        out["found"] = True
    else:
        out["error"] = "BASESHA_FIELD_MISSING"
    return out


def resolve_mineradio_base_sha() -> dict[str, Any]:
    """Mineradio baseSha from WP-11B E6 authoritative close summary."""
    data = load_json(WP11B_E6_CLOSE)
    out: dict[str, Any] = {
        "source": str(WP11B_E6_CLOSE),
        "baseSha": None,
        "found": False,
        "fields": {},
    }
    if not data:
        out["error"] = "MISSING_OR_UNREADABLE_RECEIPT"
        return out
    sha = data.get("liveBaseSha")
    out["fields"] = {
        "liveBaseSha": data.get("liveBaseSha"),
        "EffectiveDone": data.get("EffectiveDone"),
        "evidenceLevel": data.get("evidenceLevel"),
        "state": data.get("state"),
    }
    if isinstance(sha, str) and len(sha) >= 7:
        out["baseSha"] = sha
        out["found"] = True
    else:
        out["error"] = "BASESHA_FIELD_MISSING"
    return out


def plugin_tooling_inventory(plugin_root: str) -> dict[str, Any]:
    root = Path(plugin_root)
    present = []
    missing = []
    for rel in PLUGIN_BOOTSTRAP_FILES:
        p = root / rel
        if p.is_file():
            present.append(rel)
        else:
            missing.append(rel)
    return {
        "present": present,
        "missing": missing,
        "complete": not missing,
    }


def empty_ledger() -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "taskId": "WP-12-BOOTSTRAP",
        "BOOTSTRAP_STATE": "SCAFFOLD_ONLY",
        "BOOTSTRAP_PUSHED": False,
        "EffectiveDone": False,
        "revision": 1,
        "transactionId": None,
        "runUuid": None,
        "createdAt": None,
        "updatedAt": None,
        "plugin": {
            "worktree": DEFAULT_PLUGIN_WORKTREE,
            "expectedBranch": EXPECTED_PLUGIN_BRANCH,
            "acceptedBranches": sorted(ACCEPTED_PLUGIN_BRANCHES),
            "observedBranch": None,
            "head": None,
            "baseSha": None,
            "baseShaSource": None,
        },
        "mineradio": {
            "worktree": DEFAULT_MINERADIO_WORKTREE,
            "expectedBranch": EXPECTED_MINERADIO_BRANCH,
            "acceptedBranches": [EXPECTED_MINERADIO_BRANCH],
            "observedBranch": None,
            "head": None,
            "baseSha": None,
            "baseShaSource": None,
        },
        "tooling": {"pluginBootstrapFilesComplete": False},
        "notes": [
            "Scaffold ledger only. BOOTSTRAP_PUSHED requires dual-repo exact push+readback.",
            "Do not forge EffectiveDone or BOOTSTRAP_PUSHED.",
        ],
        "blockers": [],
    }


def load_ledger(path: Path) -> dict[str, Any]:
    data = load_json(path)
    if data is None:
        return empty_ledger()
    if data.get("schema") != SCHEMA:
        # tolerate missing schema on empty drafts
        if "BOOTSTRAP_STATE" not in data:
            fail("ILLEGAL_STATE", f"ledger schema mismatch: {path}")
    return data


def inventory(args: argparse.Namespace) -> dict[str, Any]:
    plugin_wt = args.plugin_worktree or DEFAULT_PLUGIN_WORKTREE
    mineradio_wt = args.mineradio_worktree or DEFAULT_MINERADIO_WORKTREE
    plugin = inspect_worktree(
        plugin_wt,
        EXPECTED_PLUGIN_BRANCH,
        accepted_branches=ACCEPTED_PLUGIN_BRANCHES,
    )
    mineradio = inspect_worktree(mineradio_wt, EXPECTED_MINERADIO_BRANCH)
    plugin_base = resolve_plugin_base_sha()
    mineradio_base = resolve_mineradio_base_sha()
    tooling = plugin_tooling_inventory(plugin_wt)

    blockers: list[str] = []
    if not plugin["exists"]:
        blockers.append("PLUGIN_WORKTREE_MISSING")
    if not mineradio["exists"]:
        blockers.append("MINERADIO_WORKTREE_MISSING")
    if not plugin_base.get("found"):
        blockers.append("PLUGIN_BASESHA_UNRESOLVED")
    if not mineradio_base.get("found"):
        blockers.append("MINERADIO_BASESHA_UNRESOLVED")
    if not tooling["complete"]:
        blockers.append("PLUGIN_BOOTSTRAP_FILES_INCOMPLETE")
    # PLUGIN_BRANCH_MISMATCH only when observed branch is outside accepted aliases
    # (legacy brief name OR actual WP-12A PR branch).
    if plugin.get("branch") and plugin["branch"] not in ACCEPTED_PLUGIN_BRANCHES:
        blockers.append("PLUGIN_BRANCH_MISMATCH")
    if mineradio.get("branch") and mineradio["branch"] != EXPECTED_MINERADIO_BRANCH:
        blockers.append("MINERADIO_BRANCH_MISMATCH")

    return {
        "pluginWorktree": plugin,
        "mineradioWorktree": mineradio,
        "pluginBaseSha": plugin_base,
        "mineradioBaseSha": mineradio_base,
        "tooling": tooling,
        "blockers": blockers,
        "BOOTSTRAP_STATE": "SCAFFOLD_ONLY",
        "BOOTSTRAP_PUSHED": False,
        "note": "Inventory is local dry-run; no origin mutation performed.",
    }


def cmd_status(args: argparse.Namespace) -> int:
    ledger_path = Path(args.ledger) if args.ledger else DEFAULT_LEDGER
    inv = inventory(args)
    ledger = load_ledger(ledger_path) if ledger_path.is_file() else None
    state = (ledger or {}).get("BOOTSTRAP_STATE") or "SCAFFOLD_ONLY"
    pushed = bool((ledger or {}).get("BOOTSTRAP_PUSHED"))
    # Never allow ledger to claim push without dual proof fields (fail-closed read path).
    if pushed:
        if not (ledger or {}).get("pluginOriginReadback") or not (ledger or {}).get(
            "mineradioOriginReadback"
        ):
            pushed = False
            state = "LOCAL_ONLY"
    return emit_ok(
        "status",
        BOOTSTRAP_STATE=state,
        BOOTSTRAP_PUSHED=pushed,
        ledger=str(ledger_path) if ledger else None,
        inventory=inv,
        ledgerSnapshot=ledger,
    )


def cmd_plan(args: argparse.Namespace) -> int:
    inv = inventory(args)
    steps = [
        {
            "id": "P0.1",
            "action": "assert both worktrees exist; resolve baseSha from WP-09 + WP-11B E6 receipts",
            "mode": "local",
        },
        {
            "id": "P0.2",
            "action": "init-local ledger freezes paths + baseSha (BOOTSTRAP_STATE=LOCAL_ONLY)",
            "mode": "local",
        },
        {
            "id": "P0.3",
            "action": "Plugin bootstrap RED→GREEN→VERIFY on ignore + schema + test-wp12-evidence.py",
            "mode": "plugin-worktree",
        },
        {
            "id": "P0.4",
            "action": "Human APPROVED_INDEX_TREE → commit bootstrap allowlist only",
            "mode": "human-gate",
        },
        {
            "id": "P0.5",
            "action": "Exact push + origin readback plugin then mineradio (no force-push)",
            "mode": "network-human-approved",
        },
        {
            "id": "P0.6",
            "action": "Only then set BOOTSTRAP_PUSHED=true with dual readback proofs",
            "mode": "gate",
        },
        {
            "id": "P0.7",
            "action": "wp12-transaction.py init --task WP-12A → TREE_FROZEN",
            "mode": "depends-on-BOOTSTRAP_PUSHED",
        },
    ]
    return emit_ok(
        "plan",
        BOOTSTRAP_STATE="SCAFFOLD_ONLY",
        BOOTSTRAP_PUSHED=False,
        inventory=inv,
        steps=steps,
        serialBarriers=[
            "BOOTSTRAP_PUSHED",
            "TREE_FROZEN",
            "RED_RECORDED",
            "GREEN_RECORDED",
            "REFACTOR_RECORDED",
            "VERIFIED",
            "DONE",
        ],
    )


def cmd_assert_worktrees(args: argparse.Namespace) -> int:
    inv = inventory(args)
    hard = [
        b
        for b in inv["blockers"]
        if b
        in {
            "PLUGIN_WORKTREE_MISSING",
            "MINERADIO_WORKTREE_MISSING",
        }
    ]
    if hard:
        fail("BLOCKED_GIT_STATE", f"worktree assert failed: {','.join(hard)}")
    return emit_ok(
        "assert-worktrees",
        BOOTSTRAP_STATE="SCAFFOLD_ONLY",
        inventory={
            "pluginWorktree": inv["pluginWorktree"],
            "mineradioWorktree": inv["mineradioWorktree"],
            "blockers": inv["blockers"],
        },
    )


def cmd_init_local(args: argparse.Namespace) -> int:
    """Local-only ledger freeze. NEVER sets BOOTSTRAP_PUSHED."""
    if args.claim_pushed:
        fail("FORGED_BOOTSTRAP_PUSHED", "init-local refuses --claim-pushed")
    if os.environ.get("BOOTSTRAP_PUSHED", "").lower() in {"1", "true", "yes"}:
        fail("FORGED_BOOTSTRAP_PUSHED", "refusing env BOOTSTRAP_PUSHED on init-local")

    ledger_path = Path(args.ledger) if args.ledger else DEFAULT_LEDGER
    inv = inventory(args)

    if not inv["pluginWorktree"]["exists"] or not inv["mineradioWorktree"]["exists"]:
        fail(
            "BLOCKED_GIT_STATE",
            "both worktrees must exist before init-local",
        )
    if not inv["pluginBaseSha"].get("found") or not inv["mineradioBaseSha"].get("found"):
        fail(
            "MISSING_RECEIPT",
            "cannot freeze baseSha without WP-09 + WP-11B E6 receipts",
        )

    now = utc_now_iso()
    existing = load_ledger(ledger_path) if ledger_path.is_file() else empty_ledger()
    if existing.get("BOOTSTRAP_PUSHED") is True:
        # Do not clobber a legitimately pushed ledger from this scaffold path.
        fail(
            "ILLEGAL_STATE",
            "ledger already claims BOOTSTRAP_PUSHED; use verify-bootstrap (not scaffold)",
        )

    txn_id = existing.get("transactionId") or str(uuid.uuid4())
    run_uuid = existing.get("runUuid") or str(uuid.uuid4())
    revision = int(existing.get("revision") or 0) + 1

    # Soft branch mismatch is recorded as blocker, not silent success.
    state = "BASESHA_FROZEN_LOCAL"
    blockers = list(inv["blockers"])
    # After freeze, remove basesha incompleteness from blockers
    blockers = [
        b
        for b in blockers
        if b
        not in {
            "PLUGIN_BASESHA_UNRESOLVED",
            "MINERADIO_BASESHA_UNRESOLVED",
            "PLUGIN_BOOTSTRAP_FILES_INCOMPLETE",
        }
    ]
    # Tooling incompleteness is expected pre-push; keep as note not hard fail for LOCAL_ONLY
    if not inv["tooling"]["complete"]:
        blockers.append("PLUGIN_BOOTSTRAP_FILES_INCOMPLETE")

    ledger = {
        "schema": SCHEMA,
        "taskId": "WP-12-BOOTSTRAP",
        "BOOTSTRAP_STATE": state,
        "BOOTSTRAP_PUSHED": False,
        "EffectiveDone": False,
        "revision": revision,
        "transactionId": txn_id,
        "runUuid": run_uuid,
        "createdAt": existing.get("createdAt") or now,
        "updatedAt": now,
        "plugin": {
            "worktree": inv["pluginWorktree"]["path"],
            "expectedBranch": EXPECTED_PLUGIN_BRANCH,
            "acceptedBranches": sorted(ACCEPTED_PLUGIN_BRANCHES),
            "observedBranch": inv["pluginWorktree"].get("branch"),
            "head": inv["pluginWorktree"].get("head"),
            "dirty": inv["pluginWorktree"].get("dirty"),
            "baseSha": inv["pluginBaseSha"]["baseSha"],
            "baseShaSource": inv["pluginBaseSha"]["source"],
        },
        "mineradio": {
            "worktree": inv["mineradioWorktree"]["path"],
            "expectedBranch": EXPECTED_MINERADIO_BRANCH,
            "acceptedBranches": [EXPECTED_MINERADIO_BRANCH],
            "observedBranch": inv["mineradioWorktree"].get("branch"),
            "head": inv["mineradioWorktree"].get("head"),
            "dirty": inv["mineradioWorktree"].get("dirty"),
            "baseSha": inv["mineradioBaseSha"]["baseSha"],
            "baseShaSource": inv["mineradioBaseSha"]["source"],
        },
        "tooling": {
            "pluginBootstrapFilesComplete": inv["tooling"]["complete"],
            "present": inv["tooling"]["present"],
            "missing": inv["tooling"]["missing"],
        },
        "pluginOriginReadback": None,
        "mineradioOriginReadback": None,
        "notes": [
            "init-local only. BOOTSTRAP_STATE=BASESHA_FROZEN_LOCAL (or SCAFFOLD_ONLY).",
            "BOOTSTRAP_PUSHED remains false until dual exact origin readback.",
            "No force-push. No forged EffectiveDone.",
        ],
        "blockers": blockers,
    }
    atomic_write_json(ledger_path, ledger)
    return emit_ok(
        "init-local",
        BOOTSTRAP_STATE=state,
        BOOTSTRAP_PUSHED=False,
        ledger=str(ledger_path),
        transactionId=txn_id,
        runUuid=run_uuid,
        revision=revision,
        pluginBaseSha=ledger["plugin"]["baseSha"],
        mineradioBaseSha=ledger["mineradio"]["baseSha"],
        blockers=blockers,
    )


COMMANDS = {
    "status": cmd_status,
    "plan": cmd_plan,
    "init-local": cmd_init_local,
    "assert-worktrees": cmd_assert_worktrees,
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="wp12-bootstrap.py")
    parser.add_argument("command", choices=sorted(COMMANDS.keys()))
    parser.add_argument("--plugin-worktree", default=DEFAULT_PLUGIN_WORKTREE)
    parser.add_argument("--mineradio-worktree", default=DEFAULT_MINERADIO_WORKTREE)
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    parser.add_argument(
        "--claim-pushed",
        action="store_true",
        help=argparse.SUPPRESS,  # trap; always rejected
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    if not argv:
        fail("UNKNOWN_COMMAND", "missing command (status|plan|init-local|assert-worktrees)")
    args = parse_args(argv)
    return COMMANDS[args.command](args)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — never silently swallow
        emit_failure("ILLEGAL_STATE", f"unhandled error: {exc}")
