#!/usr/bin/env python3
"""WP-12A evaluate surface (fail-closed skeleton / proof checklist).

Scaffold only: defines the pre-verify-done proof gates for experimental WP-12A.
This tool:

  - never prints EffectiveDone=true (verify-done wiring point is future work)
  - reports readyForEffectiveDone only when every required gate is PASS
  - never force-pushes, never mutates origin, never forges BOOTSTRAP_PUSHED
  - accepts merged dual/multi-PR identity (repeatable --plugin-pr / merge SHAs)

CLI:
  python3 evaluate-wp12a.py --help
  python3 evaluate-wp12a.py check          # default command
  python3 evaluate-wp12a.py check \\
      --plugin-pr 8 --plugin-pr 9 --mineradio-pr 40 \\
      --plugin-merge-sha af0e757de91aa1cdd5d4ebd4cd21c8fa4533ba5d \\
      --plugin-merge-sha 4255a9f16141818ba0beeab9bde1eddb0f862c31 \\
      --mineradio-merge-sha d0a5c3de211542cf50ef9b678b575452541b8646

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
DEFAULT_PLUGIN_REPO = "anpplex/plugin-WallpaperEngine"
DEFAULT_MINERADIO_REPO = "anpplex/Mineradio-AndroidAuto"
DEFAULT_PLUGIN_BASE_REF = "origin/main"
DEFAULT_MINERADIO_BASE_REF = "origin/huawei-android12-car"

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


def _gh_available() -> bool:
    try:
        proc = run_cmd(["gh", "--version"], timeout=10)
        return proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


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
    argv = [
        "gh",
        "pr",
        "view",
        str(pr),
        "--json",
        "state,mergedAt,mergeCommit,baseRefName,url",
    ]
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
    # Fail-closed merge identity: require state=MERGED (mergedAt alone is soft).
    state_u = str(data.get("state") or "").upper()
    out["merged"] = state_u == "MERGED" or bool(data.get("mergedAt"))
    out["stateIsMerged"] = state_u == "MERGED"
    return out


def _normalize_sha_list(values: Sequence[str] | None) -> list[str]:
    out: list[str] = []
    if not values:
        return out
    for raw in values:
        if raw is None:
            continue
        s = str(raw).strip()
        if not s:
            continue
        if s not in out:
            out.append(s)
    return out


def _resolve_ref_sha(repo: Path, ref: str) -> dict[str, Any]:
    """Resolve a ref (branch/sha) to full oid via rev-parse."""
    result: dict[str, Any] = {
        "ref": ref,
        "sha": None,
        "checked": False,
        "error": None,
    }
    if not ref:
        result["error"] = "REF_MISSING"
        return result
    if not repo.is_dir():
        result["error"] = "REPO_MISSING"
        return result
    proc = run_git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}")
    result["checked"] = True
    result["exitCode"] = proc.returncode
    if proc.returncode != 0:
        result["error"] = (proc.stderr or proc.stdout or "REV_PARSE_FAILED").strip()[:300]
        return result
    result["sha"] = (proc.stdout or "").strip() or None
    if not result["sha"]:
        result["error"] = "REV_PARSE_EMPTY"
    return result


def _is_ancestor(repo: Path, ancestor: str, descendant: str) -> dict[str, Any]:
    """git merge-base --is-ancestor ancestor descendant."""
    result: dict[str, Any] = {
        "repo": str(repo),
        "ancestor": ancestor,
        "descendant": descendant,
        "contained": False,
        "checked": False,
        "error": None,
    }
    if not ancestor or not descendant:
        result["error"] = "ANCESTOR_OR_DESCENDANT_MISSING"
        return result
    if not repo.is_dir():
        result["error"] = "REPO_MISSING"
        return result
    proc = run_git(repo, "merge-base", "--is-ancestor", ancestor, descendant)
    result["checked"] = True
    result["exitCode"] = proc.returncode
    result["contained"] = proc.returncode == 0
    if proc.returncode not in (0, 1):
        result["error"] = (proc.stderr or "MERGE_BASE_FAILED").strip()[:300]
    return result


def _probe_pr_identity(
    *,
    pr: str,
    repo_slug: str,
    worktree: Path,
    expected_merge_sha: str | None,
    base_ref: str,
    label: str,
) -> dict[str, Any]:
    """Single PR identity: gh MERGED + mergeCommit, or git ancestry of merge SHA."""
    probe: dict[str, Any] = {
        "label": label,
        "pr": pr,
        "repo": repo_slug,
        "expectedMergeSha": expected_merge_sha,
        "baseRef": base_ref,
        "ok": False,
        "merged": False,
        "ancestryOk": False,
        "mergeCommit": None,
        "gh": None,
        "ancestry": None,
        "baseResolved": None,
        "method": None,
        "error": None,
    }
    gh_ok = _gh_available()
    merge_sha: str | None = expected_merge_sha

    if gh_ok and pr:
        gh = _gh_pr_merged(pr, repo=repo_slug)
        probe["gh"] = gh
        probe["merged"] = bool(gh.get("merged"))
        probe["mergeCommit"] = gh.get("mergeCommit")
        if gh.get("error") and not gh.get("merged"):
            probe["error"] = gh.get("error")
        if gh.get("mergeCommit"):
            # Prefer live gh mergeCommit; flag mismatch with provided pin.
            if expected_merge_sha and not str(gh["mergeCommit"]).startswith(
                str(expected_merge_sha)[:7]
            ) and not str(expected_merge_sha).startswith(str(gh["mergeCommit"])[:7]):
                probe["mergeShaMismatch"] = {
                    "expected": expected_merge_sha,
                    "observed": gh["mergeCommit"],
                }
            merge_sha = str(gh["mergeCommit"])
        if probe["merged"]:
            probe["method"] = "gh_pr_view_merged"
    elif not gh_ok and pr:
        probe["gh"] = {"error": "GH_UNAVAILABLE", "pr": pr, "repo": repo_slug}
    elif not pr and expected_merge_sha:
        probe["method"] = "merge_sha_only"

    if not merge_sha:
        if not probe["error"]:
            probe["error"] = "MERGE_SHA_UNKNOWN"
        probe["ok"] = False
        return probe

    probe["mergeCommit"] = merge_sha
    base_resolved = _resolve_ref_sha(worktree, base_ref)
    probe["baseResolved"] = base_resolved
    if not base_resolved.get("sha"):
        # Best-effort fetch of the base ref tip name without force-push.
        short = base_ref.split("/", 1)[-1] if base_ref.startswith("origin/") else base_ref
        fetch = run_git(worktree, "fetch", "origin", short, timeout=120)
        probe["fetchBase"] = {
            "ref": short,
            "exitCode": fetch.returncode,
            "stderr": (fetch.stderr or "")[-200:],
        }
        base_resolved = _resolve_ref_sha(worktree, base_ref)
        probe["baseResolved"] = base_resolved

    if not base_resolved.get("sha"):
        probe["error"] = probe.get("error") or "BASE_REF_UNRESOLVED"
        # If gh already proved MERGED, still accept identity without ancestry.
        if probe["merged"]:
            probe["ok"] = True
            probe["method"] = (probe.get("method") or "gh") + "+ancestry_skipped_base_unresolved"
            probe["ancestryOk"] = False
            return probe
        probe["ok"] = False
        return probe

    ancestry = _is_ancestor(worktree, merge_sha, base_resolved["sha"])
    probe["ancestry"] = ancestry
    probe["ancestryOk"] = bool(ancestry.get("contained"))

    if probe["merged"] and probe["ancestryOk"]:
        probe["ok"] = True
        probe["method"] = "gh_merged_and_ancestor_of_base"
    elif probe["merged"]:
        # gh state=MERGED is sufficient identity when ancestry fails due to missing object.
        if ancestry.get("error"):
            probe["ok"] = True
            probe["method"] = "gh_merged_ancestry_error_soft"
        else:
            # Not an ancestor of base tip → FAIL (merged PR later rebased away?).
            probe["ok"] = False
            probe["error"] = probe.get("error") or "MERGE_SHA_NOT_ANCESTOR_OF_BASE"
            probe["method"] = "gh_merged_but_not_on_base"
    elif probe["ancestryOk"]:
        # Offline / no-gh path: merge SHA ancestor of origin base is accepted.
        probe["ok"] = True
        probe["merged"] = True  # synthetic: present on base
        probe["method"] = "merge_sha_ancestor_of_base"
    else:
        probe["ok"] = False
        probe["error"] = probe.get("error") or "PR_NOT_MERGED_AND_SHA_NOT_ON_BASE"
        probe["method"] = probe.get("method") or "failed"
    return probe


def gate_dual_prs(
    *,
    plugin_prs: Sequence[str] | None,
    mineradio_prs: Sequence[str] | None,
    plugin_merge_shas: Sequence[str] | None,
    mineradio_merge_shas: Sequence[str] | None,
    plugin_head: str | None,
    mineradio_head: str | None,
    plugin_worktree: Path,
    mineradio_worktree: Path,
    plugin_repo: str,
    mineradio_repo: str,
    plugin_base_ref: str,
    mineradio_base_ref: str,
    bootstrap_ledger: Path,
) -> dict[str, Any]:
    """6. Dual-repo merged PR identity (multi plugin PR) + base ancestry.

    Pass when:
      - every provided plugin PR is MERGED (gh) or its merge SHA is ancestor of
        origin/main (plugin base), AND
      - every provided mineradio PR is MERGED or its merge SHA is ancestor of
        origin/huawei-android12-car, AND
      - at least one plugin identity and one mineradio identity were provided.

    Legacy single --plugin-head / --mineradio-head still feed merge-sha lists.
    """
    name = "dual_prs_merged_base_containment"
    p_prs = [str(p).strip() for p in (plugin_prs or []) if str(p).strip()]
    m_prs = [str(p).strip() for p in (mineradio_prs or []) if str(p).strip()]
    p_shas = _normalize_sha_list(list(plugin_merge_shas or []))
    m_shas = _normalize_sha_list(list(mineradio_merge_shas or []))
    if plugin_head and plugin_head not in p_shas:
        p_shas.append(plugin_head)
    if mineradio_head and mineradio_head not in m_shas:
        m_shas.append(mineradio_head)

    if not p_prs and not m_prs and not p_shas and not m_shas:
        return check_result(
            "C6",
            name,
            "FAIL",
            reason="DUAL_PR_NOT_PROVIDED",
            note=(
                "pass repeatable --plugin-pr / --plugin-merge-sha and "
                "--mineradio-pr / --mineradio-merge-sha for merge identity; "
                "missing dual merged identity blocks readyForEffectiveDone"
            ),
            pluginPrs=p_prs,
            mineradioPrs=m_prs,
            pluginMergeShas=p_shas,
            mineradioMergeShas=m_shas,
        )

    # Pair PRs with optional merge SHAs by index; extra SHAs become sha-only probes.
    def build_pairs(
        prs: list[str], shas: list[str], side: str
    ) -> list[tuple[str | None, str | None, str]]:
        pairs: list[tuple[str | None, str | None, str]] = []
        n = max(len(prs), len(shas))
        for i in range(n):
            pr = prs[i] if i < len(prs) else None
            sha = shas[i] if i < len(shas) else None
            if pr is None and sha is None:
                continue
            label = f"{side}#{pr}" if pr else f"{side}@{(sha or '')[:12]}"
            pairs.append((pr, sha, label))
        return pairs

    plugin_pairs = build_pairs(p_prs, p_shas, "plugin")
    mineradio_pairs = build_pairs(m_prs, m_shas, "mineradio")

    if not plugin_pairs:
        return check_result(
            "C6",
            name,
            "FAIL",
            reason="PLUGIN_PR_IDENTITY_MISSING",
            note="need at least one --plugin-pr or --plugin-merge-sha",
            pluginPrs=p_prs,
            mineradioPrs=m_prs,
        )
    if not mineradio_pairs:
        return check_result(
            "C6",
            name,
            "FAIL",
            reason="MINERADIO_PR_IDENTITY_MISSING",
            note="need at least one --mineradio-pr or --mineradio-merge-sha",
            pluginPrs=p_prs,
            mineradioPrs=m_prs,
        )

    plugin_probes = [
        _probe_pr_identity(
            pr=pr or "",
            repo_slug=plugin_repo,
            worktree=plugin_worktree,
            expected_merge_sha=sha,
            base_ref=plugin_base_ref,
            label=label,
        )
        for pr, sha, label in plugin_pairs
    ]
    mineradio_probes = [
        _probe_pr_identity(
            pr=pr or "",
            repo_slug=mineradio_repo,
            worktree=mineradio_worktree,
            expected_merge_sha=sha,
            base_ref=mineradio_base_ref,
            label=label,
        )
        for pr, sha, label in mineradio_pairs
    ]

    # Optional legacy baseSha containment (bootstrap ledger) as soft evidence.
    ledger = load_json(bootstrap_ledger) or {}
    plugin_base_sha = None
    mineradio_base_sha = None
    if isinstance(ledger.get("plugin"), dict):
        plugin_base_sha = ledger["plugin"].get("baseSha")
    if isinstance(ledger.get("mineradio"), dict):
        mineradio_base_sha = ledger["mineradio"].get("baseSha")

    def tip_of(probes: list[dict[str, Any]]) -> str | None:
        for p in reversed(probes):
            if p.get("mergeCommit"):
                return str(p["mergeCommit"])
        return None

    plugin_tip = tip_of(plugin_probes)
    mineradio_tip = tip_of(mineradio_probes)
    plugin_legacy = (
        _is_ancestor(plugin_worktree, str(plugin_base_sha), str(plugin_tip))
        if plugin_base_sha and plugin_tip
        else {"checked": False, "contained": None, "note": "legacy_base_skipped"}
    )
    mineradio_legacy = (
        _is_ancestor(mineradio_worktree, str(mineradio_base_sha), str(mineradio_tip))
        if mineradio_base_sha and mineradio_tip
        else {"checked": False, "contained": None, "note": "legacy_base_skipped"}
    )

    plugin_ok = all(bool(p.get("ok")) for p in plugin_probes) and bool(plugin_probes)
    mineradio_ok = all(bool(p.get("ok")) for p in mineradio_probes) and bool(
        mineradio_probes
    )
    ok = plugin_ok and mineradio_ok
    reasons: list[str] = []
    if not plugin_ok:
        for p in plugin_probes:
            if not p.get("ok"):
                reasons.append(
                    f"PLUGIN_IDENTITY_FAIL:{p.get('label')}:{p.get('error') or p.get('method')}"
                )
    if not mineradio_ok:
        for p in mineradio_probes:
            if not p.get("ok"):
                reasons.append(
                    f"MINERADIO_IDENTITY_FAIL:{p.get('label')}:{p.get('error') or p.get('method')}"
                )

    return check_result(
        "C6",
        name,
        "PASS" if ok else "FAIL",
        reason=None if ok else ",".join(reasons) or "DUAL_PR_GATE_FAILED",
        pluginRepo=plugin_repo,
        mineradioRepo=mineradio_repo,
        pluginBaseRef=plugin_base_ref,
        mineradioBaseRef=mineradio_base_ref,
        pluginPrs=p_prs,
        mineradioPrs=m_prs,
        pluginMergeShas=p_shas,
        mineradioMergeShas=m_shas,
        pluginProbes=plugin_probes,
        mineradioProbes=mineradio_probes,
        pluginLegacyBaseContainment=plugin_legacy,
        mineradioLegacyBaseContainment=mineradio_legacy,
        pluginTip=plugin_tip,
        mineradioTip=mineradio_tip,
        ghAvailable=_gh_available(),
        note=(
            "C6 accepts multi plugin PRs (--plugin-pr repeatable / --plugin-merge-sha). "
            "Each identity must be gh state=MERGED or merge SHA ancestor of base ref."
        ),
    )


def gate_sealed_evidence(sealed_path: Path | None) -> dict[str, Any]:
    """Optional sealed evidence path. SKIP if not provided (does not block ready).

    When provided, require readable JSON/dir with fail-closed seal markers.
    readyForEffectiveDone does not require this gate unless the path is given
    (then FAIL blocks). Scaffold never promotes EffectiveDone regardless.
    """
    name = "sealed_evidence_optional"
    if sealed_path is None:
        return check_result(
            "C7",
            name,
            "SKIP",
            reason="SEALED_EVIDENCE_NOT_PROVIDED",
            note=(
                "optional --sealed-evidence PATH; when omitted this gate is SKIP "
                "and does not block readyForEffectiveDone"
            ),
        )
    path = Path(sealed_path)
    data: dict[str, Any] | None = None
    used_path = path
    if path.is_dir():
        candidates = [
            path / "seal.json",
            path / "SEAL.json",
            path / "evidence.json",
            path / "SUMMARY.json",
        ]
        for c in candidates:
            data = load_json(c)
            if data is not None:
                used_path = c
                break
        if data is None:
            return check_result(
                "C7",
                name,
                "FAIL",
                reason="SEALED_EVIDENCE_DIR_NO_SEAL_JSON",
                path=str(path),
            )
    else:
        data = load_json(path)
        if data is None:
            return check_result(
                "C7",
                name,
                "FAIL",
                reason="SEALED_EVIDENCE_MISSING_OR_UNREADABLE",
                path=str(path),
            )

    # Accept common seal markers; fail-closed if none present.
    sealed = False
    markers_found: list[str] = []
    for key, expect in (
        ("sealed", True),
        ("SEALED", True),
        ("treeFrozen", True),
        ("TREE_FROZEN", True),
        ("status", "SEALED"),
        ("sealState", "SEALED"),
    ):
        if key not in data:
            continue
        markers_found.append(key)
        val = data.get(key)
        if expect is True and val is True:
            sealed = True
        elif isinstance(expect, str) and str(val).upper() == expect:
            sealed = True
    if data.get("failClosed") is False:
        sealed = False
        markers_found.append("failClosed=false")
    ok = sealed
    return check_result(
        "C7",
        name,
        "PASS" if ok else "FAIL",
        reason=None if ok else "SEALED_EVIDENCE_NOT_MARKED_SEALED",
        path=str(used_path),
        markersFound=markers_found,
        note="optional sealed evidence; FAIL only blocks when path was provided",
    )


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------


def required_for_ready(check: Mapping[str, Any]) -> bool:
    """C4 (optional RED) and C7 (optional sealed evidence) may SKIP without
    blocking readiness. FAIL on optional gates still blocks.
    Required PASS: C1, C2, C3, C5, C6.
    """
    return check.get("id") not in {"C4", "C7"}


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

    plugin_prs = list(args.plugin_pr or [])
    mineradio_prs = list(args.mineradio_pr or [])
    plugin_merge_shas = list(args.plugin_merge_sha or [])
    mineradio_merge_shas = list(args.mineradio_merge_sha or [])

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
        plugin_prs=plugin_prs,
        mineradio_prs=mineradio_prs,
        plugin_merge_shas=plugin_merge_shas,
        mineradio_merge_shas=mineradio_merge_shas,
        plugin_head=args.plugin_head,
        mineradio_head=args.mineradio_head,
        plugin_worktree=plugin_wt,
        mineradio_worktree=mineradio_wt,
        plugin_repo=args.plugin_repo or DEFAULT_PLUGIN_REPO,
        mineradio_repo=args.mineradio_repo or DEFAULT_MINERADIO_REPO,
        plugin_base_ref=args.plugin_base_ref or DEFAULT_PLUGIN_BASE_REF,
        mineradio_base_ref=args.mineradio_base_ref or DEFAULT_MINERADIO_BASE_REF,
        bootstrap_ledger=ledger_path,
    )
    sealed = Path(args.sealed_evidence) if args.sealed_evidence else None
    c7 = gate_sealed_evidence(sealed)

    checks = [c1, c2, c3, c4, c5, c6, c7]
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
            "pluginPrs": plugin_prs,
            "mineradioPrs": mineradio_prs,
            "pluginMergeShas": plugin_merge_shas,
            "mineradioMergeShas": mineradio_merge_shas,
            "pluginHead": args.plugin_head,
            "mineradioHead": args.mineradio_head,
            "pluginRepo": args.plugin_repo or DEFAULT_PLUGIN_REPO,
            "mineradioRepo": args.mineradio_repo or DEFAULT_MINERADIO_REPO,
            "pluginBaseRef": args.plugin_base_ref or DEFAULT_PLUGIN_BASE_REF,
            "mineradioBaseRef": args.mineradio_base_ref or DEFAULT_MINERADIO_BASE_REF,
            "sealedEvidence": str(sealed) if sealed else None,
            "runRed": bool(args.run_red),
        },
        proofChecklist=[
            "C1 catalog WP-12A experimental weight 25",
            "C2 plugin exactFiles present on plugin worktree",
            "C3 official inventory v1 schemaVersion + apkSha256 6982c827… + failClosed.ok",
            "C4 phase harness RED non-zero (optional local run via --run-red)",
            "C5 BOOTSTRAP_PUSHED=true with dual origin readback",
            "C6 dual/multi PRs merged (gh MERGED) or merge SHAs ancestor of origin bases",
            "C7 optional sealed evidence path (SKIP if omitted; FAIL blocks when given)",
        ],
        notes=[
            "Scaffold evaluate-wp12a: EffectiveDone is always false on this surface.",
            "readyForEffectiveDone is true only when required gates C1–C3,C5–C6 are PASS "
            "(and C4/C7 are not FAIL).",
            "Post-merge: use --plugin-pr 8 --plugin-pr 9 --mineradio-pr 40 "
            "(and optional --plugin-merge-sha / --mineradio-merge-sha pins).",
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
            "(even when readyForEffectiveDone=false). "
            "Supports merged dual-PR identity: repeatable --plugin-pr / "
            "--plugin-merge-sha plus --mineradio-pr."
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
        action="append",
        default=None,
        help=(
            "Plugin PR number/url for merge probe (repeatable; e.g. "
            "--plugin-pr 8 --plugin-pr 9)"
        ),
    )
    parser.add_argument(
        "--mineradio-pr",
        action="append",
        default=None,
        help="Mineradio PR number/url for merge probe (repeatable; typically one)",
    )
    parser.add_argument(
        "--plugin-merge-sha",
        action="append",
        default=None,
        help=(
            "Plugin merge commit SHA pin (repeatable). Used with or without "
            "--plugin-pr; ancestry checked against --plugin-base-ref"
        ),
    )
    parser.add_argument(
        "--mineradio-merge-sha",
        action="append",
        default=None,
        help=(
            "Mineradio merge commit SHA pin (repeatable). Ancestry checked "
            "against --mineradio-base-ref"
        ),
    )
    parser.add_argument(
        "--plugin-head",
        default=None,
        help="Deprecated alias: treated as extra --plugin-merge-sha",
    )
    parser.add_argument(
        "--mineradio-head",
        default=None,
        help="Deprecated alias: treated as extra --mineradio-merge-sha",
    )
    parser.add_argument(
        "--plugin-repo",
        default=None,
        help=f"Plugin GitHub repo slug (default: {DEFAULT_PLUGIN_REPO})",
    )
    parser.add_argument(
        "--mineradio-repo",
        default=None,
        help=f"Mineradio GitHub repo slug (default: {DEFAULT_MINERADIO_REPO})",
    )
    parser.add_argument(
        "--plugin-base-ref",
        default=None,
        help=(
            "Plugin base ref for merge-SHA ancestry "
            f"(default: {DEFAULT_PLUGIN_BASE_REF})"
        ),
    )
    parser.add_argument(
        "--mineradio-base-ref",
        default=None,
        help=(
            "Mineradio base ref for merge-SHA ancestry "
            f"(default: {DEFAULT_MINERADIO_BASE_REF})"
        ),
    )
    parser.add_argument(
        "--sealed-evidence",
        default=None,
        help=(
            "Optional sealed evidence JSON/dir. When provided, C7 must PASS; "
            "when omitted, C7=SKIP (does not block readyForEffectiveDone)"
        ),
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
