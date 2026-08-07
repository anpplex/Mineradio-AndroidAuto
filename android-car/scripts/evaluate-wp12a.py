#!/usr/bin/env python3
"""WP-12A evaluate surface (fail-closed skeleton / proof checklist).

Scaffold only: defines the pre-verify-done proof gates for experimental WP-12A.
This tool:

  - never prints EffectiveDone=true (verify-done wiring point is future work)
  - reports readyForEffectiveDone only when every required gate is PASS
  - never force-pushes, never mutates origin, never forges BOOTSTRAP_PUSHED

CLI:
  python3 evaluate-wp12a.py --help
  python3 evaluate-wp12a.py check          # default command
  python3 evaluate-wp12a.py                # same as check

Exit codes:
  0  evaluation report produced successfully (ok:true), even when
     readyForEffectiveDone is false
  2  tool error (bad args, unhandled exception, unreadable catalog, etc.)

JSON contract (ok report):
  {
    "ok": true,
    "command": "check",
    "taskId": "WP-12A",
    "readyForEffectiveDone": false,
    "EffectiveDone": false,
    "checks": [ { "id", "name", "status": "PASS|FAIL|SKIP", ... } ],
    "blockers": [ ... ],
    "notes": [ ... ]
  }
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, NoReturn, Sequence

EXIT_TOOL = 2
TASK_ID = "WP-12A"
EXPECTED_WEIGHT = 25
SCHEMA_VERSION = "wp12a-manifest-map/v1"
# Official WE client inventory pin (full lowercase hex).
EXPECTED_APK_SHA256 = (
    "6982c82745444c5f2eef5a3d8c89ad807360bb5849a133548a6b25d18f4c4cb0"
)
EXPECTED_APK_SHA256_PREFIX = "6982c827"

DEFAULT_PLUGIN_WORKTREE = (
    "/Users/anpple/Codex/WallpaperEngine/.worktrees/mineradio-plugin-embedded-runtime"
)
DEFAULT_MINERADIO_WORKTREE = (
    "/Users/anpple/Codex/Mineradio/.worktrees/wallpaper-plugin-experimental"
)
DEFAULT_CATALOG = Path(__file__).resolve().parent / "wallpaper-plugin-tasks.json"
DEFAULT_BOOTSTRAP_LEDGER = Path(
    "/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin"
    "/runs/wp-12a-bootstrap-local.json"
)
DEFAULT_INVENTORY = Path(
    "/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin"
    "/runs/wp-12a-inventory-official-v1/inventory.json"
)

# Catalog exactFiles for WP-12A (also loaded from catalog when present).
FALLBACK_EXACT_FILES: tuple[str, ...] = (
    "runtime-import/manifest-map.schema.json",
    "scripts/import-official-runtime.sh",
    "scripts/verify-imported-runtime.sh",
    "scripts/tests/test-runtime-import.sh",
    "scripts/tests/fixtures/manifest-missing-dex.json",
    "scripts/tests/fixtures/manifest-authority-conflict.json",
    "scripts/tests/fixtures/manifest-unknown-signature-permission.json",
    "scripts/tests/fixtures/manifest-resource-id-conflict.json",
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def emit_tool_failure(reason: str, message: str = "") -> NoReturn:
    payload = {
        "ok": False,
        "failureReason": reason,
        "message": message or reason,
        "EffectiveDone": False,
        "readyForEffectiveDone": False,
    }
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    print(text, file=sys.stderr)
    print(text, file=sys.stdout)
    raise SystemExit(EXIT_TOOL)


def emit_report(**fields: Any) -> int:
    """Always force EffectiveDone=false on this scaffold surface."""
    payload: dict[str, Any] = {
        "ok": True,
        "taskId": TASK_ID,
        "EffectiveDone": False,  # scaffold: never true here
        **fields,
    }
    # Hard fail-closed: never allow accidental EffectiveDone promotion.
    payload["EffectiveDone"] = False
    if payload.get("readyForEffectiveDone") is True:
        # Skeleton may compute readiness, but still never claims done.
        pass
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def run_cmd(
    argv: Sequence[str],
    *,
    cwd: str | Path | None = None,
    timeout: int = 120,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(argv),
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def run_git(repo: Path, *args: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return run_cmd(["git", "-C", str(repo), *args], timeout=timeout)


def check_result(
    check_id: str,
    name: str,
    status: str,
    **extra: Any,
) -> dict[str, Any]:
    if status not in {"PASS", "FAIL", "SKIP"}:
        raise ValueError(f"invalid status {status!r}")
    out: dict[str, Any] = {"id": check_id, "name": name, "status": status}
    out.update(extra)
    return out


# ---------------------------------------------------------------------------
# Individual gates
# ---------------------------------------------------------------------------


def gate_catalog(catalog_path: Path) -> dict[str, Any]:
    """1. Catalog has WP-12A experimental weight 25."""
    name = "catalog_wp12a_weight_25"
    data = load_json(catalog_path)
    if data is None:
        return check_result(
            "C1",
            name,
            "FAIL",
            reason="CATALOG_UNREADABLE",
            path=str(catalog_path),
        )
    tasks = data.get("tasks") if isinstance(data.get("tasks"), list) else []
    matches = [t for t in tasks if isinstance(t, dict) and t.get("taskId") == TASK_ID]
    if len(matches) != 1:
        return check_result(
            "C1",
            name,
            "FAIL",
            reason="CATALOG_TASK_MISSING_OR_DUPLICATE",
            count=len(matches),
            path=str(catalog_path),
        )
    entry = matches[0]
    weight = entry.get("weight")
    experimental = entry.get("experimental")
    path_field = entry.get("path")
    ok = (
        weight == EXPECTED_WEIGHT
        and experimental is True
        and path_field == "experimental"
    )
    return check_result(
        "C1",
        name,
        "PASS" if ok else "FAIL",
        reason=None if ok else "CATALOG_WEIGHT_OR_EXPERIMENTAL_MISMATCH",
        weight=weight,
        expectedWeight=EXPECTED_WEIGHT,
        experimental=experimental,
        path=path_field,
        catalog=str(catalog_path),
        exactFiles=list((entry.get("scopeCheck") or {}).get("exactFiles") or []),
        phaseCommands=entry.get("phaseCommands") or {},
        expectedExit=entry.get("expectedExit") or {},
        scopeWorktrees=(entry.get("scopeCheck") or {}).get("worktrees") or {},
    )


def gate_plugin_exact_files(
    plugin_worktree: Path,
    exact_files: Sequence[str],
) -> dict[str, Any]:
    """2. Plugin exactFiles exist at plugin worktree path."""
    name = "plugin_exact_files_present"
    if not plugin_worktree.is_dir():
        return check_result(
            "C2",
            name,
            "FAIL",
            reason="PLUGIN_WORKTREE_MISSING",
            pluginWorktree=str(plugin_worktree),
        )
    files = list(exact_files) if exact_files else list(FALLBACK_EXACT_FILES)
    present: list[str] = []
    missing: list[str] = []
    for rel in files:
        if (plugin_worktree / rel).is_file():
            present.append(rel)
        else:
            missing.append(rel)
    ok = not missing
    return check_result(
        "C2",
        name,
        "PASS" if ok else "FAIL",
        reason=None if ok else "PLUGIN_EXACT_FILES_MISSING",
        pluginWorktree=str(plugin_worktree),
        present=present,
        missing=missing,
        required=files,
    )


def gate_official_inventory(inventory_path: Path | None) -> dict[str, Any]:
    """3. Official inventory v1: schemaVersion + apkSha256 + failClosed.ok."""
    name = "official_inventory_v1"
    if inventory_path is None:
        return check_result(
            "C3",
            name,
            "SKIP",
            reason="INVENTORY_NOT_REQUESTED",
            note="pass --inventory PATH to evaluate",
        )
    data = load_json(inventory_path)
    if data is None:
        return check_result(
            "C3",
            name,
            "FAIL",
            reason="INVENTORY_MISSING_OR_UNREADABLE",
            path=str(inventory_path),
        )
    schema = data.get("schemaVersion")
    apk = data.get("apkSha256")
    fc = data.get("failClosed") if isinstance(data.get("failClosed"), dict) else {}
    fc_ok = fc.get("ok") is True
    apk_ok = isinstance(apk, str) and (
        apk == EXPECTED_APK_SHA256 or apk.startswith(EXPECTED_APK_SHA256_PREFIX)
    )
    schema_ok = schema == SCHEMA_VERSION
    ok = schema_ok and apk_ok and fc_ok
    reasons = []
    if not schema_ok:
        reasons.append("SCHEMA_VERSION_MISMATCH")
    if not apk_ok:
        reasons.append("APK_SHA256_MISMATCH")
    if not fc_ok:
        reasons.append("FAILCLOSED_NOT_OK")
    return check_result(
        "C3",
        name,
        "PASS" if ok else "FAIL",
        reason=None if ok else ",".join(reasons),
        path=str(inventory_path),
        schemaVersion=schema,
        expectedSchemaVersion=SCHEMA_VERSION,
        apkSha256=apk,
        expectedApkSha256=EXPECTED_APK_SHA256,
        failClosedOk=fc_ok,
        failClosed=fc,
    )


def gate_phase_harness_red(
    plugin_worktree: Path,
    phase_commands: Mapping[str, Any],
    expected_exit: Mapping[str, Any],
    *,
    run_red: bool,
) -> dict[str, Any]:
    """4. Phase harness RED non-zero locally (optional run)."""
    name = "phase_harness_red_nonzero"
    if not run_red:
        return check_result(
            "C4",
            name,
            "SKIP",
            reason="RED_NOT_RUN",
            note="pass --run-red to execute catalog RED argv locally",
            catalogRed=phase_commands.get("RED"),
            expectedExitRed=expected_exit.get("RED", 1),
        )
    red = phase_commands.get("RED") if isinstance(phase_commands.get("RED"), dict) else {}
    argv = red.get("argv")
    if not isinstance(argv, list) or not argv:
        return check_result(
            "C4",
            name,
            "FAIL",
            reason="RED_ARGV_MISSING",
            phaseCommands=phase_commands,
        )
    if list(argv) == ["true"]:
        return check_result(
            "C4",
            name,
            "FAIL",
            reason="RED_ARGV_STUB",
            argv=argv,
            note="catalog RED must not be stub ['true']",
        )
    if not plugin_worktree.is_dir():
        return check_result(
            "C4",
            name,
            "FAIL",
            reason="PLUGIN_WORKTREE_MISSING",
            pluginWorktree=str(plugin_worktree),
        )
    try:
        proc = run_cmd([str(a) for a in argv], cwd=plugin_worktree, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return check_result(
            "C4",
            name,
            "FAIL",
            reason="RED_EXEC_ERROR",
            message=str(exc),
            argv=argv,
        )
    expected = int(expected_exit.get("RED", 1))
    # RED is a negative harness: non-zero (typically 1) is the PASS condition.
    nonzero = proc.returncode != 0
    matches_expected = proc.returncode == expected
    ok = nonzero  # fail-closed: any non-zero demonstrates RED; expected match is soft
    stderr_tail = (proc.stderr or "")[-500:]
    stdout_tail = (proc.stdout or "")[-300:]
    return check_result(
        "C4",
        name,
        "PASS" if ok else "FAIL",
        reason=None if ok else "RED_EXITED_ZERO",
        argv=argv,
        exitCode=proc.returncode,
        expectedExit=expected,
        matchesExpectedExit=matches_expected,
        stderrTail=stderr_tail,
        stdoutTail=stdout_tail,
        cwd=str(plugin_worktree),
    )


def gate_bootstrap_pushed(ledger_path: Path) -> dict[str, Any]:
    """5. BOOTSTRAP_PUSHED must be true for DONE — currently false blocks."""
    name = "bootstrap_pushed"
    data = load_json(ledger_path)
    if data is None:
        return check_result(
            "C5",
            name,
            "FAIL",
            reason="BOOTSTRAP_LEDGER_MISSING",
            path=str(ledger_path),
            BOOTSTRAP_PUSHED=False,
            note="missing ledger → treat as not pushed (fail-closed)",
        )
    raw_pushed = data.get("BOOTSTRAP_PUSHED")
    state = data.get("BOOTSTRAP_STATE")
    # Fail-closed read path: claim true only with dual origin readback proofs.
    pushed = raw_pushed is True
    if pushed:
        if not data.get("pluginOriginReadback") or not data.get("mineradioOriginReadback"):
            pushed = False
            return check_result(
                "C5",
                name,
                "FAIL",
                reason="BOOTSTRAP_PUSHED_FORGED_OR_UNPROVEN",
                path=str(ledger_path),
                BOOTSTRAP_PUSHED=False,
                claimedPushed=True,
                BOOTSTRAP_STATE=state,
                note="ledger claims pushed without dual origin readback",
            )
    if not pushed:
        return check_result(
            "C5",
            name,
            "FAIL",
            reason="BOOTSTRAP_PUSHED_FALSE",
            path=str(ledger_path),
            BOOTSTRAP_PUSHED=False,
            BOOTSTRAP_STATE=state,
            note="BOOTSTRAP_PUSHED must be true for EffectiveDone; currently blocks",
        )
    return check_result(
        "C5",
        name,
        "PASS",
        path=str(ledger_path),
        BOOTSTRAP_PUSHED=True,
        BOOTSTRAP_STATE=state,
    )


def _gh_pr_merged(pr: str, repo: str | None = None) -> dict[str, Any]:
    """Query gh for PR merge state. Returns structured probe (never raises)."""
    out: dict[str, Any] = {
        "pr": pr,
        "repo": repo,
        "merged": False,
        "state": None,
        "mergeCommit": None,
        "baseRef": None,
        "error": None,
    }
    if not pr or not str(pr).strip():
        out["error"] = "PR_NOT_PROVIDED"
        return out
    argv = ["gh", "pr", "view", str(pr), "--json", "state,mergedAt,mergeCommit,baseRefName,url"]
    if repo:
        argv.extend(["--repo", repo])
    try:
        proc = run_cmd(argv, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as exc:
        out["error"] = f"GH_PROBE_ERROR:{exc}"
        return out
    if proc.returncode != 0:
        out["error"] = (proc.stderr or proc.stdout or "GH_PR_VIEW_FAILED").strip()[:400]
        return out
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        out["error"] = "GH_JSON_DECODE"
        return out
    out["state"] = data.get("state")
    out["baseRef"] = data.get("baseRefName")
    out["url"] = data.get("url")
    mc = data.get("mergeCommit")
    if isinstance(mc, dict):
        out["mergeCommit"] = mc.get("oid")
    elif isinstance(mc, str):
        out["mergeCommit"] = mc
    out["merged"] = bool(data.get("mergedAt")) or str(data.get("state") or "").upper() == "MERGED"
    return out


def _base_containment(repo: Path, base_sha: str | None, head: str | None) -> dict[str, Any]:
    """merge-base --is-ancestor base head when both shas available."""
    result: dict[str, Any] = {
        "repo": str(repo),
        "baseSha": base_sha,
        "head": head,
        "contained": False,
        "checked": False,
        "error": None,
    }
    if not base_sha or not head:
        result["error"] = "BASE_OR_HEAD_MISSING"
        return result
    if not repo.is_dir():
        result["error"] = "REPO_MISSING"
        return result
    proc = run_git(repo, "merge-base", "--is-ancestor", base_sha, head)
    result["checked"] = True
    result["exitCode"] = proc.returncode
    result["contained"] = proc.returncode == 0
    if proc.returncode not in (0, 1):
        result["error"] = (proc.stderr or "MERGE_BASE_FAILED").strip()[:300]
    return result


def gate_dual_prs(
    *,
    plugin_pr: str | None,
    mineradio_pr: str | None,
    plugin_head: str | None,
    mineradio_head: str | None,
    plugin_worktree: Path,
    mineradio_worktree: Path,
    bootstrap_ledger: Path,
) -> dict[str, Any]:
    """6. Dual PRs merged + base containment — if not merged, FAIL for done."""
    name = "dual_prs_merged_base_containment"
    if not plugin_pr and not mineradio_pr:
        return check_result(
            "C6",
            name,
            "FAIL",
            reason="DUAL_PR_NOT_PROVIDED",
            note=(
                "pass --plugin-pr and --mineradio-pr for merge+containment probes; "
                "missing dual merged PRs blocks readyForEffectiveDone"
            ),
            pluginPr=plugin_pr,
            mineradioPr=mineradio_pr,
        )

    # Resolve heads from flags or worktree HEAD.
    def resolve_head(flag: str | None, wt: Path) -> str | None:
        if flag:
            return flag
        if not wt.is_dir():
            return None
        proc = run_git(wt, "rev-parse", "HEAD")
        if proc.returncode == 0:
            return (proc.stdout or "").strip() or None
        return None

    p_head = resolve_head(plugin_head, plugin_worktree)
    m_head = resolve_head(mineradio_head, mineradio_worktree)

    # baseSha from bootstrap ledger when present.
    ledger = load_json(bootstrap_ledger) or {}
    plugin_base = None
    mineradio_base = None
    if isinstance(ledger.get("plugin"), dict):
        plugin_base = ledger["plugin"].get("baseSha")
    if isinstance(ledger.get("mineradio"), dict):
        mineradio_base = ledger["mineradio"].get("baseSha")

    plugin_probe = _gh_pr_merged(plugin_pr or "")
    mineradio_probe = _gh_pr_merged(mineradio_pr or "")

    # Prefer merge commit as head for containment when PR is merged.
    if plugin_probe.get("merged") and plugin_probe.get("mergeCommit"):
        p_head = plugin_probe["mergeCommit"]
    if mineradio_probe.get("merged") and mineradio_probe.get("mergeCommit"):
        m_head = mineradio_probe["mergeCommit"]

    plugin_contain = _base_containment(plugin_worktree, plugin_base, p_head)
    mineradio_contain = _base_containment(mineradio_worktree, mineradio_base, m_head)

    both_merged = bool(plugin_probe.get("merged") and mineradio_probe.get("merged"))
    both_contained = bool(
        plugin_contain.get("contained") and mineradio_contain.get("contained")
    )
    ok = both_merged and both_contained
    reasons = []
    if not plugin_probe.get("merged"):
        reasons.append("PLUGIN_PR_NOT_MERGED")
    if not mineradio_probe.get("merged"):
        reasons.append("MINERADIO_PR_NOT_MERGED")
    if not plugin_contain.get("contained"):
        reasons.append("PLUGIN_BASE_CONTAINMENT_FAILED")
    if not mineradio_contain.get("contained"):
        reasons.append("MINERADIO_BASE_CONTAINMENT_FAILED")

    return check_result(
        "C6",
        name,
        "PASS" if ok else "FAIL",
        reason=None if ok else ",".join(reasons) or "DUAL_PR_GATE_FAILED",
        pluginPr=plugin_probe,
        mineradioPr=mineradio_probe,
        pluginContainment=plugin_contain,
        mineradioContainment=mineradio_contain,
        pluginHead=p_head,
        mineradioHead=m_head,
    )


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------


def required_for_ready(check: Mapping[str, Any]) -> bool:
    """C4 (optional RED run) may SKIP without blocking readiness of other gates;
    but readyForEffectiveDone still requires non-SKIP or PASS for required gates.
    Skeleton policy: C1,C2,C3,C5,C6 required PASS; C4 may SKIP.
    """
    return check.get("id") != "C4"


def compute_ready(checks: Sequence[Mapping[str, Any]]) -> tuple[bool, list[str]]:
    blockers: list[str] = []
    for c in checks:
        cid = str(c.get("id"))
        status = c.get("status")
        if not required_for_ready(c):
            # optional: only FAIL blocks
            if status == "FAIL":
                blockers.append(f"{cid}:{c.get('reason') or status}")
            continue
        if status != "PASS":
            blockers.append(f"{cid}:{c.get('reason') or status}")
    return (len(blockers) == 0), blockers


def cmd_check(args: argparse.Namespace) -> int:
    catalog_path = Path(args.catalog) if args.catalog else DEFAULT_CATALOG
    plugin_wt = Path(args.plugin_worktree or DEFAULT_PLUGIN_WORKTREE)
    mineradio_wt = Path(args.mineradio_worktree or DEFAULT_MINERADIO_WORKTREE)
    ledger_path = Path(args.bootstrap_ledger) if args.bootstrap_ledger else DEFAULT_BOOTSTRAP_LEDGER

    # Inventory: default path if it exists; explicit --inventory always used;
    # --no-inventory forces skip.
    if getattr(args, "no_inventory", False):
        inventory_path: Path | None = None
    elif args.inventory:
        inventory_path = Path(args.inventory)
    elif DEFAULT_INVENTORY.is_file():
        inventory_path = DEFAULT_INVENTORY
    else:
        inventory_path = DEFAULT_INVENTORY  # still probe → FAIL if missing (default runs path)

    c1 = gate_catalog(catalog_path)
    exact_files = c1.get("exactFiles") or list(FALLBACK_EXACT_FILES)
    phase_commands = c1.get("phaseCommands") or {}
    expected_exit = c1.get("expectedExit") or {}
    # Prefer catalog worktree pins when present.
    scope_wts = c1.get("scopeWorktrees") or {}
    if not args.plugin_worktree and isinstance(scope_wts.get("plugin"), str):
        plugin_wt = Path(scope_wts["plugin"])
    if not args.mineradio_worktree and isinstance(scope_wts.get("mineradio"), str):
        mineradio_wt = Path(scope_wts["mineradio"])

    c2 = gate_plugin_exact_files(plugin_wt, exact_files)
    c3 = gate_official_inventory(inventory_path)
    c4 = gate_phase_harness_red(
        plugin_wt,
        phase_commands if isinstance(phase_commands, dict) else {},
        expected_exit if isinstance(expected_exit, dict) else {},
        run_red=bool(args.run_red),
    )
    c5 = gate_bootstrap_pushed(ledger_path)
    c6 = gate_dual_prs(
        plugin_pr=args.plugin_pr,
        mineradio_pr=args.mineradio_pr,
        plugin_head=args.plugin_head,
        mineradio_head=args.mineradio_head,
        plugin_worktree=plugin_wt,
        mineradio_worktree=mineradio_wt,
        bootstrap_ledger=ledger_path,
    )

    checks = [c1, c2, c3, c4, c5, c6]
    ready, blockers = compute_ready(checks)

    # Future wiring point: wallpaper-task.py verify-done may call evaluate_wp12a
    # once BOOTSTRAP_PUSHED + dual PR merge + inventory seal + RED proof are green.
    # This scaffold never promotes EffectiveDone.
    return emit_report(
        command="check",
        readyForEffectiveDone=ready,
        evaluatedAt=utc_now_iso(),
        checks=checks,
        blockers=blockers,
        inputs={
            "catalog": str(catalog_path),
            "pluginWorktree": str(plugin_wt),
            "mineradioWorktree": str(mineradio_wt),
            "inventory": str(inventory_path) if inventory_path else None,
            "bootstrapLedger": str(ledger_path),
            "pluginPr": args.plugin_pr,
            "mineradioPr": args.mineradio_pr,
            "pluginHead": args.plugin_head,
            "mineradioHead": args.mineradio_head,
            "runRed": bool(args.run_red),
        },
        proofChecklist=[
            "C1 catalog WP-12A experimental weight 25",
            "C2 plugin exactFiles present on plugin worktree",
            "C3 official inventory v1 schemaVersion + apkSha256 6982c827… + failClosed.ok",
            "C4 phase harness RED non-zero (optional local run via --run-red)",
            "C5 BOOTSTRAP_PUSHED=true with dual origin readback",
            "C6 dual PRs merged + base containment",
        ],
        notes=[
            "Scaffold evaluate-wp12a: EffectiveDone is always false on this surface.",
            "readyForEffectiveDone is true only when required gates C1–C3,C5–C6 are PASS.",
            "Future verify-done may promote EffectiveDone only after this checklist is green "
            "plus sealed evidence transaction — not implemented here.",
            "No force-push. No forged BOOTSTRAP_PUSHED / EffectiveDone.",
        ],
        futureVerifyDoneHook={
            "module": "evaluate-wp12a.py",
            "function": "cmd_check",
            "wallpaperTaskWiring": (
                "optional future: wallpaper-task.py verify-done --task WP-12A "
                "delegates readiness probe here; only verify-done may set EffectiveDone"
            ),
            "EffectiveDoneAllowedHere": False,
        },
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="evaluate-wp12a.py",
        description=(
            "Fail-closed WP-12A evaluate skeleton. Reports proof checklist; "
            "never sets EffectiveDone=true. Exit 0 on successful report "
            "(even when readyForEffectiveDone=false)."
        ),
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="check",
        choices=["check"],
        help="evaluation command (default: check)",
    )
    parser.add_argument(
        "--plugin-pr",
        default=None,
        help="Plugin implementation PR number/url for merge probe",
    )
    parser.add_argument(
        "--mineradio-pr",
        default=None,
        help="Mineradio evidence/closure PR number/url for merge probe",
    )
    parser.add_argument(
        "--plugin-head",
        default=None,
        help="Plugin HEAD/merge SHA override for base containment",
    )
    parser.add_argument(
        "--mineradio-head",
        default=None,
        help="Mineradio HEAD/merge SHA override for base containment",
    )
    parser.add_argument(
        "--inventory",
        default=None,
        help=(
            "Path to official inventory.json (wp12a-manifest-map/v1). "
            f"Default: {DEFAULT_INVENTORY}"
        ),
    )
    parser.add_argument(
        "--no-inventory",
        action="store_true",
        help="Skip inventory gate (status=SKIP); blocks readyForEffectiveDone",
    )
    parser.add_argument(
        "--bootstrap-ledger",
        default=None,
        help=f"Bootstrap ledger path (default: {DEFAULT_BOOTSTRAP_LEDGER})",
    )
    parser.add_argument(
        "--plugin-worktree",
        default=None,
        help=f"Plugin worktree (default: {DEFAULT_PLUGIN_WORKTREE})",
    )
    parser.add_argument(
        "--mineradio-worktree",
        default=None,
        help=f"Mineradio worktree (default: {DEFAULT_MINERADIO_WORKTREE})",
    )
    parser.add_argument(
        "--catalog",
        default=None,
        help=f"Catalog path (default: {DEFAULT_CATALOG})",
    )
    parser.add_argument(
        "--run-red",
        action="store_true",
        help="Optionally execute catalog RED harness locally (expect non-zero)",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.command == "check":
        return cmd_check(args)
    emit_tool_failure("UNKNOWN_COMMAND", f"unknown command: {args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — never silently swallow
        emit_tool_failure("ILLEGAL_STATE", f"unhandled error: {exc}")
