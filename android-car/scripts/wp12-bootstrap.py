#!/usr/bin/env python3
"""WP-12 dual-repo bootstrap surface (local freeze + dual-origin readback).

Fail-closed entrypoint for WP-12A preconditions:
  - worktree path + branch presence
  - baseSha freeze from known receipts (never guessed when missing)
  - local state ledger under a sandbox path (no origin mutation)
  - dual-origin ls-remote readback + tool blob checks before BOOTSTRAP_PUSHED

Commands:
  status       Print bootstrap ledger + worktree inventory (JSON)
  plan         Print required bootstrap plan (no side effects)
  init-local   Create / refresh local ledger only (NO push, NO BOOTSTRAP_PUSHED)
  assert-worktrees  Fail-closed path/branch check
  record-origin-readback  git ls-remote origin REF; durable-record; refuse mismatch
  assert-bootstrap-tools  prove bootstrap tooling blobs exist at commit SHA
  claim-bootstrap-pushed  set BOOTSTRAP_PUSHED only with dual readback + tool proofs

This tool never force-pushes, never forges BOOTSTRAP_PUSHED / EffectiveDone.
BOOTSTRAP_PUSHED becomes true only after both origins match expected SHAs and
bootstrap tooling is proven present at those commits (real dual-origin path).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, NoReturn

EXIT_FAIL = 2
SCHEMA = "wp12-bootstrap/v1"
LEDGER_MODE = 0o600
SOURCE_GIT_LS_REMOTE = "git-ls-remote"
SOURCE_GIT_CAT_FILE = "git-cat-file"
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
SHA_SHORT_RE = re.compile(r"^[0-9a-f]{7,40}$")

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

# Default origin refs for dual-origin bootstrap push proofs.
DEFAULT_PLUGIN_ORIGIN_REF = "refs/heads/main"
DEFAULT_MINERADIO_ORIGIN_REF = "refs/heads/huawei-android12-car"

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

# Minimum fail-closed prove set for origin tool checks (P0.5 dual push).
PLUGIN_ORIGIN_PROVE_FILES = (
    "scripts/wp12-transaction.py",
    "scripts/collect-wp12-evidence.py",
    "runtime-import/wp12-evidence.schema.json",
)
MINERADIO_ORIGIN_PROVE_FILES = (
    "android-car/scripts/wp12-bootstrap.py",
    "android-car/experimental/wp12/scripts/import-official-runtime.sh",
)

ROLES = frozenset({"plugin", "mineradio"})

# States from which claim-bootstrap-pushed may promote to BOOTSTRAP_PUSHED.
CLAIMABLE_PRIOR_STATES = frozenset(
    {
        "SCAFFOLD_ONLY",
        "BASESHA_FROZEN_LOCAL",
        "LOCAL_ONLY",
        "WORKTREES_VERIFIED",
    }
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


def normalize_sha(value: str | None, *, field: str = "sha") -> str:
    if not isinstance(value, str) or not value.strip():
        fail("INVALID_SHA_FORMAT", f"missing {field}")
    sha = value.strip().lower()
    if not SHA_SHORT_RE.fullmatch(sha):
        fail("INVALID_SHA_FORMAT", f"{field} must be 7-40 hex chars, got {value!r}")
    return sha


def sha_matches(expected: str, observed: str) -> bool:
    """Fail-closed equality: full match, or unambiguous short-prefix of a full SHA."""
    e = expected.lower().strip()
    o = observed.lower().strip()
    if e == o:
        return True
    if len(e) < 40 and len(o) == 40 and len(e) >= 7 and o.startswith(e):
        return True
    if len(o) < 40 and len(e) == 40 and len(o) >= 7 and e.startswith(o):
        return True
    return False


def worktree_for_role(args: argparse.Namespace, role: str) -> Path:
    if role == "plugin":
        return Path(args.plugin_worktree or DEFAULT_PLUGIN_WORKTREE)
    if role == "mineradio":
        return Path(args.mineradio_worktree or DEFAULT_MINERADIO_WORKTREE)
    fail("UNKNOWN_COMMAND", f"unknown role: {role}")


def prove_files_for_role(role: str) -> tuple[str, ...]:
    if role == "plugin":
        return PLUGIN_ORIGIN_PROVE_FILES
    if role == "mineradio":
        return MINERADIO_ORIGIN_PROVE_FILES
    fail("UNKNOWN_COMMAND", f"unknown role: {role}")


def readback_field_for_role(role: str) -> str:
    if role == "plugin":
        return "pluginOriginReadback"
    if role == "mineradio":
        return "mineradioOriginReadback"
    fail("UNKNOWN_COMMAND", f"unknown role: {role}")


def toolcheck_field_for_role(role: str) -> str:
    if role == "plugin":
        return "pluginToolCheck"
    if role == "mineradio":
        return "mineradioToolCheck"
    fail("UNKNOWN_COMMAND", f"unknown role: {role}")


def git_ls_remote_sha(repo: Path, ref: str, *, remote: str = "origin") -> dict[str, Any]:
    """Independent origin readback via `git ls-remote --refs`. Never trusts caller SHA."""
    if not repo.is_dir():
        fail("BLOCKED_GIT_STATE", f"worktree missing for ls-remote: {repo}")
    proc = run_git(repo, "ls-remote", "--refs", remote, ref, timeout=60)
    raw = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        fail(
            "LS_REMOTE_REQUIRED",
            f"git ls-remote failed ({proc.returncode}) for {remote} {ref}: "
            f"{(proc.stderr or proc.stdout or '').strip()}",
        )
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if not lines:
        fail("LS_REMOTE_REQUIRED", f"git ls-remote returned no refs for {remote} {ref}")
    # Prefer exact ref match when multiple lines appear.
    chosen = None
    for ln in lines:
        parts = ln.split()
        if len(parts) >= 2 and parts[1] == ref:
            chosen = parts[0]
            break
    if chosen is None:
        chosen = lines[0].split()[0]
    observed = normalize_sha(chosen, field="ls-remote observed")
    if not SHA40_RE.fullmatch(observed):
        fail("LS_REMOTE_REQUIRED", f"ls-remote did not return full SHA: {observed!r}")
    return {
        "ref": ref,
        "remote": remote,
        "observedSha": observed,
        "rawLines": lines,
        "source": SOURCE_GIT_LS_REMOTE,
        "capturedAt": utc_now_iso(),
        "worktree": str(repo),
        "rawStdout": (proc.stdout or "").strip(),
    }


def git_blob_exists(repo: Path, commit: str, rel_path: str) -> bool:
    proc = run_git(repo, "cat-file", "-e", f"{commit}:{rel_path}", timeout=30)
    return proc.returncode == 0


def git_show_blob_head(repo: Path, commit: str, rel_path: str, *, max_bytes: int = 64) -> str | None:
    proc = run_git(repo, "show", f"{commit}:{rel_path}", timeout=30)
    if proc.returncode != 0:
        return None
    # Binary-safe length probe only; content not logged in full.
    data = proc.stdout or ""
    return data[:max_bytes] if data else ""


def refuse_forged_claim_pushed(args: argparse.Namespace, *, command: str) -> None:
    """--claim-pushed and env BOOTSTRAP_PUSHED alone never promote state."""
    if getattr(args, "claim_pushed", False):
        fail(
            "FORGED_BOOTSTRAP_PUSHED",
            f"{command} refuses --claim-pushed; use claim-bootstrap-pushed with dual proofs",
        )
    if os.environ.get("BOOTSTRAP_PUSHED", "").lower() in {"1", "true", "yes"}:
        fail(
            "FORGED_BOOTSTRAP_PUSHED",
            f"{command} refuses env BOOTSTRAP_PUSHED; dual origin proofs required",
        )


def readback_matched(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    if entry.get("matched") is not True:
        return False
    expected = entry.get("expectedSha")
    observed = entry.get("observedSha")
    if not isinstance(expected, str) or not isinstance(observed, str):
        return False
    return sha_matches(expected, observed)


def toolcheck_passed(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    if entry.get("passed") is not True:
        return False
    if entry.get("complete") is not True:
        return False
    missing = entry.get("missing") or []
    return isinstance(missing, list) and len(missing) == 0


def dual_proofs_complete(ledger: Mapping[str, Any]) -> dict[str, Any]:
    plugin_rb = ledger.get("pluginOriginReadback")
    mineradio_rb = ledger.get("mineradioOriginReadback")
    plugin_tc = ledger.get("pluginToolCheck")
    mineradio_tc = ledger.get("mineradioToolCheck")
    return {
        "pluginOriginReadbackMatched": readback_matched(plugin_rb),
        "mineradioOriginReadbackMatched": readback_matched(mineradio_rb),
        "pluginToolCheckPassed": toolcheck_passed(plugin_tc),
        "mineradioToolCheckPassed": toolcheck_passed(mineradio_tc),
        "complete": (
            readback_matched(plugin_rb)
            and readback_matched(mineradio_rb)
            and toolcheck_passed(plugin_tc)
            and toolcheck_passed(mineradio_tc)
        ),
    }


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
        "pluginOriginReadback": None,
        "mineradioOriginReadback": None,
        "pluginToolCheck": None,
        "mineradioToolCheck": None,
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
    pushed = (ledger or {}).get("BOOTSTRAP_PUSHED") is True
    proofs = dual_proofs_complete(ledger or {})
    # Never allow ledger to claim push without dual proof fields (fail-closed read path).
    if pushed and not proofs["complete"]:
        pushed = False
        if state == "BOOTSTRAP_PUSHED":
            state = "LOCAL_ONLY"
    return emit_ok(
        "status",
        BOOTSTRAP_STATE=state,
        BOOTSTRAP_PUSHED=pushed,
        dualProofs=proofs,
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
    refuse_forged_claim_pushed(args, command="init-local")

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
    if existing.get("BOOTSTRAP_PUSHED") is True and dual_proofs_complete(existing)["complete"]:
        # Do not clobber a legitimately pushed ledger from this scaffold path.
        fail(
            "ILLEGAL_STATE",
            "ledger already claims BOOTSTRAP_PUSHED; use claim-bootstrap-pushed / status",
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

    # Preserve any prior dual-origin proofs (init-local must not wipe real readbacks).
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
        "pluginOriginReadback": existing.get("pluginOriginReadback"),
        "mineradioOriginReadback": existing.get("mineradioOriginReadback"),
        "pluginToolCheck": existing.get("pluginToolCheck"),
        "mineradioToolCheck": existing.get("mineradioToolCheck"),
        "notes": [
            "init-local only. BOOTSTRAP_STATE=BASESHA_FROZEN_LOCAL (or SCAFFOLD_ONLY).",
            "BOOTSTRAP_PUSHED remains false until dual exact origin readback + tool proofs.",
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


def cmd_record_origin_readback(args: argparse.Namespace) -> int:
    """Durable git ls-remote origin REF; refuse expected != observed."""
    refuse_forged_claim_pushed(args, command="record-origin-readback")
    role = (args.role or "").strip().lower()
    if role not in ROLES:
        fail("UNKNOWN_COMMAND", "record-origin-readback requires --role plugin|mineradio")
    ref = (args.ref or "").strip()
    if not ref:
        fail("LS_REMOTE_REQUIRED", "record-origin-readback requires --ref")
    expected = normalize_sha(args.expected_sha, field="--expected-sha")

    ledger_path = Path(args.ledger) if args.ledger else DEFAULT_LEDGER
    if not ledger_path.is_file():
        fail(
            "MISSING_RECEIPT",
            f"ledger missing; run init-local first: {ledger_path}",
        )
    ledger = load_ledger(ledger_path)
    repo = worktree_for_role(args, role)
    ls = git_ls_remote_sha(repo, ref, remote="origin")
    observed = ls["observedSha"]
    matched = sha_matches(expected, observed)
    entry = {
        "role": role,
        "ref": ref,
        "remote": "origin",
        "expectedSha": expected if len(expected) == 40 else expected,
        "observedSha": observed,
        "matched": matched,
        "source": SOURCE_GIT_LS_REMOTE,
        "capturedAt": ls["capturedAt"],
        "worktree": str(repo),
        "rawStdout": ls["rawStdout"],
        "rawLines": ls["rawLines"],
    }
    # Always durable-record the observation; refuse when mismatch (fail-closed).
    field = readback_field_for_role(role)
    ledger[field] = entry
    ledger["updatedAt"] = utc_now_iso()
    ledger["revision"] = int(ledger.get("revision") or 0) + 1
    # Never promote BOOTSTRAP_PUSHED from this command alone.
    if ledger.get("BOOTSTRAP_PUSHED") is True and not dual_proofs_complete(ledger)["complete"]:
        ledger["BOOTSTRAP_PUSHED"] = False
        if ledger.get("BOOTSTRAP_STATE") == "BOOTSTRAP_PUSHED":
            ledger["BOOTSTRAP_STATE"] = "BASESHA_FROZEN_LOCAL"
    atomic_write_json(ledger_path, ledger)

    if not matched:
        fail(
            "ORIGIN_SHA_MISMATCH",
            f"{role} origin readback mismatch: expected={expected} observed={observed} "
            f"ref={ref}",
        )
    return emit_ok(
        "record-origin-readback",
        role=role,
        ref=ref,
        expectedSha=expected,
        observedSha=observed,
        matched=True,
        ledger=str(ledger_path),
        revision=ledger["revision"],
        field=field,
        BOOTSTRAP_PUSHED=bool(ledger.get("BOOTSTRAP_PUSHED") is True),
    )


def cmd_assert_bootstrap_tools(args: argparse.Namespace) -> int:
    """Prove bootstrap tooling blobs exist at commit SHA (fail-closed)."""
    refuse_forged_claim_pushed(args, command="assert-bootstrap-tools")
    role = (args.role or "").strip().lower()
    if role not in ROLES:
        fail("UNKNOWN_COMMAND", "assert-bootstrap-tools requires --role plugin|mineradio")
    commit = normalize_sha(args.commit, field="--commit")

    ledger_path = Path(args.ledger) if args.ledger else DEFAULT_LEDGER
    if not ledger_path.is_file():
        fail(
            "MISSING_RECEIPT",
            f"ledger missing; run init-local first: {ledger_path}",
        )
    ledger = load_ledger(ledger_path)
    repo = worktree_for_role(args, role)
    if not repo.is_dir():
        fail("BLOCKED_GIT_STATE", f"worktree missing for tool assert: {repo}")

    # Resolve short commit to full object name when possible.
    rev = run_git(repo, "rev-parse", "--verify", f"{commit}^{{commit}}")
    if rev.returncode != 0:
        fail(
            "INVALID_SHA_FORMAT",
            f"commit not resolvable in {repo}: {commit} "
            f"({(rev.stderr or rev.stdout or '').strip()})",
        )
    full_commit = normalize_sha((rev.stdout or "").strip(), field="resolved commit")

    prove = list(prove_files_for_role(role))
    present: list[str] = []
    missing: list[str] = []
    probes: list[dict[str, Any]] = []
    for rel in prove:
        ok = git_blob_exists(repo, full_commit, rel)
        size_proc = (
            run_git(repo, "cat-file", "-s", f"{full_commit}:{rel}", timeout=30) if ok else None
        )
        size: int | None = None
        if size_proc is not None and size_proc.returncode == 0:
            try:
                size = int((size_proc.stdout or "").strip())
            except ValueError:
                size = None
        # Require a non-empty blob (empty file is not a real tool).
        blob_ok = ok and isinstance(size, int) and size > 0
        probes.append(
            {
                "path": rel,
                "exists": ok,
                "size": size,
                "blobOk": blob_ok,
            }
        )
        if blob_ok:
            present.append(rel)
        else:
            missing.append(rel)

    complete = len(missing) == 0
    entry = {
        "role": role,
        "commit": full_commit,
        "requestedCommit": commit,
        "proveFiles": prove,
        "present": present,
        "missing": missing,
        "complete": complete,
        "passed": complete,
        "probes": probes,
        "source": SOURCE_GIT_CAT_FILE,
        "capturedAt": utc_now_iso(),
        "worktree": str(repo),
    }
    field = toolcheck_field_for_role(role)
    ledger[field] = entry
    ledger["updatedAt"] = utc_now_iso()
    ledger["revision"] = int(ledger.get("revision") or 0) + 1
    if ledger.get("BOOTSTRAP_PUSHED") is True and not dual_proofs_complete(ledger)["complete"]:
        ledger["BOOTSTRAP_PUSHED"] = False
        if ledger.get("BOOTSTRAP_STATE") == "BOOTSTRAP_PUSHED":
            ledger["BOOTSTRAP_STATE"] = "BASESHA_FROZEN_LOCAL"
    atomic_write_json(ledger_path, ledger)

    if not complete:
        fail(
            "PLUGIN_BOOTSTRAP_FILES_INCOMPLETE"
            if role == "plugin"
            else "BOOTSTRAP_TOOLS_INCOMPLETE",
            f"{role} bootstrap tools missing at {full_commit}: {','.join(missing)}",
        )
    return emit_ok(
        "assert-bootstrap-tools",
        role=role,
        commit=full_commit,
        present=present,
        missing=missing,
        complete=True,
        passed=True,
        ledger=str(ledger_path),
        revision=ledger["revision"],
        field=field,
        BOOTSTRAP_PUSHED=bool(ledger.get("BOOTSTRAP_PUSHED") is True),
    )


def cmd_claim_bootstrap_pushed(args: argparse.Namespace) -> int:
    """Set BOOTSTRAP_PUSHED only with dual origin readback + tool proofs.

    Never accepts --claim-pushed / env alone. Prior state must be claimable.
    """
    # Explicit trap: --claim-pushed is a forge path and is always refused.
    if getattr(args, "claim_pushed", False):
        fail(
            "FORGED_BOOTSTRAP_PUSHED",
            "claim-bootstrap-pushed refuses --claim-pushed flag; "
            "dual origin proofs on the ledger are the only authority",
        )
    if os.environ.get("BOOTSTRAP_PUSHED", "").lower() in {"1", "true", "yes"}:
        # Env alone must not force true; still allow real proof path to proceed
        # only when proofs are complete (checked below). Env is ignored as authority.
        pass

    ledger_path = Path(args.ledger) if args.ledger else DEFAULT_LEDGER
    if not ledger_path.is_file():
        fail("MISSING_RECEIPT", f"ledger missing; run init-local first: {ledger_path}")
    ledger = load_ledger(ledger_path)
    prior_state = ledger.get("BOOTSTRAP_STATE") or "SCAFFOLD_ONLY"
    prior_pushed = ledger.get("BOOTSTRAP_PUSHED") is True
    proofs = dual_proofs_complete(ledger)

    if prior_pushed and proofs["complete"] and prior_state == "BOOTSTRAP_PUSHED":
        return emit_ok(
            "claim-bootstrap-pushed",
            BOOTSTRAP_STATE="BOOTSTRAP_PUSHED",
            BOOTSTRAP_PUSHED=True,
            idempotent=True,
            dualProofs=proofs,
            ledger=str(ledger_path),
            revision=ledger.get("revision"),
            pluginOriginReadback=ledger.get("pluginOriginReadback"),
            mineradioOriginReadback=ledger.get("mineradioOriginReadback"),
            pluginToolCheck=ledger.get("pluginToolCheck"),
            mineradioToolCheck=ledger.get("mineradioToolCheck"),
        )

    if prior_state not in CLAIMABLE_PRIOR_STATES and prior_state != "BOOTSTRAP_PUSHED":
        fail(
            "ILLEGAL_STATE",
            f"cannot claim BOOTSTRAP_PUSHED from state={prior_state!r}; "
            f"allowed prior: {sorted(CLAIMABLE_PRIOR_STATES)}",
        )

    if not proofs["complete"]:
        missing_bits = [k for k, v in proofs.items() if k != "complete" and not v]
        fail(
            "BOOTSTRAP_PUSHED_UNPROVEN",
            "dual origin proofs incomplete: " + ",".join(missing_bits),
        )

    # Cross-check: tool check commits should match the origin readback SHAs.
    for role, rb_key, tc_key in (
        ("plugin", "pluginOriginReadback", "pluginToolCheck"),
        ("mineradio", "mineradioOriginReadback", "mineradioToolCheck"),
    ):
        rb = ledger.get(rb_key) or {}
        tc = ledger.get(tc_key) or {}
        rb_sha = rb.get("observedSha")
        tc_sha = tc.get("commit")
        if not (isinstance(rb_sha, str) and isinstance(tc_sha, str) and sha_matches(rb_sha, tc_sha)):
            fail(
                "ORIGIN_SHA_MISMATCH",
                f"{role} tool-check commit does not match origin readback: "
                f"readback={rb_sha} toolCheck={tc_sha}",
            )

    now = utc_now_iso()
    ledger["BOOTSTRAP_PUSHED"] = True
    ledger["BOOTSTRAP_STATE"] = "BOOTSTRAP_PUSHED"
    ledger["EffectiveDone"] = False  # never forge EffectiveDone here
    ledger["updatedAt"] = now
    ledger["revision"] = int(ledger.get("revision") or 0) + 1
    notes = list(ledger.get("notes") or [])
    notes.append(
        f"{now}: claim-bootstrap-pushed accepted with dual origin readback + tool proofs."
    )
    ledger["notes"] = notes
    # Clear blockers that are resolved by dual push proofs.
    blockers = [
        b
        for b in (ledger.get("blockers") or [])
        if b
        not in {
            "PLUGIN_BOOTSTRAP_FILES_INCOMPLETE",
            "BOOTSTRAP_TOOLS_INCOMPLETE",
        }
    ]
    ledger["blockers"] = blockers
    ledger["claimBootstrapPushed"] = {
        "claimedAt": now,
        "priorState": prior_state,
        "dualProofs": proofs,
        "source": "claim-bootstrap-pushed",
    }
    atomic_write_json(ledger_path, ledger)
    return emit_ok(
        "claim-bootstrap-pushed",
        BOOTSTRAP_STATE="BOOTSTRAP_PUSHED",
        BOOTSTRAP_PUSHED=True,
        EffectiveDone=False,
        dualProofs=proofs,
        ledger=str(ledger_path),
        revision=ledger["revision"],
        pluginOriginReadback=ledger.get("pluginOriginReadback"),
        mineradioOriginReadback=ledger.get("mineradioOriginReadback"),
        pluginToolCheck=ledger.get("pluginToolCheck"),
        mineradioToolCheck=ledger.get("mineradioToolCheck"),
    )


COMMANDS = {
    "status": cmd_status,
    "plan": cmd_plan,
    "init-local": cmd_init_local,
    "assert-worktrees": cmd_assert_worktrees,
    "record-origin-readback": cmd_record_origin_readback,
    "assert-bootstrap-tools": cmd_assert_bootstrap_tools,
    "claim-bootstrap-pushed": cmd_claim_bootstrap_pushed,
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="wp12-bootstrap.py")
    parser.add_argument("command", choices=sorted(COMMANDS.keys()))
    parser.add_argument("--plugin-worktree", default=DEFAULT_PLUGIN_WORKTREE)
    parser.add_argument("--mineradio-worktree", default=DEFAULT_MINERADIO_WORKTREE)
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    parser.add_argument(
        "--role",
        choices=sorted(ROLES),
        default=None,
        help="plugin|mineradio for origin readback / tool assert",
    )
    parser.add_argument(
        "--ref",
        default=None,
        help="git ref for record-origin-readback (e.g. refs/heads/main)",
    )
    parser.add_argument(
        "--expected-sha",
        default=None,
        dest="expected_sha",
        help="expected origin SHA for record-origin-readback",
    )
    parser.add_argument(
        "--commit",
        default=None,
        help="commit SHA for assert-bootstrap-tools",
    )
    parser.add_argument(
        "--claim-pushed",
        action="store_true",
        help=argparse.SUPPRESS,  # trap; always rejected as forge path
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    if not argv:
        fail(
            "UNKNOWN_COMMAND",
            "missing command (status|plan|init-local|assert-worktrees|"
            "record-origin-readback|assert-bootstrap-tools|claim-bootstrap-pushed)",
        )
    args = parse_args(argv)
    return COMMANDS[args.command](args)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — never silently swallow
        emit_failure("ILLEGAL_STATE", f"unhandled error: {exc}")
