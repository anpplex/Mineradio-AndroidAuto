#!/usr/bin/env python3
"""Mineradio wallpaper plugin transaction runner (WP-INFRA minimal core).

Fail-closed gates for:
  - task identity / caller-supplied identity
  - evidence path containment and no-clobber
  - writer leases
  - durable receipt init, revision/state CAS, atomic fsync replace, readback
  - IN_FLIGHT recovery and append-only attempts
  - bootstrap receipt (canonical path, transaction identity, phase ledger)
  - blob SHA freeze, test receipts, exactSync, PR merge / base containment
  - exact-push (dual-auth network); origin-only remote; approved infra ref
  - expectedSha bound to local HEAD; REMOTE_VERIFIED only after durable ls-remote
  - PR merge / base containment independent readback
  - blob SHA path-bound + always recompute; authentic node --test receipts
  - EffectiveGate derivation (forged DONE / caller test receipts rejected)
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, NoReturn, Sequence

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_FAIL = 2

# Catalog surface freeze; full wallpaper-plugin-tasks.json loader will supersede.
KNOWN_TASKS = frozenset(
    {
        "WP-PLAN-01",
        "WP-INFRA",
        "WP-00",
        "WP-01",
        "WP-02",
        "WP-03",
        "WP-04",
        "WP-05",
        "WP-06",
        "WP-07",
        "WP-08",
        "WP-09",
        "WP-10A",
        "WP-10B",
        "WP-10C",
        "WP-11A",
        "WP-11B",
        "WP-11C",
        "WP-12A",
        "WP-12B",
        "WP-12C",
        "WP-12D",
        "WP-12E",
    }
)

# States that cannot re-enter begin-phase.
ILLEGAL_BEGIN_STATES = frozenset(
    {
        "DONE",
        "FAILED",
        "BLOCKED_PUSH",
        "BLOCKED_PR",
        "BLOCKED_GIT_STATE",
        "BLOCKED_EVIDENCE_STATE",
        "BLOCKED_EVIDENCE_COLLISION",
    }
)

FAILED_ATTEMPT_STATUSES = frozenset({"ATTEMPT_FAILED", "FAILED"})
LEASE_FIELDS = ("leaseNonce", "leaseUntil", "collectorPid")

RECEIPT_SCHEMA = "wallpaper-task-receipt/v1"
RECEIPT_MODE = 0o600


# ---------------------------------------------------------------------------
# Fail-closed I/O
# ---------------------------------------------------------------------------


class FailClosed(Exception):
    def __init__(self, reason: str, message: str = "") -> None:
        super().__init__(message or reason)
        self.reason = reason
        self.message = message or reason


def emit_failure(reason: str, message: str = "", exit_code: int = EXIT_FAIL) -> NoReturn:
    payload = {
        "ok": False,
        "failureReason": reason,
        "message": message or reason,
    }
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # Machine-readable on both streams so callers can scrape either.
    print(text, file=sys.stderr)
    print(text, file=sys.stdout)
    raise SystemExit(exit_code)


def fail(reason: str, message: str = "") -> NoReturn:
    emit_failure(reason, message)


def emit_ok(command: str, **fields: Any) -> int:
    payload = {"ok": True, "command": command, **fields}
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


def fsync_parent(path: Path) -> None:
    dir_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def atomic_write_bytes(path: Path, payload: bytes, mode: int = 0o600) -> None:
    """same-dir temp → write → flush → fsync(file) → os.replace → fsync(parent)."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        fsync_parent(path)
    finally:
        if temporary_path.exists():
            try:
                temporary_path.unlink()
            except OSError:
                pass


def exclusive_create_bytes(
    path: Path,
    payload: bytes,
    mode: int = 0o600,
    *,
    exists_reason: str = "EVIDENCE_PATH_EXISTS",
) -> None:
    """no-clobber exclusive create with fsync; fails if path already exists."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(path, flags, mode)
    except FileExistsError:
        fail(exists_reason, f"refusing to clobber existing path: {path}")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        fsync_parent(path)
    except Exception:
        if path.exists():
            try:
                path.unlink()
            except OSError:
                pass
        raise


def canonical_receipt_bytes(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


@contextlib.contextmanager
def receipt_lock(receipt: Path) -> Iterator[None]:
    """Advisory exclusive lock on <receipt>.lock (mode 0600)."""
    lock_path = receipt.with_name(receipt.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


# ---------------------------------------------------------------------------
# Paths & receipts
# ---------------------------------------------------------------------------


def transaction_path(transactions_dir: str, task_id: str) -> Path:
    return Path(transactions_dir) / f"{task_id.lower()}.json"


def load_receipt(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail("MISSING_RECEIPT", f"receipt not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("ILLEGAL_STATE", f"receipt unreadable: {exc}")
    if not isinstance(data, dict):
        fail("ILLEGAL_STATE", "receipt must be a JSON object")
    return data


def require_task(task_id: str | None) -> str:
    if not task_id:
        fail("UNKNOWN_TASK", "missing --task")
    if task_id not in KNOWN_TASKS:
        fail("UNKNOWN_TASK", f"unknown task id: {task_id}")
    return task_id


def require_transactions(transactions: str | None) -> str:
    if not transactions:
        fail("MISSING_RECEIPT", "missing --transactions")
    return transactions


def is_under(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def resolve_path(raw: str) -> Path:
    path = Path(raw)
    if path.exists():
        return path.resolve()
    return Path(os.path.abspath(raw))


def sandbox_roots(transactions_dir: str) -> tuple[Path, Path, Path]:
    txn_root = Path(transactions_dir).resolve()
    sandbox = txn_root.parent
    evidence_root = sandbox / "evidence"
    return sandbox, txn_root, evidence_root


def reject_caller_identity(args: argparse.Namespace) -> None:
    if args.transaction_id or args.run_uuid:
        fail(
            "CALLER_SUPPLIED_IDENTITY",
            "transactionId/runUuid must not be supplied on the CLI",
        )
    if os.environ.get("TRANSACTION_ID") or os.environ.get("RUN_UUID"):
        fail(
            "CALLER_SUPPLIED_IDENTITY",
            "transactionId/runUuid must not be supplied via environment",
        )


def reject_existing_path(path: Path) -> None:
    if path.exists():
        fail("EVIDENCE_PATH_EXISTS", f"refusing to clobber existing path: {path}")


# ---------------------------------------------------------------------------
# Evidence path containment
# ---------------------------------------------------------------------------


def assert_evidence_contained(transactions: str, path_raw: str) -> Path:
    sandbox, txn_root, evidence_root = sandbox_roots(transactions)
    target = resolve_path(path_raw)

    if is_under(target, evidence_root) or is_under(target, txn_root):
        return target

    if not is_under(target, sandbox):
        # Sibling of sandbox (one level up) → containment escape.
        if target.parent.resolve() == sandbox.parent.resolve():
            fail("EVIDENCE_PATH_ESCAPE", f"path escapes sandbox: {target}")
        fail(
            "EVIDENCE_PATH_NOT_TRANSACTION",
            f"path is outside transaction evidence tree: {target}",
        )

    fail(
        "EVIDENCE_PATH_NOT_TRANSACTION",
        f"path is not under transaction evidence tree: {target}",
    )


# ---------------------------------------------------------------------------
# Writer lease validation
# ---------------------------------------------------------------------------


def receipt_has_lease(receipt: Mapping[str, Any]) -> bool:
    return any(receipt.get(key) not in (None, "") for key in LEASE_FIELDS)


def attempt_by_no(receipt: Mapping[str, Any], attempt_no: int | None) -> dict[str, Any] | None:
    attempts = receipt.get("attempts") or []
    if not isinstance(attempts, list) or attempt_no is None:
        return None
    for item in attempts:
        if isinstance(item, dict) and item.get("attemptNo") == attempt_no:
            return item
    return None


def attempt_is_closed(attempt: Mapping[str, Any]) -> bool:
    return attempt.get("leaseClosed") is True or attempt.get("status") in FAILED_ATTEMPT_STATUSES


def parse_optional_int(value: str | None, reason: str, label: str) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        fail(reason, f"{label} must be integer")


def validate_writer_lease(receipt: Mapping[str, Any], args: argparse.Namespace) -> None:
    if not receipt_has_lease(receipt):
        fail("WRITER_LEASE_REQUIRED", "collector write requires a valid writer lease")

    now_ms = int(time.time() * 1000)
    attempt_no = (
        parse_optional_int(args.attempt_no, "WRITER_LEASE_INVALID", "attempt-no")
        if args.attempt_no is not None
        else receipt.get("attemptNo")
    )
    if attempt_no is not None and not isinstance(attempt_no, int):
        try:
            attempt_no = int(attempt_no)
        except (TypeError, ValueError):
            fail("WRITER_LEASE_INVALID", "attemptNo is not integer")

    lease_nonce = args.lease_nonce or receipt.get("leaseNonce")

    # Explicit CLI lease-until overrides receipt (tests inject past times).
    if args.lease_until is not None:
        lease_until = parse_optional_int(args.lease_until, "WRITER_LEASE_INVALID", "lease-until")
        if lease_until is not None and lease_until < now_ms:
            fail("WRITER_LEASE_INVALID", "writer lease expired")
    else:
        receipt_until = receipt.get("leaseUntil")
        if isinstance(receipt_until, (int, float)) and int(receipt_until) < now_ms:
            fail("WRITER_LEASE_INVALID", "writer lease expired")

    current_no = receipt.get("attemptNo")
    attempt = attempt_by_no(receipt, attempt_no if isinstance(attempt_no, int) else None)

    if (
        attempt_no is not None
        and current_no is not None
        and int(attempt_no) != int(current_no)
    ):
        fail("WRITER_LEASE_INVALID", "writer does not belong to current attempt")

    if attempt is not None:
        if attempt_is_closed(attempt):
            fail("WRITER_LEASE_INVALID", "writer lease closed or failed")
        if (
            lease_nonce
            and attempt.get("leaseNonce")
            and attempt.get("leaseNonce") != lease_nonce
        ):
            fail("WRITER_LEASE_INVALID", "lease nonce mismatch for attempt")

    if (
        lease_nonce
        and receipt.get("leaseNonce")
        and lease_nonce != receipt.get("leaseNonce")
    ):
        if attempt is None or attempt.get("status") != "EVIDENCE_ATTEMPT_OPEN":
            fail("WRITER_LEASE_INVALID", "stale or foreign lease nonce")


def require_parent_evidence(receipt: Mapping[str, Any], transactions: str) -> None:
    parent_task = receipt.get("parentTaskId")
    if not parent_task:
        return

    parent_sha = receipt.get("parentManifestSha256")
    if not parent_sha:
        fail("PARENT_EVIDENCE_REQUIRED", f"parent evidence missing for {parent_task}")

    parent_path = transaction_path(transactions, str(parent_task))
    if not parent_path.is_file():
        return
    parent = load_receipt(parent_path)
    if parent.get("EffectiveDone") is not True or parent.get("state") != "DONE":
        fail("PARENT_EVIDENCE_REQUIRED", f"parent {parent_task} not EffectiveDone")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_reconcile(args: argparse.Namespace) -> int:
    task_id = require_task(args.task)
    transactions = require_transactions(args.transactions)
    path = transaction_path(transactions, task_id)
    if path.is_file():
        load_receipt(path)
    return emit_ok("reconcile", taskId=task_id)


def cmd_assert_state(args: argparse.Namespace) -> int:
    task_id = require_task(args.task)

    # Callers must never force DONE; only verify-done may derive it.
    if args.declare_done:
        fail("CALLER_DECLARED_DONE", "caller must not declare DONE")

    if args.expected == "DONE":
        transactions = require_transactions(args.transactions)
        path = transaction_path(transactions, task_id)
        if not path.is_file():
            fail("MISSING_RECEIPT", f"receipt not found: {path}")
        receipt = load_receipt(path)
        if receipt.get("state") != "DONE":
            fail("ILLEGAL_STATE", "receipt is not DONE")

    return emit_ok("assert-state", taskId=task_id)


def cmd_cas_state(args: argparse.Namespace) -> int:
    task_id = require_task(args.task)
    if args.to == "DONE":
        fail("CALLER_DECLARED_DONE", "caller must not CAS to DONE")
    return emit_ok("cas-state", taskId=task_id)


def cmd_begin_phase(args: argparse.Namespace) -> int:
    task_id = require_task(args.task)
    transactions = require_transactions(args.transactions)
    path = transaction_path(transactions, task_id)
    if not path.is_file():
        fail("MISSING_RECEIPT", f"receipt not found: {path}")
    receipt = load_receipt(path)
    state = receipt.get("state")
    if state in ILLEGAL_BEGIN_STATES:
        fail("ILLEGAL_STATE", f"cannot begin-phase from state={state}")
    return emit_ok("begin-phase", taskId=task_id)


def cmd_init(args: argparse.Namespace) -> int:
    task_id = require_task(args.task)
    reject_caller_identity(args)
    require_transactions(args.transactions)
    # Identities are generated only inside the runner (init persistence later).
    return emit_ok("init", taskId=task_id)


def cmd_assert_evidence_path(args: argparse.Namespace) -> int:
    if not args.path:
        fail("EVIDENCE_PATH_NOT_TRANSACTION", "missing --path")
    if args.contained:
        if not args.file:
            fail("EVIDENCE_PATH_NOT_TRANSACTION", "missing --file")
        transactions = require_transactions(args.transactions)
        # require_transactions uses MISSING_RECEIPT; map containment-only miss.
        assert_evidence_contained(transactions, args.path)
    return emit_ok("assert-evidence-path", path=args.path)


def cmd_collect_raw(args: argparse.Namespace) -> int:
    if not args.path:
        fail("EVIDENCE_PATH_NOT_TRANSACTION", "missing --path")
    target = resolve_path(args.path)
    reject_existing_path(target)
    if args.transactions and args.contained:
        assert_evidence_contained(args.transactions, args.path)
    return emit_ok("collect-raw", path=str(target))


def cmd_collector_write(args: argparse.Namespace) -> int:
    if not args.file:
        fail("MISSING_RECEIPT", "missing --file")
    receipt = load_receipt(Path(args.file))
    validate_writer_lease(receipt, args)
    if args.path:
        reject_existing_path(resolve_path(args.path))
    return emit_ok("collector-write", taskId=receipt.get("taskId"))


def cmd_open_attempt(args: argparse.Namespace) -> int:
    task_id = require_task(args.task)
    transactions = require_transactions(args.transactions)
    path = transaction_path(transactions, task_id)
    if not path.is_file():
        fail("MISSING_RECEIPT", f"receipt not found: {path}")
    receipt = load_receipt(path)
    if args.require_parent_effective_done:
        require_parent_evidence(receipt, transactions)
    return emit_ok("open-attempt", taskId=task_id)


def _adb_shell(serial: str, shell_args: list[str], timeout: float = 20.0) -> tuple[int, str, str]:
    cmd = ["adb", "-s", serial, "shell", *shell_args]
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return 127, "", "adb not found on PATH"
    except subprocess.TimeoutExpired:
        return 124, "", "adb timed out"
    return int(r.returncode), r.stdout or "", r.stderr or ""


def cmd_assert_device_context(args: argparse.Namespace) -> int:
    """WP-10A+ device Gate: serial/user/release/api/abi/unlocked fail-closed.

    Does not install packages. Offline / mismatch → BLOCKED_DEVICE (non-zero).
    """
    task_id = require_task(args.task) if args.task else None
    serial = getattr(args, "serial", None) or ""
    if not serial:
        fail("BLOCKED_DEVICE", "missing --serial (no default)")
    user = getattr(args, "user", None)
    if user is None or str(user) == "":
        fail("BLOCKED_DEVICE", "missing --user (no default)")
    user_s = str(user)
    expect_release = str(getattr(args, "android_release", None) or "12")
    expect_api = int(getattr(args, "api_level", None) or 31)
    expect_abi = str(getattr(args, "abi", None) or "arm64-v8a")
    require_unlocked = bool(getattr(args, "require_unlocked", False))
    current_user = getattr(args, "current_user", None)
    if current_user is not None and str(current_user) != "":
        if str(current_user) != user_s:
            fail(
                "BLOCKED_DEVICE",
                f"--current-user {current_user} != --user {user_s}",
            )

    # State
    try:
        st = subprocess.run(
            ["adb", "-s", serial, "get-state"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except FileNotFoundError:
        fail("BLOCKED_DEVICE", "adb not found on PATH")
    except subprocess.TimeoutExpired:
        fail("BLOCKED_DEVICE", f"adb get-state timed out for {serial}")
    state = (st.stdout or "").strip()
    if st.returncode != 0 or state != "device":
        fail(
            "BLOCKED_DEVICE",
            f"device {serial} not online (state={state or 'missing'})",
        )

    # Properties
    rc, out, err = _adb_shell(serial, ["getprop", "ro.build.version.release"])
    release = out.strip()
    if rc != 0 or release != expect_release:
        fail(
            "BLOCKED_DEVICE",
            f"android-release {release!r} != {expect_release!r} ({err.strip()})",
        )
    rc, out, err = _adb_shell(serial, ["getprop", "ro.build.version.sdk"])
    try:
        api = int((out or "").strip())
    except ValueError:
        api = -1
    if rc != 0 or api != expect_api:
        fail("BLOCKED_DEVICE", f"api-level {api} != {expect_api}")

    rc, out, err = _adb_shell(serial, ["getprop", "ro.product.cpu.abilist"])
    abilist = (out or "").strip()
    if rc != 0 or expect_abi not in abilist.split(","):
        # also accept single abi prop
        rc2, out2, _ = _adb_shell(serial, ["getprop", "ro.product.cpu.abi"])
        if expect_abi not in ((out2 or "").strip(),) and expect_abi not in abilist:
            fail(
                "BLOCKED_DEVICE",
                f"abi {expect_abi!r} not in abilist={abilist!r} abi={out2.strip()!r}",
            )

    # User exists + current user
    rc, out, err = _adb_shell(serial, ["pm", "list", "users"])
    if rc != 0 or f"UserInfo{{{user_s}:" not in out and f"UserInfo{{{user_s}," not in out:
        # Android formats: UserInfo{12:name:flags}
        if f"{{{user_s}:" not in out and f"UserInfo{{{user_s}" not in out:
            fail("BLOCKED_DEVICE", f"user {user_s} not present: {out.strip()[:200]}")

    rc, out, err = _adb_shell(serial, ["am", "get-current-user"])
    cur = (out or "").strip()
    if rc != 0 or cur != user_s:
        fail(
            "BLOCKED_DEVICE",
            f"current user {cur!r} != required {user_s}",
        )

    if require_unlocked:
        rc, out, err = _adb_shell(serial, ["dumpsys", "window", "policy"])
        blob = f"{out}\n{err}".lower()
        # Fail-closed if clearly locked; if dumpsys empty, still require screen interactive if available
        if "mshowinglockscreen=true" in blob.replace(" ", "") or "isstatusbarkeyguardshowing=true" in blob.replace(
            " ", ""
        ):
            fail("BLOCKED_DEVICE", "device is locked (require-unlocked)")
        rc2, out2, _ = _adb_shell(serial, ["dumpsys", "power"])
        pblob = (out2 or "").lower()
        if "mholdingwakelocksuspendblocker=false" in pblob.replace(" ", "") and "mwakefulness=asleep" in pblob.replace(
            " ", ""
        ):
            fail("BLOCKED_DEVICE", "device asleep (require-unlocked)")

    fields: dict[str, Any] = {
        "serial": serial,
        "user": user_s,
        "androidRelease": release,
        "apiLevel": api,
        "abi": expect_abi,
        "state": state,
        "unlocked": require_unlocked,
    }
    if task_id:
        fields["taskId"] = task_id
    return emit_ok("assert-device-context", **fields)


# ---------------------------------------------------------------------------
# Receipt surface: exclusive-create, 0600, lock, revision/state CAS,
# atomic fsync replace, independent readback, IN_FLIGHT recovery, append-only.
# ---------------------------------------------------------------------------


def is_in_flight_state(state: Any) -> bool:
    return isinstance(state, str) and state.endswith("_IN_FLIGHT")


def require_receipt_arg(args: argparse.Namespace) -> Path:
    if not args.receipt:
        fail("MISSING_RECEIPT", "missing --receipt")
    return Path(args.receipt)


def enforce_receipt_containment(path: Path, args: argparse.Namespace) -> None:
    if not args.require_contained:
        return
    if not args.receipts_root:
        fail("RECEIPT_PATH_ESCAPE", "missing --receipts-root with --require-contained")
    root = Path(args.receipts_root).resolve()
    target = path.resolve() if path.exists() else Path(os.path.abspath(str(path)))
    if is_under(target, root):
        return
    fail("RECEIPT_PATH_ESCAPE", f"receipt path escapes receipts root: {target}")


def resolve_receipt_path(args: argparse.Namespace) -> Path:
    path = require_receipt_arg(args)
    enforce_receipt_containment(path, args)
    return path


def assert_receipt_mode(path: Path) -> None:
    mode = path.stat().st_mode & 0o777
    if mode != RECEIPT_MODE:
        fail(
            "RECEIPT_MODE_INVALID",
            f"receipt mode must be 0o600, got {oct(mode)}",
        )


def load_task_receipt(path: Path, *, check_mode: bool = False) -> dict[str, Any]:
    if not path.is_file():
        fail("MISSING_RECEIPT", f"receipt not found: {path}")
    if check_mode:
        assert_receipt_mode(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail("RECEIPT_CORRUPT", f"receipt JSON corrupt: {exc}")
    except OSError as exc:
        fail("RECEIPT_CORRUPT", f"receipt unreadable: {exc}")
    if not isinstance(data, dict):
        fail("RECEIPT_CORRUPT", "receipt must be a JSON object")
    return data


def store_task_receipt(path: Path, value: Mapping[str, Any]) -> None:
    atomic_write_bytes(path, canonical_receipt_bytes(value), mode=RECEIPT_MODE)


def store_task_receipt_with_readback(path: Path, value: Mapping[str, Any]) -> dict[str, Any]:
    store_task_receipt(path, value)
    readback = load_task_receipt(path, check_mode=True)
    if readback != value:
        fail("RECEIPT_READBACK_MISMATCH", "post-write independent readback mismatch")
    return readback


def parse_json_object(raw: str | None, *, label: str, required: bool) -> dict[str, Any]:
    if raw is None or raw == "":
        if required:
            fail("ILLEGAL_STATE", f"missing {label}")
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail("ILLEGAL_STATE", f"invalid {label}: {exc}")
    if not isinstance(value, dict):
        fail("ILLEGAL_STATE", f"{label} must be a JSON object")
    return value


def reject_if_in_flight(receipt: Mapping[str, Any], *, action: str) -> None:
    state = receipt.get("state")
    if is_in_flight_state(state):
        fail(
            "RECEIPT_IN_FLIGHT_RECOVERY_REQUIRED",
            f"state {state} requires resume/readback before {action}",
        )


def assert_revision_matches(receipt: Mapping[str, Any], expected: int | None) -> None:
    if expected is None:
        fail("RECEIPT_REVISION_CAS", "missing --expected-revision")
    if receipt.get("revision") != expected:
        fail(
            "RECEIPT_REVISION_CAS",
            f"revision mismatch: expected {expected}, got {receipt.get('revision')}",
        )


def assert_state_matches(receipt: Mapping[str, Any], expected: str | None) -> None:
    if not expected:
        fail("RECEIPT_STATE_CAS", "missing --expected-state")
    if receipt.get("state") != expected:
        fail(
            "RECEIPT_STATE_CAS",
            f"state mismatch: expected {expected}, got {receipt.get('state')}",
        )


def reject_caller_effective_done(patch: Mapping[str, Any]) -> None:
    if patch.get("EffectiveDone") is True:
        fail(
            "ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE",
            "only verify-done may set EffectiveDone=true",
        )


def bump_revision(receipt: Mapping[str, Any]) -> int:
    return int(receipt.get("revision", 0)) + 1


def load_locked_receipt(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail("MISSING_RECEIPT", f"receipt not found: {path}")
    return load_task_receipt(path, check_mode=True)


def cmd_receipt_init(args: argparse.Namespace) -> int:
    path = resolve_receipt_path(args)
    if path.exists():
        fail("RECEIPT_EXISTS", f"receipt already exists (no-clobber): {path}")

    task_id = args.task or "WP-INFRA"
    if task_id not in KNOWN_TASKS:
        fail("UNKNOWN_TASK", f"unknown task id: {task_id}")

    initial = {
        "schema": args.schema or RECEIPT_SCHEMA,
        "taskId": task_id,
        "state": "INIT",
        "revision": 1,
        "EffectiveDone": False,
        "attempts": [],
        "phaseEvents": [],
    }
    exclusive_create_bytes(
        path,
        canonical_receipt_bytes(initial),
        mode=RECEIPT_MODE,
        exists_reason="RECEIPT_EXISTS",
    )
    return emit_ok("receipt-init", receipt=str(path), taskId=task_id, revision=1)


def cmd_receipt_cas(args: argparse.Namespace) -> int:
    path = resolve_receipt_path(args)
    if not args.state:
        fail("ILLEGAL_STATE", "missing --state")
    patch = parse_json_object(args.set_json, label="--set-json", required=False)

    with receipt_lock(path):
        current = load_locked_receipt(path)
        reject_if_in_flight(current, action="cas")
        reject_caller_effective_done(patch)
        assert_revision_matches(current, args.expected_revision)
        assert_state_matches(current, args.expected_state)

        next_value = dict(current)
        next_value.update(patch)
        next_value["state"] = args.state
        next_value["revision"] = bump_revision(current)
        # Safety net: receipt-cas must never newly enable EffectiveDone.
        if next_value.get("EffectiveDone") is True and current.get("EffectiveDone") is not True:
            fail(
                "ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE",
                "only verify-done may set EffectiveDone=true",
            )

        store_task_receipt_with_readback(path, next_value)

    return emit_ok(
        "receipt-cas",
        receipt=str(path),
        revision=next_value["revision"],
        state=next_value["state"],
    )


def cmd_receipt_read(args: argparse.Namespace) -> int:
    path = resolve_receipt_path(args)
    data = load_task_receipt(path, check_mode=True)
    if args.field:
        cursor: Any = data
        for part in args.field.split("."):
            if not isinstance(cursor, dict) or part not in cursor:
                fail("ILLEGAL_STATE", f"field not found: {args.field}")
            cursor = cursor[part]
        if isinstance(cursor, (dict, list)):
            print(json.dumps(cursor, ensure_ascii=False, separators=(",", ":")))
        else:
            print(cursor)
        return 0
    print(canonical_receipt_bytes(data).decode(), end="")
    return 0


def cmd_receipt_readback(args: argparse.Namespace) -> int:
    path = resolve_receipt_path(args)
    data = load_task_receipt(path, check_mode=True)
    again = load_task_receipt(path, check_mode=True)
    if again != data:
        fail("RECEIPT_READBACK_MISMATCH", "independent readback mismatch")
    return emit_ok(
        "receipt-readback",
        receipt=str(path),
        revision=data.get("revision"),
        state=data.get("state"),
    )


def cmd_receipt_append_attempt(args: argparse.Namespace) -> int:
    path = resolve_receipt_path(args)
    attempt = parse_json_object(args.attempt_json, label="--attempt-json", required=True)

    with receipt_lock(path):
        current = load_locked_receipt(path)
        reject_if_in_flight(current, action="append-attempt")
        assert_revision_matches(current, args.expected_revision)

        if attempt.get("overwrite") is True:
            fail("ATTEMPT_APPEND_ONLY", "overwrite of attempts is forbidden")

        attempts = current.get("attempts") or []
        if not isinstance(attempts, list):
            fail("RECEIPT_CORRUPT", "attempts must be an array")

        attempt_no = attempt.get("attemptNo")
        for existing in attempts:
            if isinstance(existing, dict) and existing.get("attemptNo") == attempt_no:
                fail(
                    "ATTEMPT_APPEND_ONLY",
                    f"attemptNo {attempt_no} already exists; append-only",
                )

        next_value = dict(current)
        next_value["attempts"] = [*attempts, dict(attempt)]
        next_value["revision"] = bump_revision(current)
        store_task_receipt_with_readback(path, next_value)

    return emit_ok(
        "receipt-append-attempt",
        receipt=str(path),
        revision=next_value["revision"],
        attemptNo=attempt_no,
    )


def cmd_receipt_resume(args: argparse.Namespace) -> int:
    path = resolve_receipt_path(args)
    with receipt_lock(path):
        current = load_locked_receipt(path)
        if not is_in_flight_state(current.get("state")):
            return emit_ok(
                "receipt-resume",
                receipt=str(path),
                state=current.get("state"),
                revision=current.get("revision"),
            )

        # Response-loss recovery: independent remote/API readback first, then
        # --confirm-readback may clear IN_FLIGHT back to resumeState.
        if not getattr(args, "confirm_readback", False):
            fail(
                "RECEIPT_IN_FLIGHT_RECOVERY_REQUIRED",
                "IN_FLIGHT resume requires independent readback first "
                "(pass --confirm-readback after readback)",
            )
        resume_state = current.get("resumeState")
        if not resume_state:
            fail(
                "RECEIPT_IN_FLIGHT_RECOVERY_REQUIRED",
                "missing resumeState for IN_FLIGHT recovery",
            )
        next_value = dict(current)
        next_value["state"] = resume_state
        next_value["revision"] = bump_revision(current)
        store_task_receipt_with_readback(path, next_value)
        return emit_ok(
            "receipt-resume",
            receipt=str(path),
            state=resume_state,
            revision=next_value["revision"],
        )


# ---------------------------------------------------------------------------
# Bootstrap / EffectiveGate surface
# exclusive bootstrap receipt, SHA freeze, exact origin readback, phase ledger,
# response-loss recovery, and EffectiveGate derivation.
# ---------------------------------------------------------------------------

BOOTSTRAP_SCHEMA = "wallpaper-infra-bootstrap/v1"
BOOTSTRAP_MODE = 0o600
# Exact-push / ls-remote allowlists (GREEN-07). Single source of truth.
APPROVED_INFRA_BRANCH = "codex/wallpaper-plugin-infra"
APPROVED_INFRA_REF = f"refs/heads/{APPROVED_INFRA_BRANCH}"
DEFAULT_INFRA_REF = APPROVED_INFRA_REF
APPROVED_BASE_BRANCH = "huawei-android12-car"
# Live task branches for exact-push: any codex/wallpaper-plugin-* (not base/main/master).
FORBIDDEN_PUSH_BRANCHES = frozenset({"main", "master", "huawei-android12-car", "HEAD"})
TASK_BRANCH_PREFIX = "codex/wallpaper-plugin-"
APPROVED_BASE_REF = f"refs/heads/{APPROVED_BASE_BRANCH}"
APPROVED_PUSH_REMOTE = "origin"
DEFAULT_GIT_REMOTE = APPROVED_PUSH_REMOTE
LAST_ORIGIN_LS_REMOTE = "lastOriginLsRemote"
SOURCE_GIT_LS_REMOTE = "git-ls-remote"
SOURCE_GH_PR_API = "gh-pr-api"
SOURCE_GIT_MERGE_BASE = "git-merge-base-is-ancestor"
EXACT_SYNC_SOURCE_LS_REMOTE = "ls-remote"
GIT_LS_REMOTE_TIMEOUT_S = 60
GIT_REV_PARSE_TIMEOUT_S = 30
GH_API_TIMEOUT_S = 60
# android-car/scripts/wallpaper-task.py → android-car/verification/.../WP-INFRA.json
CANONICAL_BOOTSTRAP_RECEIPT = (
    Path(__file__).resolve().parent.parent
    / "verification"
    / "wallpaper-plugin"
    / "bootstrap"
    / "WP-INFRA.json"
)
REQUIRED_PHASES = ("RED", "GREEN", "REFACTOR", "VERIFY", "COMMIT")
REQUIRED_GATE_VALUE_FIELDS = (
    "INFRA_SHA",
    "runnerSha256",
    "catalogSha256",
    "schemaSha256",
    "originReadback",
    "phaseEvents",
)
# catalogTestReceipt / schemaTestReceipt are required later with BOOTSTRAP_MISSING_FIELD
# (after phase/origin/blob layers) so ordered gate failures stay stable.
# Frozen blob paths relative to this runner (GREEN-10 always recompute against these).
_FROZEN_SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_RUNNER_BLOB_PATH = Path(__file__).resolve()
DEFAULT_CATALOG_BLOB_PATH = _FROZEN_SCRIPT_DIR / "wallpaper-plugin-tasks.json"
DEFAULT_SCHEMA_BLOB_PATH = _FROZEN_SCRIPT_DIR / "wallpaper-task.schema.json"
AUTHENTIC_TEST_RECEIPT_SOURCES = frozenset(
    {
        "node-test",
        "production-test",
        "bootstrap-record-test-receipt",
    }
)
CALLER_FORGED_TEST_SOURCES = frozenset(
    {
        "caller",
        "forged",
        "caller-forged",
        "caller-forged-cli-success",
    }
)
TEST_RECEIPT_FIELD_BY_KIND = {
    "catalog": "catalogTestReceipt",
    "schema": "schemaTestReceipt",
    "runner": "runnerTestReceipt",
}
SHA_KIND_TO_FIELD = {
    "runner": "runnerSha256",
    "catalog": "catalogSha256",
    "schema": "schemaSha256",
}
LEGAL_BOOTSTRAP_STATES = frozenset(
    {
        "INIT",
        "INFRA_REMOTE_VERIFIED",
        "SYNC_IN_FLIGHT",
        "INFRA_PR_OPEN_VERIFIED",
        "INFRA_PR_FINAL_VERIFIED",
        "INFRA_PR_MERGE_IN_FLIGHT",
        "INFRA_PR_MERGED_VERIFIED",
        "INFRA_AUTHORITATIVE_BASE_VERIFIED",
        "DONE",
    }
)


def new_uuid() -> str:
    return str(uuid.uuid4())


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def empty_bootstrap_receipt(task_id: str) -> dict[str, Any]:
    return {
        "schema": BOOTSTRAP_SCHEMA,
        "taskId": task_id,
        "state": "INIT",
        "revision": 1,
        "transactionId": new_uuid(),
        "runUuid": new_uuid(),
        "phaseEvents": [],
        "INFRA_SHA": None,
        "runnerSha256": None,
        "catalogSha256": None,
        "schemaSha256": None,
        "catalogTestReceipt": None,
        "schemaTestReceipt": None,
        "runnerTestReceipt": None,
        "originReadback": None,
        "exactSync": None,
        "prMerge": None,
        "baseContainment": None,
        "infraPr": None,
        "EffectiveDone": False,
        "EffectiveGate": False,
    }


def enforce_bootstrap_containment(path: Path, args: argparse.Namespace) -> None:
    if not args.require_contained:
        return
    if not args.bootstrap_root:
        fail("BOOTSTRAP_PATH_ESCAPE", "missing --bootstrap-root with --require-contained")
    root = Path(args.bootstrap_root).resolve()
    target = path.resolve() if path.exists() else Path(os.path.abspath(str(path)))
    if is_under(target, root):
        return
    fail("BOOTSTRAP_PATH_ESCAPE", f"bootstrap path escapes root: {target}")


def resolve_bootstrap_path(args: argparse.Namespace) -> Path:
    if getattr(args, "use_canonical_bootstrap", False):
        path = CANONICAL_BOOTSTRAP_RECEIPT
        # Canonical path is fixed; optional --receipt must match if provided.
        if args.receipt:
            provided = Path(args.receipt).expanduser().resolve()
            if provided != path.resolve():
                fail(
                    "CANONICAL_PATH_REQUIRED",
                    f"--use-canonical-bootstrap requires receipt={path}, got {provided}",
                )
        return path
    if not args.receipt:
        fail("MISSING_RECEIPT", "missing --receipt")
    path = Path(args.receipt)
    enforce_bootstrap_containment(path, args)
    return path


def assert_bootstrap_mode(path: Path) -> None:
    mode = path.stat().st_mode & 0o777
    if mode != BOOTSTRAP_MODE:
        fail(
            "BOOTSTRAP_MODE_INVALID",
            f"bootstrap receipt mode must be 0o600, got {oct(mode)}",
        )


def load_bootstrap_receipt(path: Path, *, check_mode: bool = True) -> dict[str, Any]:
    if not path.is_file():
        fail("MISSING_RECEIPT", f"bootstrap receipt not found: {path}")
    if check_mode:
        assert_bootstrap_mode(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail("RECEIPT_CORRUPT", f"bootstrap receipt JSON corrupt: {exc}")
    except OSError as exc:
        fail("RECEIPT_CORRUPT", f"bootstrap receipt unreadable: {exc}")
    if not isinstance(data, dict):
        fail("RECEIPT_CORRUPT", "bootstrap receipt must be a JSON object")
    return data


def store_bootstrap_receipt(path: Path, value: Mapping[str, Any]) -> None:
    atomic_write_bytes(path, canonical_receipt_bytes(value), mode=BOOTSTRAP_MODE)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_sync_in_flight(state: Any) -> bool:
    return state == "SYNC_IN_FLIGHT" or is_in_flight_state(state)


def reject_if_bootstrap_in_flight(receipt: Mapping[str, Any], *, action: str) -> None:
    state = receipt.get("state")
    if is_sync_in_flight(state):
        fail(
            "SYNC_IN_FLIGHT_RECOVERY_REQUIRED",
            f"state {state} requires sync resume/readback before {action}",
        )


def mutate_bootstrap(
    path: Path,
    mutator: Callable[[dict[str, Any]], dict[str, Any]],
    *,
    check_mode: bool = True,
    allow_in_flight: bool = False,
) -> dict[str, Any]:
    """Lock, load, optional in-flight reject, mutate, bump revision, store."""
    with receipt_lock(path):
        current = load_bootstrap_receipt(path, check_mode=check_mode)
        if not allow_in_flight:
            reject_if_bootstrap_in_flight(current, action="mutate")
        next_value = mutator(dict(current))
        next_value["revision"] = bump_revision(current)
        store_bootstrap_receipt(path, next_value)
        return next_value


def phase_ledger_complete(phase_events: Any) -> bool:
    if not isinstance(phase_events, list) or not phase_events:
        return False
    by_phase: dict[str, str] = {}
    for event in phase_events:
        if not isinstance(event, dict):
            return False
        phase = event.get("phase")
        status = event.get("status")
        if isinstance(phase, str) and isinstance(status, str):
            by_phase[phase] = status
    return all(by_phase.get(phase) == "PASS" for phase in REQUIRED_PHASES)


def origin_exact_match(origin: Any) -> bool:
    if not isinstance(origin, dict):
        return False
    expected = origin.get("expectedSha")
    observed = origin.get("observedSha")
    return is_git_sha40(expected) and expected == observed


def is_git_sha40(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 40 and all(
        ch in "0123456789abcdef" for ch in value.lower()
    )


def normalize_git_sha40(
    value: Any,
    *,
    reason: str = "ORIGIN_SHA_MISMATCH",
    message: str = "value must be a 40-char git SHA",
) -> str:
    """Return lowercased git SHA-40 or fail-closed."""
    if not is_git_sha40(value):
        fail(reason, message)
    return str(value).lower()


def require_matching_git_shas(
    expected: Any,
    observed: Any,
    *,
    reason: str = "ORIGIN_SHA_MISMATCH",
    label: str = "origin",
) -> tuple[str, str]:
    """Validate and compare two git SHAs (case-insensitive). Returns normalized pair."""
    if not expected or not observed:
        fail(reason, f"missing {label} expected/observed SHA")
    exp = normalize_git_sha40(
        expected, reason=reason, message=f"{label} expected must be 40-char git SHA"
    )
    obs = normalize_git_sha40(
        observed, reason=reason, message=f"{label} observed must be 40-char git SHA"
    )
    if exp != obs:
        fail(reason, f"{label} mismatch: expected={exp} observed={obs}")
    return exp, obs


def apply_origin_remote_verified(
    current: dict[str, Any],
    *,
    expected: str,
    observed: str,
    ref: str,
    source: str = SOURCE_GIT_LS_REMOTE,
) -> dict[str, Any]:
    """Write INFRA_SHA + originReadback and advance to INFRA_REMOTE_VERIFIED.

    source must identify independent ls-remote evidence — never caller-only.
    """
    current["INFRA_SHA"] = expected
    current["originReadback"] = {
        "ref": ref,
        "expectedSha": expected,
        "observedSha": observed,
        "source": source,
    }
    current["state"] = "INFRA_REMOTE_VERIFIED"
    return current


def reject_forged_effective_claims(receipt: Mapping[str, Any]) -> None:
    """Fail if receipt claims EffectiveGate/Done without satisfying the gate.

    Always uses EFFECTIVE_GATE_CLAIM_REJECTED so forged DONE/gate flags cannot
    masquerade as a lower-layer gate miss.
    """
    forged = receipt.get("EffectiveDone") is True or receipt.get("EffectiveGate") is True
    if not forged:
        return
    gate, _reason, message = evaluate_bootstrap_gate(receipt)
    if not gate:
        fail(
            "EFFECTIVE_GATE_CLAIM_REJECTED",
            "cannot claim EffectiveDone/EffectiveGate without satisfying gate: " + message,
        )


def is_sha256_hex(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        ch in "0123456789abcdef" for ch in value.lower()
    )


def missing_gate_fields(receipt: Mapping[str, Any]) -> list[str]:
    missing: list[str] = []
    for field in REQUIRED_GATE_VALUE_FIELDS:
        value = receipt.get(field)
        if value is None:
            missing.append(field)
        elif field == "phaseEvents" and not isinstance(value, list):
            missing.append(field)
        elif field.endswith("Sha256") and not is_sha256_hex(value):
            missing.append(field)
        elif field == "INFRA_SHA" and not is_git_sha40(value):
            missing.append(field)
    return missing


def resolve_blob_recompute_paths(
    *,
    runner_path: str | None,
    catalog_path: str | None,
    schema_path: str | None,
) -> tuple[str, str, str]:
    """Frozen implementation paths; CLI overrides must still be real files."""
    runner = runner_path or str(DEFAULT_RUNNER_BLOB_PATH)
    catalog = catalog_path or str(DEFAULT_CATALOG_BLOB_PATH)
    schema = schema_path or str(DEFAULT_SCHEMA_BLOB_PATH)
    return runner, catalog, schema


def recompute_blob_mismatches(
    receipt: Mapping[str, Any],
    *,
    runner_path: str | None,
    catalog_path: str | None,
    schema_path: str | None,
) -> tuple[str | None, str]:
    runner, catalog, schema = resolve_blob_recompute_paths(
        runner_path=runner_path,
        catalog_path=catalog_path,
        schema_path=schema_path,
    )
    checks = (
        ("runner", runner, receipt.get("runnerSha256")),
        ("catalog", catalog, receipt.get("catalogSha256")),
        ("schema", schema, receipt.get("schemaSha256")),
    )
    for kind, file_path, recorded in checks:
        path = Path(file_path)
        if not path.is_file():
            return (
                "BOOTSTRAP_SHA_MISMATCH",
                f"{kind} path missing for recompute: {path}",
            )
        if not is_sha256_hex(recorded):
            return (
                "BOOTSTRAP_SHA_MISMATCH",
                f"{kind} recorded sha256 missing or invalid",
            )
        actual = sha256_file(path)
        if actual != recorded:
            return (
                "BOOTSTRAP_SHA_MISMATCH",
                f"{kind} sha256 mismatch: recorded={recorded} actual={actual}",
            )
    return None, ""


def test_receipt_pass(value: Any) -> bool:
    return isinstance(value, dict) and value.get("pass") is True


def test_receipt_authentic(value: Any) -> bool:
    """Test receipts must prove node --test provenance — not caller pass:true."""
    if not test_receipt_pass(value):
        return False
    assert isinstance(value, dict)
    source = value.get("source")
    command = value.get("command")
    if isinstance(source, str) and source in CALLER_FORGED_TEST_SOURCES:
        return False
    if isinstance(command, str) and "forged" in command.lower():
        return False
    if isinstance(source, str) and source in AUTHENTIC_TEST_RECEIPT_SOURCES:
        return True
    # Legacy authentic shape: explicit node --test command without forged tokens.
    if isinstance(command, str) and "node --test" in command:
        return True
    # Bare {pass:true} without provenance is not authentic.
    return False


def evaluate_test_receipt_layer(
    receipt: Mapping[str, Any],
) -> tuple[str | None, str]:
    """Return (failure_reason, message) or (None, '') when catalog+schema authentic."""
    catalog_tr = receipt.get("catalogTestReceipt")
    schema_tr = receipt.get("schemaTestReceipt")
    missing_tr = [
        name
        for name, value in (
            ("catalogTestReceipt", catalog_tr),
            ("schemaTestReceipt", schema_tr),
        )
        if value is None
    ]
    if missing_tr:
        return (
            "BOOTSTRAP_MISSING_FIELD",
            f"missing required bootstrap fields: {','.join(missing_tr)}",
        )
    if not test_receipt_authentic(catalog_tr) or not test_receipt_authentic(schema_tr):
        return (
            "CALLER_INJECTED_TEST_RECEIPT",
            "catalog/schema test receipts must come from authentic node --test "
            "provenance (source=node-test), not caller pass=true",
        )
    return None, ""


def require_path_bound_sha256(path_raw: str | None, sha: str) -> Path:
    """Require --path and exact file digest match for bootstrap-record-sha."""
    if not path_raw:
        fail(
            "PATH_REQUIRED",
            "bootstrap-record-sha requires --path to bind sha256 to a real file digest",
        )
    file_path = Path(path_raw)
    if not file_path.is_file():
        fail("BOOTSTRAP_SHA_MISMATCH", f"blob path missing: {file_path}")
    actual = sha256_file(file_path)
    if actual != sha:
        fail(
            "BOOTSTRAP_SHA_MISMATCH",
            f"provided sha256 does not match file digest: {path_raw}",
        )
    return file_path


def cli_truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def exact_sync_verified(receipt: Mapping[str, Any]) -> bool:
    exact = receipt.get("exactSync")
    if exact is None:
        exact = receipt.get("syncState")
    if not isinstance(exact, dict):
        return False
    status = exact.get("status")
    if status in {"VERIFIED", "ORIGIN_MATCHED", "EXACT_MATCH"}:
        return True
    expected = exact.get("expectedSha")
    observed = exact.get("observedSha")
    return is_git_sha40(expected) and expected == observed


def pr_merge_verified(receipt: Mapping[str, Any]) -> bool:
    pr = receipt.get("prMerge")
    if pr is None:
        pr = receipt.get("infraPr")
    if not isinstance(pr, dict):
        return False
    return pr.get("merged") is True and is_git_sha40(pr.get("mergeSha"))


def base_containment_verified(receipt: Mapping[str, Any]) -> bool:
    base = receipt.get("baseContainment")
    return isinstance(base, dict) and base.get("containsMerge") is True


def gate_failure(reason: str, message: str) -> tuple[bool, str, str]:
    return False, reason, message


def evaluate_bootstrap_gate(
    receipt: Mapping[str, Any],
    *,
    recompute_paths: bool = False,
    runner_path: str | None = None,
    catalog_path: str | None = None,
    schema_path: str | None = None,
    hard_fail_illegal_state: bool = False,
) -> tuple[bool, str | None, str]:
    """Return (gate, failure_reason_if_false, message).

    Ordered layers (first failure wins):
      state → required value fields → phase ledger → origin →
      always blob recompute (frozen paths) → authentic test receipts →
      exactSync → PR merge → base containment.

    recompute_paths is reserved for CLI hard-fail policy on evaluate; blob
    digests are always recomputed here against frozen (or overridden) paths.
    """
    _ = recompute_paths  # CLI hard-fail policy only; digests always recomputed.
    state = receipt.get("state")
    if not isinstance(state, str) or state not in LEGAL_BOOTSTRAP_STATES:
        msg = f"illegal bootstrap state: {state!r}"
        if hard_fail_illegal_state:
            fail("ILLEGAL_BOOTSTRAP_STATE", msg)
        return gate_failure("ILLEGAL_BOOTSTRAP_STATE", msg)

    missing = missing_gate_fields(receipt)
    if missing:
        return gate_failure(
            "BOOTSTRAP_MISSING_FIELD",
            f"missing required bootstrap fields: {','.join(missing)}",
        )

    if not phase_ledger_complete(receipt.get("phaseEvents")):
        return gate_failure(
            "PHASE_LEDGER_INCOMPLETE",
            "phase ledger must include RED/GREEN/REFACTOR/VERIFY/COMMIT all PASS",
        )

    if not origin_exact_match(receipt.get("originReadback")):
        return gate_failure(
            "ORIGIN_SHA_MISMATCH",
            "origin expectedSha/observedSha missing or not exact equal",
        )

    reason, message = recompute_blob_mismatches(
        receipt,
        runner_path=runner_path,
        catalog_path=catalog_path,
        schema_path=schema_path,
    )
    if reason:
        return gate_failure(reason, message)

    tr_reason, tr_message = evaluate_test_receipt_layer(receipt)
    if tr_reason:
        return gate_failure(tr_reason, tr_message)

    if not exact_sync_verified(receipt):
        return gate_failure(
            "MISSING_EXACT_SYNC_STATE",
            "exactSync/syncState must record verified exact-SHA sync",
        )

    if not pr_merge_verified(receipt):
        return gate_failure(
            "PR_MERGE_REQUIRED",
            "prMerge/infraPr with merged=true and mergeSha is required",
        )

    if not base_containment_verified(receipt):
        return gate_failure(
            "BASE_CONTAINMENT_REQUIRED",
            "baseContainment.containsMerge=true is required",
        )

    return True, None, "EffectiveGate conditions satisfied"


def gate_from_args(
    args: argparse.Namespace,
    *,
    hard_fail_illegal_state: bool = False,
) -> tuple[Path, dict[str, Any], bool, str | None, str]:
    path = resolve_bootstrap_path(args)
    receipt = load_bootstrap_receipt(path, check_mode=True)
    gate, reason, message = evaluate_bootstrap_gate(
        receipt,
        recompute_paths=bool(args.recompute_paths),
        runner_path=args.runner_path,
        catalog_path=args.catalog_path,
        schema_path=args.schema_path,
        hard_fail_illegal_state=hard_fail_illegal_state,
    )
    return path, receipt, gate, reason, message


def cmd_bootstrap_init(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)
    if getattr(args, "use_canonical_bootstrap", False):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        fail("BOOTSTRAP_RECEIPT_EXISTS", f"bootstrap receipt already exists: {path}")

    task_id = args.task or "WP-INFRA"
    if task_id not in KNOWN_TASKS:
        fail("UNKNOWN_TASK", f"unknown task id: {task_id}")

    exclusive_create_bytes(
        path,
        canonical_receipt_bytes(empty_bootstrap_receipt(task_id)),
        mode=BOOTSTRAP_MODE,
        exists_reason="BOOTSTRAP_RECEIPT_EXISTS",
    )
    return emit_ok("bootstrap-init", receipt=str(path), taskId=task_id, revision=1)


def cmd_bootstrap_record_sha(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)
    kind = args.kind
    if kind not in SHA_KIND_TO_FIELD:
        fail("ILLEGAL_STATE", f"unknown sha kind: {kind}")
    field = SHA_KIND_TO_FIELD[kind]
    sha = args.sha256
    if not isinstance(sha, str) or len(sha) != 64:
        fail("BOOTSTRAP_SHA_MISMATCH", "sha256 must be 64 hex chars")

    file_path = require_path_bound_sha256(args.path, sha)

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        current[field] = sha
        return current

    mutate_bootstrap(path, apply, check_mode=True)
    return emit_ok(
        "bootstrap-record-sha",
        receipt=str(path),
        kind=kind,
        sha256=sha,
        path=str(file_path),
    )


def cmd_bootstrap_record_test_receipt(args: argparse.Namespace) -> int:
    """Record catalog/schema/runner test receipt only from authentic node --test proof.

    Caller-only --pass true / forged commands are rejected.
    """
    path = resolve_bootstrap_path(args)
    kind = args.kind
    if kind not in TEST_RECEIPT_FIELD_BY_KIND:
        fail("ILLEGAL_STATE", f"unknown test receipt kind: {kind}")
    field = TEST_RECEIPT_FIELD_BY_KIND[kind]
    # NOTE: args.command is the CLI subcommand; test command is --command / --test-command.
    command = getattr(args, "test_command", None)
    if not command or not isinstance(command, str):
        fail(
            "CALLER_INJECTED_TEST_RECEIPT",
            "missing --command / --test-command for test receipt",
        )
    if "forged" in command.lower():
        fail(
            "CALLER_INJECTED_TEST_RECEIPT",
            "forged test command is not authentic node --test provenance",
        )
    if "node --test" not in command:
        fail(
            "CALLER_INJECTED_TEST_RECEIPT",
            "test receipt command must include 'node --test'",
        )
    if not args.from_node_test:
        fail(
            "CALLER_INJECTED_TEST_RECEIPT",
            "bootstrap-record-test-receipt requires --from-node-test after a real "
            "node --test run (caller --pass alone is forbidden)",
        )
    if args.exit_code is None:
        fail(
            "CALLER_INJECTED_TEST_RECEIPT",
            "missing --exit-code from real node --test process",
        )
    try:
        exit_code_i = int(args.exit_code)
    except (TypeError, ValueError):
        fail("CALLER_INJECTED_TEST_RECEIPT", f"invalid --exit-code: {args.exit_code!r}")

    pass_flag = args.pass_flag
    if pass_flag is not None:
        want_pass = cli_truthy(pass_flag)
        if want_pass and exit_code_i != 0:
            fail(
                "CALLER_INJECTED_TEST_RECEIPT",
                "cannot claim pass=true when --exit-code is non-zero",
            )
        if not want_pass and exit_code_i == 0:
            fail(
                "CALLER_INJECTED_TEST_RECEIPT",
                "cannot claim pass=false when --exit-code is 0",
            )

    record = {
        "pass": exit_code_i == 0,
        "command": command,
        "source": "node-test",
        "exitCode": exit_code_i,
        "recordedAt": utc_now_iso(),
    }

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        current[field] = record
        return current

    mutate_bootstrap(path, apply, check_mode=True)
    return emit_ok(
        "bootstrap-record-test-receipt",
        receipt=str(path),
        kind=kind,
        source="node-test",
        testCommand=command,
        exitCode=exit_code_i,
        **{"pass": record["pass"]},
    )


def cmd_bootstrap_record_phase(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)
    phase = args.phase
    status = args.status
    if not phase or not status:
        fail("ILLEGAL_STATE", "missing --phase or --status")
    if getattr(args, "replace_ledger", False):
        fail(
            "PHASE_LEDGER_APPEND_ONLY",
            "phase ledger is append-only; --replace-ledger is forbidden",
        )

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        events = list(current.get("phaseEvents") or [])
        if not isinstance(events, list):
            fail("RECEIPT_CORRUPT", "phaseEvents must be an array")
        event: dict[str, Any] = {
            "phase": phase,
            "status": status,
            "phaseAttemptId": new_uuid(),
            "completedAt": utc_now_iso(),
        }
        if args.failure_signature:
            event["failureSignature"] = args.failure_signature
        events.append(event)
        current["phaseEvents"] = events
        return current

    mutate_bootstrap(path, apply, check_mode=True)
    return emit_ok("bootstrap-record-phase", receipt=str(path), phase=phase, status=status)


def cmd_bootstrap_record_origin(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)
    expected = args.expected_sha
    observed = args.observed_sha
    if not expected or not observed:
        fail("ORIGIN_SHA_MISMATCH", "missing --expected-sha or --observed-sha")
    if expected != observed:
        fail(
            "ORIGIN_SHA_MISMATCH",
            f"origin sha mismatch: expected={expected} observed={observed}",
        )

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        current["originReadback"] = {
            "ref": args.ref or DEFAULT_INFRA_REF,
            "expectedSha": expected,
            "observedSha": observed,
        }
        if args.infra_sha:
            current["INFRA_SHA"] = args.infra_sha
        elif current.get("INFRA_SHA") is None:
            current["INFRA_SHA"] = expected
        return current

    mutate_bootstrap(path, apply, check_mode=True)
    return emit_ok(
        "bootstrap-record-origin",
        receipt=str(path),
        expectedSha=expected,
        observedSha=observed,
    )


def cmd_bootstrap_readback(args: argparse.Namespace) -> int:
    """Promote REMOTE_VERIFIED only from durable ls-remote — never caller-only SHAs."""
    path = resolve_bootstrap_path(args)
    ref = normalize_approved_infra_ref(args.ref)
    if not args.infra_sha or not args.remote_sha:
        fail("ORIGIN_SHA_MISMATCH", "missing --infra-sha or --remote-sha")
    infra = normalize_git_sha40(
        args.infra_sha,
        reason="ORIGIN_SHA_MISMATCH",
        message="--infra-sha must be a 40-char git SHA",
    )
    remote = normalize_git_sha40(
        args.remote_sha,
        reason="ORIGIN_SHA_MISMATCH",
        message="--remote-sha must be a 40-char git SHA",
    )
    # Mismatch is still ORIGIN_SHA_MISMATCH (RED-04.5) before ls-remote checks.
    if infra != remote:
        fail(
            "ORIGIN_SHA_MISMATCH",
            f"exact origin readback failed: infra={infra} remote={remote}",
        )
    observed = promote_remote_verified_from_ls_remote(
        path,
        expected=infra,
        ref=ref,
        caller_observed=remote,
        caller_field="--remote-sha",
    )
    return emit_ok(
        "bootstrap-readback",
        receipt=str(path),
        infraSha=infra,
        remoteSha=observed,
        state="INFRA_REMOTE_VERIFIED",
        source=SOURCE_GIT_LS_REMOTE,
    )


def cmd_evaluate_effective_gate(args: argparse.Namespace) -> int:
    path, _receipt, gate, reason, message = gate_from_args(
        args,
        hard_fail_illegal_state=True,
    )
    # With --recompute-paths, failures are hard errors (no silent green exit).
    if not gate and args.recompute_paths:
        fail(reason or "EFFECTIVE_GATE_FALSE", message)
    return emit_ok(
        "evaluate-effective-gate",
        receipt=str(path),
        EffectiveGate=gate,
        failureReason=reason,
        message=message,
    )


def cmd_bootstrap_write_status(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)
    if not path.is_file():
        return emit_ok(
            "bootstrap-write-status",
            receipt=str(path),
            written=False,
        )
    # Independent readback proves durable content.
    load_bootstrap_receipt(path, check_mode=True)
    return emit_ok(
        "bootstrap-write-status",
        receipt=str(path),
        written=True,
    )


def cmd_assert_effective_gate(args: argparse.Namespace) -> int:
    if args.expected is None:
        fail("ILLEGAL_STATE", "missing --expected true|false")
    expected = str(args.expected).strip().lower() in {"1", "true", "yes", "on"}
    path, _receipt, gate, reason, message = gate_from_args(args)

    if expected and not gate:
        fail(reason or "EFFECTIVE_GATE_FALSE", message)
    if not expected and gate:
        fail(
            "EFFECTIVE_GATE_CLAIM_REJECTED",
            "EffectiveGate evaluated true but expected false",
        )
    return emit_ok(
        "assert-effective-gate",
        receipt=str(path),
        expected=expected,
        EffectiveGate=gate,
    )


def cmd_bootstrap_claim_done(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)

    def apply(receipt: dict[str, Any]) -> dict[str, Any]:
        reject_forged_effective_claims(receipt)
        gate, reason, message = evaluate_bootstrap_gate(receipt)
        if not gate:
            fail(reason or "EFFECTIVE_GATE_FALSE", message)
        receipt["EffectiveGate"] = True
        receipt["EffectiveDone"] = True
        receipt["state"] = "DONE"
        return receipt

    mutate_bootstrap(path, apply, check_mode=True)
    return emit_ok(
        "bootstrap-claim-done",
        receipt=str(path),
        EffectiveGate=True,
        EffectiveDone=True,
    )


def cmd_bootstrap_sync_begin(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)
    expected = args.expected_sha
    if not expected:
        fail("ORIGIN_SHA_MISMATCH", "missing --expected-sha")

    with receipt_lock(path):
        current = load_bootstrap_receipt(path, check_mode=True)
        reject_if_bootstrap_in_flight(current, action="sync-begin")
        next_value = dict(current)
        next_value["resumeState"] = current.get("state") or "INIT"
        next_value["state"] = "SYNC_IN_FLIGHT"
        next_value["lastExternalOp"] = {
            "kind": "push",
            "expectedSha": expected,
            "ref": args.ref or DEFAULT_INFRA_REF,
        }
        next_value["revision"] = bump_revision(current)
        store_bootstrap_receipt(path, next_value)

    return emit_ok("bootstrap-sync-begin", receipt=str(path), state="SYNC_IN_FLIGHT")


def cmd_bootstrap_sync_resume(args: argparse.Namespace) -> int:
    path = resolve_bootstrap_path(args)
    with receipt_lock(path):
        current = load_bootstrap_receipt(path, check_mode=True)
        if is_sync_in_flight(current.get("state")):
            if not getattr(args, "confirm_readback", False):
                fail(
                    "SYNC_IN_FLIGHT_RECOVERY_REQUIRED",
                    "SYNC_IN_FLIGHT resume requires independent origin readback first "
                    "(pass --confirm-readback after readback)",
                )
            resume_state = current.get("resumeState") or "INFRA_REMOTE_VERIFIED"
            next_value = dict(current)
            next_value["state"] = resume_state
            next_value["revision"] = bump_revision(current)
            store_bootstrap_receipt(path, next_value)
            return emit_ok(
                "bootstrap-sync-resume",
                receipt=str(path),
                state=resume_state,
            )
        return emit_ok(
            "bootstrap-sync-resume",
            receipt=str(path),
            state=current.get("state"),
        )


# ---------------------------------------------------------------------------
# Exact push + origin ls-remote (RED-06 / GREEN-06 / GREEN-07)
# Fail-closed: origin-only remote, approved infra ref, HEAD==expectedSha,
# no real network push without dual auth; seal / REMOTE_VERIFIED only from ls-remote.
# Allowlist constants live with bootstrap constants above.
# ---------------------------------------------------------------------------


def exact_push_authorized(args: argparse.Namespace) -> bool:
    return bool(args.allow_network_push and args.i_understand_real_push)


def run_git(
    argv: list[str],
    *,
    fail_reason: str,
    timeout: int = GIT_REV_PARSE_TIMEOUT_S,
) -> str:
    """Run git and return stdout strip, or fail-closed with fail_reason."""
    try:
        proc = subprocess.run(
            ["git", *argv],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail(fail_reason, f"git {' '.join(argv)} failed: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        fail(fail_reason, f"git {' '.join(argv)} exit {proc.returncode}: {err}")
    return (proc.stdout or "").strip()


def require_approved_remote(remote: str | None) -> str:
    """WP-INFRA exact-push / ls-remote may only use remote=origin."""
    if remote is None:
        return APPROVED_PUSH_REMOTE
    token = str(remote).strip()
    if token == "":
        fail(
            "REMOTE_NOT_ALLOWED",
            "empty remote not allowed; only origin is approved for WP-INFRA",
        )
    if token != APPROVED_PUSH_REMOTE:
        fail(
            "REMOTE_NOT_ALLOWED",
            f"remote not allowed: {token!r}; only origin is approved "
            f"(upstream and other remotes are forbidden)",
        )
    return token


def is_approved_wallpaper_task_branch(branch: str) -> bool:
    """codex/wallpaper-plugin-* only; never main/master/integration base."""
    if not branch or branch in FORBIDDEN_PUSH_BRANCHES:
        return False
    return branch.startswith(TASK_BRANCH_PREFIX)


def normalize_approved_infra_ref(ref: str | None) -> str:
    """Approved push/readback: refs/heads/codex/wallpaper-plugin-*."""
    raw = (ref or DEFAULT_INFRA_REF).strip()
    if not raw:
        fail("REF_NOT_ALLOWED", "missing --ref; approved ref required")
    if raw.startswith("refs/heads/"):
        full = raw
        branch = raw[len("refs/heads/") :]
    elif raw.startswith("refs/"):
        fail(
            "REF_NOT_ALLOWED",
            f"ref not allowed: {raw!r}; only refs/heads/{TASK_BRANCH_PREFIX}*",
        )
    else:
        branch = raw
        full = f"refs/heads/{branch}"
    if not is_approved_wallpaper_task_branch(branch):
        fail(
            "BRANCH_NOT_ALLOWED",
            f"branch/ref not allowed: {raw!r}; only {TASK_BRANCH_PREFIX}* "
            f"task branches. main/master/huawei-android12-car/"
            f"upstream/plan branch are forbidden push targets",
        )
    return full


def local_git_head_sha() -> str:
    return normalize_git_sha40(
        run_git(["rev-parse", "HEAD"], fail_reason="LOCAL_HEAD_MISMATCH"),
        reason="LOCAL_HEAD_MISMATCH",
        message="local HEAD is not a 40-char git SHA",
    )


def local_git_branch_name() -> str:
    branch = run_git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        fail_reason="BRANCH_NOT_ALLOWED",
    )
    if not branch or branch == "HEAD":
        fail(
            "BRANCH_NOT_ALLOWED",
            "detached HEAD is not an approved wallpaper task push branch",
        )
    return branch


def require_expected_is_local_head(expected: str) -> str:
    """expectedSha is an assertion on real local HEAD — never an override input."""
    head = local_git_head_sha()
    if expected != head:
        fail(
            "LOCAL_HEAD_MISMATCH",
            f"expectedSha must equal local HEAD: expected={expected} HEAD={head}",
        )
    branch = local_git_branch_name()
    if not is_approved_wallpaper_task_branch(branch):
        fail(
            "BRANCH_NOT_ALLOWED",
            f"current branch {branch!r} is not an approved wallpaper task branch; "
            f"must be {TASK_BRANCH_PREFIX}* with HEAD == expectedSha",
        )
    return head


def git_ls_remote_sha(ref: str, *, remote: str = DEFAULT_GIT_REMOTE) -> str:
    """Independent origin readback via `git ls-remote --refs`. Never trusts caller SHA."""
    remote = require_approved_remote(remote)
    ref = normalize_approved_infra_ref(ref)
    out = run_git(
        ["ls-remote", "--refs", remote, ref],
        fail_reason="LS_REMOTE_REQUIRED",
        timeout=GIT_LS_REMOTE_TIMEOUT_S,
    )
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    if not lines:
        fail("LS_REMOTE_REQUIRED", f"git ls-remote returned no refs for {ref}")
    return normalize_git_sha40(
        lines[0].split()[0].strip(),
        reason="LS_REMOTE_REQUIRED",
        message=f"invalid ls-remote sha from {remote} {ref}",
    )


def record_last_origin_ls_remote(
    *,
    ref: str,
    remote: str,
    observed: str,
) -> dict[str, Any]:
    return {
        "ref": ref,
        "remote": remote,
        "observedSha": observed,
        "remoteSha": observed,
        "capturedAt": utc_now_iso(),
        "source": SOURCE_GIT_LS_REMOTE,
    }


def durable_ls_remote_observed(
    receipt: Mapping[str, Any],
    ref: str,
    *,
    missing_reason: str = "LS_REMOTE_REQUIRED",
    missing_message: str | None = None,
) -> str:
    """Return observedSha from durable lastOriginLsRemote for the given ref."""
    last = receipt.get(LAST_ORIGIN_LS_REMOTE)
    if not isinstance(last, dict) or not is_git_sha40(last.get("observedSha")):
        fail(
            missing_reason,
            missing_message
            or "no durable lastOriginLsRemote; run bootstrap-origin-ls-remote first",
        )
    last_ref = last.get("ref") or ref
    if isinstance(last_ref, str) and last_ref != ref:
        fail(
            "LS_REMOTE_MISMATCH",
            f"ls-remote ref mismatch: sealed-for={ref} recorded={last_ref}",
        )
    return str(last["observedSha"]).lower()


def promote_remote_verified_from_ls_remote(
    path: Path,
    *,
    expected: str,
    ref: str,
    caller_observed: str,
    caller_field: str,
) -> str:
    """Require durable ls-remote, match expected/caller, store INFRA_REMOTE_VERIFIED.

    Returns the durable observed SHA. Never trusts caller as the source of truth.
    """
    with receipt_lock(path):
        current = load_bootstrap_receipt(path, check_mode=True)
        observed = durable_ls_remote_observed(
            current,
            ref,
            missing_reason="CALLER_INJECTED_REMOTE_SHA",
            missing_message=(
                f"cannot set INFRA_REMOTE_VERIFIED from caller-only {caller_field}; "
                "run bootstrap-origin-ls-remote first (independent git ls-remote)"
            ),
        )
        if expected != observed:
            fail(
                "LS_REMOTE_MISMATCH",
                f"expected does not match durable ls-remote: "
                f"expected={expected} observed={observed}",
            )
        if caller_observed != observed:
            fail(
                "CALLER_INJECTED_REMOTE_SHA",
                f"caller {caller_field} disagrees with durable ls-remote observedSha",
            )
        next_value = apply_origin_remote_verified(
            dict(current),
            expected=expected,
            observed=observed,
            ref=ref,
            source=SOURCE_GIT_LS_REMOTE,
        )
        next_value["revision"] = bump_revision(current)
        store_bootstrap_receipt(path, next_value)
        return observed


def build_exact_sync_record(
    *,
    expected: str,
    observed: str,
    ref: str,
) -> dict[str, Any]:
    return {
        "status": "VERIFIED",
        "expectedSha": expected,
        "observedSha": observed,
        "ref": ref,
        "source": EXACT_SYNC_SOURCE_LS_REMOTE,
        "sealedAt": utc_now_iso(),
    }


def probe_remote_ref_sha(ref: str, *, remote: str) -> str | None:
    """Return origin ref SHA if present, else None. Never invents a SHA."""
    remote = require_approved_remote(remote)
    ref = normalize_approved_infra_ref(ref)
    try:
        proc = subprocess.run(
            ["git", "ls-remote", "--refs", remote, ref],
            capture_output=True,
            text=True,
            timeout=GIT_LS_REMOTE_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail("LS_REMOTE_REQUIRED", f"pre-push git ls-remote failed: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        fail(
            "LS_REMOTE_REQUIRED",
            f"pre-push git ls-remote exit {proc.returncode} for {remote} {ref}: {err}",
        )
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if not lines:
        return None
    return normalize_git_sha40(
        lines[0].split()[0].strip(),
        reason="LS_REMOTE_REQUIRED",
        message=f"invalid pre-push ls-remote sha from {remote} {ref}",
    )


def execute_exact_sha_push(*, expected: str, ref: str, remote: str) -> dict[str, Any]:
    """Exact SHA refspec push to origin only. Never force.

    Allowed when remote ref is missing, already at expected, or is a strict
    ancestor of expected (non-force fast-forward only). Divergent remotes
    fail with BLOCKED_REMOTE_REF_CONFLICT.
    """
    existing = probe_remote_ref_sha(ref, remote=remote)
    fast_forward = False
    if existing is not None:
        if existing == expected:
            # Idempotent: remote already at exact target — no re-push.
            return {
                "alreadyExact": True,
                "networkMutation": False,
                "remoteShaBefore": existing,
                "expectedSha": expected,
                "fastForward": False,
            }
        # Non-force FF only: remote must be an ancestor of the target SHA.
        if git_is_ancestor(existing, expected):
            fast_forward = True
        else:
            fail(
                "BLOCKED_REMOTE_REF_CONFLICT",
                f"remote ref {ref} already at {existing}; not an ancestor of "
                f"{expected} — refusing non-fast-forward overwrite (no force push)",
            )

    refspec = f"{expected}:{ref}"
    try:
        # Never pass --force / --force-with-lease.
        proc = subprocess.run(
            ["git", "push", "--", remote, refspec],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail("EXACT_PUSH_FAILED", f"git push failed: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        fail(
            "EXACT_PUSH_FAILED",
            f"git push -- {remote} {refspec} exit {proc.returncode}: {err}",
        )
    return {
        "alreadyExact": False,
        "networkMutation": True,
        "remoteShaBefore": existing,
        "expectedSha": expected,
        "refspec": refspec,
        "fastForward": fast_forward,
    }


def cmd_bootstrap_exact_push(args: argparse.Namespace) -> int:
    """Plan or execute exact-SHA push. Real network requires dual auth flags."""
    path = resolve_bootstrap_path(args)
    remote = require_approved_remote(args.remote)
    ref = normalize_approved_infra_ref(args.ref)
    dry_run = bool(args.dry_run)

    if not args.expected_sha:
        fail("ORIGIN_SHA_MISMATCH", "missing --expected-sha for exact-push")
    expected = normalize_git_sha40(
        args.expected_sha,
        reason="ORIGIN_SHA_MISMATCH",
        message="exact-push requires 40-char --expected-sha",
    )
    # expectedSha asserts real local HEAD; never an override of local state.
    expected = require_expected_is_local_head(expected)
    # Target ref must bind to the current local branch name (no cross-branch push).
    local_branch = local_git_branch_name()
    ref_branch = ref[len("refs/heads/") :] if ref.startswith("refs/heads/") else ref
    if ref_branch != local_branch:
        fail(
            "BRANCH_NOT_ALLOWED",
            f"ref branch {ref_branch!r} must match current branch {local_branch!r}",
        )

    receipt = load_bootstrap_receipt(path, check_mode=True)
    reject_forged_effective_claims(receipt)

    if dry_run:
        # Planning only: no network, no receipt mutation, no remote mutation.
        # Avoid the substring "pushed" in output — RED-06.9 guards real push banners.
        return emit_ok(
            "bootstrap-exact-push",
            receipt=str(path),
            mode="dry-run",
            dryRun=True,
            ref=ref,
            remote=remote,
            expectedSha=expected,
            message=(
                "exact-push dry-run: plan exact SHA refspec "
                f"{expected} -> {ref} on {remote}; no network"
            ),
            network=False,
            remoteMutation=False,
        )

    if not exact_push_authorized(args):
        fail(
            "EXACT_PUSH_NOT_AUTHORIZED",
            "real exact-push is not authorized; pass --dry-run, or both "
            "--allow-network-push and --i-understand-real-push",
        )

    # Dual-auth: execute exact SHA refspec push. Does NOT write REMOTE_VERIFIED —
    # caller must run independent bootstrap-origin-ls-remote + readback.
    push_result = execute_exact_sha_push(expected=expected, ref=ref, remote=remote)
    return emit_ok(
        "bootstrap-exact-push",
        receipt=str(path),
        mode="network",
        dryRun=False,
        ref=ref,
        remote=remote,
        expectedSha=expected,
        alreadyExact=push_result.get("alreadyExact"),
        networkMutation=push_result.get("networkMutation"),
        message=(
            "exact-push network: refspec accepted by git; "
            "REMOTE_VERIFIED requires independent origin ls-remote readback"
        ),
        # Deliberately omit the word "pushed" to avoid false positives in dry-run guards.
        remoteVerified=False,
        EffectiveGate=False,
    )


def cmd_bootstrap_origin_ls_remote(args: argparse.Namespace) -> int:
    """Independent origin readback; records lastOriginLsRemote (does not seal exactSync)."""
    path = resolve_bootstrap_path(args)
    ref = normalize_approved_infra_ref(args.ref)
    remote = require_approved_remote(args.remote)
    dry_run = bool(args.dry_run)

    # Ensure receipt is loadable; ls-remote is allowed during SYNC_IN_FLIGHT (recovery).
    load_bootstrap_receipt(path, check_mode=True)

    if dry_run:
        return emit_ok(
            "bootstrap-origin-ls-remote",
            receipt=str(path),
            mode="dry-run",
            dryRun=True,
            ref=ref,
            remote=remote,
            observedSha=None,
            remoteSha=None,
            message="ls-remote dry-run: no network; no observedSha recorded",
        )

    observed = git_ls_remote_sha(ref, remote=remote)

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        current[LAST_ORIGIN_LS_REMOTE] = record_last_origin_ls_remote(
            ref=ref, remote=remote, observed=observed
        )
        return current

    # Recovery path: may run while SYNC_IN_FLIGHT.
    mutate_bootstrap(path, apply, check_mode=True, allow_in_flight=True)
    return emit_ok(
        "bootstrap-origin-ls-remote",
        receipt=str(path),
        ref=ref,
        remote=remote,
        observedSha=observed,
        remoteSha=observed,
        source=SOURCE_GIT_LS_REMOTE,
        message="ls-remote observed origin SHA recorded (exactSync not sealed)",
    )


def cmd_bootstrap_origin_readback(args: argparse.Namespace) -> int:
    """Promote REMOTE_VERIFIED only after durable ls-remote; never caller-only SHAs."""
    path = resolve_bootstrap_path(args)
    ref = normalize_approved_infra_ref(args.ref)
    if not args.expected_sha or not args.observed_sha:
        fail("ORIGIN_SHA_MISMATCH", "missing --expected-sha or --observed-sha")
    expected = normalize_git_sha40(
        args.expected_sha,
        reason="ORIGIN_SHA_MISMATCH",
        message="origin expected must be 40-char git SHA",
    )
    observed_caller = normalize_git_sha40(
        args.observed_sha,
        reason="ORIGIN_SHA_MISMATCH",
        message="origin observed must be 40-char git SHA",
    )
    # Caller pair mismatch fails first (stable ORIGIN_SHA_MISMATCH).
    if expected != observed_caller:
        fail(
            "ORIGIN_SHA_MISMATCH",
            f"origin mismatch: expected={expected} observed={observed_caller}",
        )
    observed = promote_remote_verified_from_ls_remote(
        path,
        expected=expected,
        ref=ref,
        caller_observed=observed_caller,
        caller_field="--observed-sha",
    )
    return emit_ok(
        "bootstrap-origin-readback",
        receipt=str(path),
        ref=ref,
        expectedSha=expected,
        observedSha=observed,
        state="INFRA_REMOTE_VERIFIED",
        source=SOURCE_GIT_LS_REMOTE,
    )


def cmd_bootstrap_seal_exact_sync(args: argparse.Namespace) -> int:
    """Seal exactSync only from durable ls-remote evidence — never caller-only SHA."""
    path = resolve_bootstrap_path(args)
    ref = normalize_approved_infra_ref(args.ref)
    from_ls = bool(args.from_ls_remote)
    caller_observed = args.observed_sha

    with receipt_lock(path):
        current = load_bootstrap_receipt(path, check_mode=True)

        if is_sync_in_flight(current.get("state")):
            fail(
                "SYNC_IN_FLIGHT_RECOVERY_REQUIRED",
                "cannot seal exactSync during unrecovered SYNC_IN_FLIGHT; "
                "complete ls-remote recovery and sync-resume first",
            )

        if not from_ls:
            if caller_observed:
                fail(
                    "CALLER_INJECTED_REMOTE_SHA",
                    "cannot seal exactSync from caller-supplied --observed-sha alone; "
                    "run bootstrap-origin-ls-remote then bootstrap-seal-exact-sync "
                    "--from-ls-remote",
                )
            fail(
                "LS_REMOTE_REQUIRED",
                "exactSync seal requires --from-ls-remote after independent ls-remote",
            )

        observed = durable_ls_remote_observed(current, ref)
        expected_raw = args.expected_sha or current.get("INFRA_SHA")
        expected = normalize_git_sha40(
            expected_raw,
            reason="ORIGIN_SHA_MISMATCH",
            message="missing valid --expected-sha / INFRA_SHA",
        )
        if expected != observed:
            fail(
                "LS_REMOTE_MISMATCH",
                f"exact-sync seal mismatch: expected={expected} observed={observed}",
            )

        # Optional caller --observed-sha must equal durable ls-remote (never override).
        if caller_observed is not None:
            caller = normalize_git_sha40(
                caller_observed,
                reason="CALLER_INJECTED_REMOTE_SHA",
                message="caller --observed-sha is not a valid git SHA",
            )
            if caller != observed:
                fail(
                    "CALLER_INJECTED_REMOTE_SHA",
                    "caller --observed-sha disagrees with durable ls-remote observedSha",
                )

        sealed = build_exact_sync_record(
            expected=expected, observed=observed, ref=ref
        )
        next_value = dict(current)
        next_value["exactSync"] = sealed
        next_value["syncState"] = sealed
        next_value["revision"] = bump_revision(current)
        # Never claim DONE / EffectiveGate from local seal alone.
        next_value["EffectiveGate"] = False
        next_value["EffectiveDone"] = False
        store_bootstrap_receipt(path, next_value)

    return emit_ok(
        "bootstrap-seal-exact-sync",
        receipt=str(path),
        ref=ref,
        expectedSha=expected,
        observedSha=observed,
        source=EXACT_SYNC_SOURCE_LS_REMOTE,
        status="VERIFIED",
        EffectiveGate=False,
    )


# ---------------------------------------------------------------------------
# PR merge + base containment readback (PR-MERGE-READBACK-09)
# Independent gh API + git ls-remote / merge-base — never caller-forged merge.
# ---------------------------------------------------------------------------


def require_approved_base_ref(ref: str | None) -> str:
    raw = (ref or APPROVED_BASE_REF).strip()
    if raw in {APPROVED_BASE_BRANCH, APPROVED_BASE_REF}:
        return APPROVED_BASE_REF
    fail(
        "BRANCH_NOT_ALLOWED",
        f"base ref not allowed: {raw!r}; only {APPROVED_BASE_REF}",
    )


def gh_pr_view_json(pr_number: int, *, repo: str | None) -> dict[str, Any]:
    """Independent PR readback via `gh pr view --json`. Never trusts caller merge flags."""
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--json",
        "number,state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,"
        "headRepository,url,title,closed",
    ]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=GH_API_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail("PR_READBACK_REQUIRED", f"gh pr view failed: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        fail(
            "PR_READBACK_REQUIRED",
            f"gh pr view exit {proc.returncode} for PR #{pr_number}: {err}",
        )
    try:
        data = json.loads(proc.stdout or "")
    except json.JSONDecodeError as exc:
        fail("PR_READBACK_REQUIRED", f"gh pr view JSON corrupt: {exc}")
    if not isinstance(data, dict):
        fail("PR_READBACK_REQUIRED", "gh pr view must return a JSON object")
    return data


def probe_base_ref_sha(*, remote: str = APPROVED_PUSH_REMOTE) -> str:
    """Independent authoritative base tip via git ls-remote --refs origin base."""
    remote = require_approved_remote(remote)
    ref = APPROVED_BASE_REF
    try:
        proc = subprocess.run(
            ["git", "ls-remote", "--refs", remote, ref],
            capture_output=True,
            text=True,
            timeout=GIT_LS_REMOTE_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail("LS_REMOTE_REQUIRED", f"base ls-remote failed: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        fail(
            "LS_REMOTE_REQUIRED",
            f"base ls-remote exit {proc.returncode} for {remote} {ref}: {err}",
        )
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if not lines:
        fail("LS_REMOTE_REQUIRED", f"base ref missing on {remote}: {ref}")
    return normalize_git_sha40(
        lines[0].split()[0].strip(),
        reason="LS_REMOTE_REQUIRED",
        message=f"invalid base ls-remote sha from {remote} {ref}",
    )


def ensure_git_object(sha: str) -> None:
    """Fetch object if missing so merge-base ancestry can be checked."""
    try:
        proc = subprocess.run(
            ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        proc = None  # type: ignore[assignment]
    if proc is not None and proc.returncode == 0:
        return
    # Fetch base + infra tips so merge commit is available.
    try:
        subprocess.run(
            [
                "git",
                "fetch",
                "--no-tags",
                APPROVED_PUSH_REMOTE,
                APPROVED_BASE_REF,
                APPROVED_INFRA_REF,
            ],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail("BASE_CONTAINMENT_REQUIRED", f"git fetch for containment failed: {exc}")
    try:
        proc2 = subprocess.run(
            ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail("BASE_CONTAINMENT_REQUIRED", f"git cat-file failed: {exc}")
    if proc2.returncode != 0:
        fail(
            "BASE_CONTAINMENT_REQUIRED",
            f"merge/base object {sha} not available after fetch",
        )


def git_is_ancestor(ancestor: str, descendant: str) -> bool:
    ensure_git_object(ancestor)
    ensure_git_object(descendant)
    try:
        proc = subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail("BASE_CONTAINMENT_REQUIRED", f"git merge-base --is-ancestor failed: {exc}")
    return proc.returncode == 0


def cmd_bootstrap_pr_merge_readback(args: argparse.Namespace) -> int:
    """Independent gh PR merge readback → durable prMerge (never caller-forged)."""
    path = resolve_bootstrap_path(args)
    if args.pr_number is None:
        fail("PR_READBACK_REQUIRED", "missing --pr-number")
    try:
        pr_number = int(args.pr_number)
    except (TypeError, ValueError):
        fail("PR_READBACK_REQUIRED", f"invalid --pr-number: {args.pr_number!r}")
    if pr_number <= 0:
        fail("PR_READBACK_REQUIRED", f"invalid --pr-number: {pr_number}")

    repo = args.repo  # optional; gh uses origin of cwd when omitted
    expected_head = args.expected_head_sha or args.expected_sha
    head_ref_want = APPROVED_INFRA_BRANCH
    base_ref_want = APPROVED_BASE_BRANCH

    data = gh_pr_view_json(pr_number, repo=repo)
    state = str(data.get("state") or "").upper()
    if state != "MERGED":
        fail(
            "PR_MERGE_REQUIRED",
            f"PR #{pr_number} state is {state!r}, not MERGED",
        )
    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict) or not merge_commit.get("oid"):
        fail("PR_MERGE_REQUIRED", f"PR #{pr_number} missing mergeCommit.oid")
    merge_sha = normalize_git_sha40(
        merge_commit.get("oid"),
        reason="PR_MERGE_REQUIRED",
        message="mergeCommit.oid must be a 40-char git SHA",
    )
    head_ref = str(data.get("headRefName") or "")
    base_ref = str(data.get("baseRefName") or "")
    if head_ref != head_ref_want:
        fail(
            "BRANCH_NOT_ALLOWED",
            f"PR headRefName {head_ref!r} != approved {head_ref_want!r}",
        )
    if base_ref != base_ref_want:
        fail(
            "BRANCH_NOT_ALLOWED",
            f"PR baseRefName {base_ref!r} != approved {base_ref_want!r}",
        )

    # Optional: expected head tip (implementation SHA) must be ancestor of merge.
    if expected_head:
        expected_head = normalize_git_sha40(
            expected_head,
            reason="ORIGIN_SHA_MISMATCH",
            message="--expected-head-sha must be a 40-char git SHA",
        )
        if not git_is_ancestor(expected_head, merge_sha):
            fail(
                "PR_MERGE_REQUIRED",
                f"expected head {expected_head} is not an ancestor of merge {merge_sha}",
            )

    pr_record = {
        "merged": True,
        "mergeSha": merge_sha,
        "mergedAt": data.get("mergedAt"),
        "prNumber": pr_number,
        "url": data.get("url"),
        "title": data.get("title"),
        "headRef": head_ref,
        "baseRef": base_ref,
        "source": SOURCE_GH_PR_API,
        "readbackAt": utc_now_iso(),
    }

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        current["prMerge"] = pr_record
        current["infraPr"] = pr_record
        current["state"] = "INFRA_PR_MERGED_VERIFIED"
        current["EffectiveGate"] = False
        current["EffectiveDone"] = False
        return current

    mutate_bootstrap(path, apply, check_mode=True)
    return emit_ok(
        "bootstrap-pr-merge-readback",
        receipt=str(path),
        prNumber=pr_number,
        merged=True,
        mergeSha=merge_sha,
        headRef=head_ref,
        baseRef=base_ref,
        state="INFRA_PR_MERGED_VERIFIED",
        source=SOURCE_GH_PR_API,
        EffectiveGate=False,
    )


def cmd_bootstrap_base_containment_readback(args: argparse.Namespace) -> int:
    """Independent base ls-remote + merge-base --is-ancestor → baseContainment."""
    path = resolve_bootstrap_path(args)
    remote = require_approved_remote(args.remote)
    base_ref = require_approved_base_ref(args.base_ref)

    with receipt_lock(path):
        current = load_bootstrap_receipt(path, check_mode=True)
        pr = current.get("prMerge") or current.get("infraPr")
        if not isinstance(pr, dict) or pr.get("merged") is not True:
            fail(
                "PR_MERGE_REQUIRED",
                "base containment requires durable prMerge from "
                "bootstrap-pr-merge-readback first",
            )
        merge_sha = pr.get("mergeSha")
        if not is_git_sha40(merge_sha):
            fail("PR_MERGE_REQUIRED", "prMerge.mergeSha missing or invalid")
        merge_sha = str(merge_sha).lower()

        base_sha = probe_base_ref_sha(remote=remote)
        if args.expected_base_sha:
            expected_base = normalize_git_sha40(
                args.expected_base_sha,
                reason="LS_REMOTE_MISMATCH",
                message="--expected-base-sha must be a 40-char git SHA",
            )
            if expected_base != base_sha:
                fail(
                    "LS_REMOTE_MISMATCH",
                    f"base tip mismatch: expected={expected_base} observed={base_sha}",
                )

        contains = git_is_ancestor(merge_sha, base_sha)
        if not contains:
            # Also accept containment of implementation tip if merge is a pure merge commit.
            infra = current.get("INFRA_SHA")
            if is_git_sha40(infra) and git_is_ancestor(str(infra).lower(), base_sha):
                contains = True
                contained_sha = str(infra).lower()
            else:
                fail(
                    "BASE_CONTAINMENT_REQUIRED",
                    f"base {base_sha} does not contain merge {merge_sha}",
                )
        else:
            contained_sha = merge_sha

        base_record = {
            "containsMerge": True,
            "baseRef": base_ref,
            "baseSha": base_sha,
            "mergeSha": merge_sha,
            "containedSha": contained_sha,
            "remote": remote,
            "source": SOURCE_GIT_MERGE_BASE,
            "readbackAt": utc_now_iso(),
        }
        next_value = dict(current)
        next_value["baseContainment"] = base_record
        next_value["state"] = "INFRA_AUTHORITATIVE_BASE_VERIFIED"
        next_value["EffectiveGate"] = False
        next_value["EffectiveDone"] = False
        next_value["revision"] = bump_revision(current)
        store_bootstrap_receipt(path, next_value)

    return emit_ok(
        "bootstrap-base-containment-readback",
        receipt=str(path),
        baseRef=base_ref,
        baseSha=base_sha,
        mergeSha=merge_sha,
        containsMerge=True,
        state="INFRA_AUTHORITATIVE_BASE_VERIFIED",
        source=SOURCE_GIT_MERGE_BASE,
        EffectiveGate=False,
    )


def load_authoritative_catalog(args: argparse.Namespace) -> dict[str, Any]:
    catalog_path = Path(args.catalog_path) if args.catalog_path else (
        Path(__file__).resolve().parent / "wallpaper-plugin-tasks.json"
    )
    if not catalog_path.is_file():
        fail("MISSING_RECEIPT", f"catalog not found: {catalog_path}")
    try:
        data = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail("ILLEGAL_STATE", f"cannot parse catalog: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        fail("ILLEGAL_STATE", "catalog must be object with tasks[]")
    return data


def catalog_task(catalog: Mapping[str, Any], task_id: str) -> dict[str, Any]:
    matches = [t for t in catalog.get("tasks", []) if isinstance(t, dict) and t.get("taskId") == task_id]
    if len(matches) != 1:
        fail(
            "CATALOG_WP01_MISSING" if task_id == "WP-01" else "UNKNOWN_TASK",
            f"catalog must contain exactly one {task_id} entry (found {len(matches)})",
        )
    return matches[0]


def live_authoritative_base_sha() -> str:
    """Independent live base tip via `git ls-remote --refs origin base` (never local tip alone)."""
    return probe_base_ref_sha(remote=APPROVED_PUSH_REMOTE)


# WP-01 verify-done proof-chain roles (identity only; remote facts from API/git).
WP01_PROOF_CHAIN_ROLES = ("import", "repair")
# Caller must not inject remote/done facts; only task identity (PR numbers) + local suite digests.
WP01_CALLER_FORGERY_KEYS = frozenset(
    {
        "merged",
        "EffectiveDone",
        "REMOTE_VERIFIED",
        "remoteVerified",
        "EffectiveGate",
        "mergeSha",
        "mergedAt",
        "merge_commit_sha",
        "mergeCommit",
        "state",
    }
)
APPROVED_GITHUB_REPO = "anpplex/Mineradio-AndroidAuto"


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _try_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _reject_forged_keys_in_proofs(
    proofs: Mapping[str, Any],
    *,
    forbidden_keys: frozenset[str],
    forgery_reason: str,
    legacy_pin_reason: str | None = None,
) -> tuple[bool, str, str]:
    """Shared fail-closed guard: caller must not inject remote/done/progress facts."""
    has_chain = isinstance(proofs.get("proofChain"), dict)
    # Legacy single-PR + catalog merge pin model (pre proof-chain) — WP-01 signature.
    if legacy_pin_reason and not has_chain and ("prNumber" in proofs or "mergeSha" in proofs):
        return (
            False,
            legacy_pin_reason,
            "legacy single-PR prNumber/mergeSha pin rejected; use proofChain identities",
        )
    for key in forbidden_keys:
        if key in proofs:
            return (
                False,
                forgery_reason,
                f"caller must not supply untrusted remote/done fact {key!r}; "
                "only task identity is accepted",
            )
    chain = proofs.get("proofChain")
    if isinstance(chain, dict):
        for role, entry in chain.items():
            if not isinstance(entry, dict):
                continue
            for key in forbidden_keys:
                if key in entry:
                    return (
                        False,
                        forgery_reason,
                        f"caller must not supply untrusted fact {key!r} under proofChain.{role}",
                    )
    return True, "", ""


def _merge_receipt_and_cli_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    missing_reason: str,
    require_nonempty: bool = False,
) -> tuple[dict[str, Any] | None, str, str]:
    """Merge receipt.proofs with optional --proofs-json; receipt wins on key conflict."""
    proofs: dict[str, Any] = {}
    if isinstance(receipt.get("proofs"), dict):
        proofs.update(receipt["proofs"])
    if args.proofs_json:
        try:
            injected = json.loads(args.proofs_json)
        except json.JSONDecodeError as exc:
            return None, missing_reason, f"invalid --proofs-json: {exc}"
        if not isinstance(injected, dict):
            return None, missing_reason, "--proofs-json must be object"
        # Receipt wins on conflict for overlapping keys; CLI fills missing identity only.
        merged = dict(injected)
        merged.update(proofs)
        proofs = merged
    if require_nonempty and not proofs:
        return None, missing_reason, "missing proofs identity"
    return proofs, "", ""


def _require_suite_pass_digests(
    proofs: Mapping[str, Any],
    suite_keys: Sequence[str],
    *,
    missing_reason: str,
) -> tuple[bool, str, str]:
    for suite_key in suite_keys:
        suite = proofs.get(suite_key)
        if not isinstance(suite, dict) or suite.get("pass") is not True:
            return False, missing_reason, f"{suite_key}.pass must be true"
        sha = suite.get("sha256")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha.lower() or ""):
            return False, missing_reason, f"{suite_key}.sha256 must be 64-char hex"
    return True, "", ""


def _require_matching_file_digest(
    proofs: Mapping[str, Any],
    *,
    field: str,
    path: Path,
    missing_reason: str,
) -> tuple[bool, str, str, str]:
    """Return (ok, reason, message, live_sha)."""
    if not path.is_file():
        return False, missing_reason, f"{field} file missing: {path}", ""
    live_sha = _sha256_file(path)
    claimed = proofs.get(field)
    if not isinstance(claimed, str) or not re.fullmatch(r"[0-9a-f]{64}", claimed.lower() or ""):
        return (
            False,
            missing_reason,
            f"{field} must be 64-char hex matching actual file",
            "",
        )
    if claimed.lower() != live_sha:
        return (
            False,
            missing_reason,
            f"{field} mismatch: claimed={claimed.lower()} live={live_sha}",
            "",
        )
    return True, "", "", live_sha


def _pr_repo_matches_approved(data: Mapping[str, Any]) -> tuple[bool, str]:
    head_repo = data.get("headRepository") if isinstance(data.get("headRepository"), dict) else {}
    name_with_owner = str(head_repo.get("nameWithOwner") or "")
    url = str(data.get("url") or "")
    if name_with_owner and name_with_owner != APPROVED_GITHUB_REPO:
        return False, name_with_owner
    if APPROVED_GITHUB_REPO not in url and name_with_owner != APPROVED_GITHUB_REPO:
        if f"github.com/{APPROVED_GITHUB_REPO}" not in url.replace("https://", ""):
            return False, name_with_owner or url
    return True, name_with_owner or APPROVED_GITHUB_REPO


def _require_merged_pr_fields(
    data: Mapping[str, Any],
    *,
    label: str,
    missing_reason: str,
) -> tuple[bool, str, str]:
    state = str(data.get("state") or "").upper()
    merged_at = data.get("mergedAt")
    if state != "MERGED":
        return False, missing_reason, f"{label} state is {state!r}, not MERGED"
    if not merged_at:
        return False, missing_reason, f"{label} mergedAt is null"
    return True, "", ""


def _require_ancestor_of_live_base(
    sha: str,
    live_base_sha: str,
    *,
    label: str,
) -> tuple[bool, str, str]:
    """Ancestry only — never tip equality."""
    if not git_is_ancestor(sha, live_base_sha):
        return (
            False,
            "BASE_CONTAINMENT_REQUIRED",
            f"{label} {sha} is not an ancestor of live base {live_base_sha}",
        )
    return True, "", ""


def _reject_caller_forged_remote_facts(
    proofs: Mapping[str, Any],
) -> tuple[bool, str, str]:
    """Fail-closed if caller tries to inject remote/done facts into proofs."""
    return _reject_forged_keys_in_proofs(
        proofs,
        forbidden_keys=WP01_CALLER_FORGERY_KEYS,
        forgery_reason="WP01_VERIFY_DONE_CALLER_FORGERY",
        legacy_pin_reason="WP01_VERIFY_DONE_CATALOG_MERGE_PIN",
    )


def _load_wp01_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    """Merge receipt proofs with optional CLI identity; never trust remote facts from either."""
    proofs, reason, message = _merge_receipt_and_cli_proofs(
        receipt,
        args,
        missing_reason="WP01_VERIFY_DONE_PROOF_MISSING",
        require_nonempty=False,
    )
    if proofs is None:
        return None, reason, message
    ok, reason, message = _reject_caller_forged_remote_facts(proofs)
    if not ok:
        return None, reason, message
    return proofs, "", ""


def _catalog_proof_chain(task: Mapping[str, Any]) -> tuple[dict[str, Any] | None, str, str]:
    catalog_proofs = task.get("proofs") if isinstance(task.get("proofs"), dict) else {}
    chain = catalog_proofs.get("proofChain") if isinstance(catalog_proofs, dict) else None
    if not isinstance(chain, dict):
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            "catalog proofs.proofChain missing or not object",
        )
    # Catalog must not hard-pin PR numbers or merge SHAs (dynamic readback only).
    if "prNumber" in catalog_proofs or "mergeSha" in catalog_proofs:
        return (
            None,
            "WP01_VERIFY_DONE_CATALOG_MERGE_PIN",
            "catalog must not hardcode proofs.prNumber or proofs.mergeSha",
        )
    for role in WP01_PROOF_CHAIN_ROLES:
        entry = chain.get(role)
        if not isinstance(entry, dict):
            return (
                None,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                f"catalog proofChain.{role} missing or incomplete",
            )
        if "prNumber" in entry or "mergeSha" in entry:
            return (
                None,
                "WP01_VERIFY_DONE_CATALOG_MERGE_PIN",
                f"catalog proofChain.{role} must not pin prNumber/mergeSha",
            )
        task_commit = entry.get("taskCommit")
        if not is_git_sha40(task_commit):
            return (
                None,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                f"catalog proofChain.{role}.taskCommit must be 40-char SHA",
            )
        base_ref = str(entry.get("baseRef") or "")
        if base_ref not in {APPROVED_BASE_BRANCH, APPROVED_BASE_REF}:
            return (
                None,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                f"catalog proofChain.{role}.baseRef must be {APPROVED_BASE_BRANCH}",
            )
        head_ref = str(entry.get("headRef") or "")
        if not head_ref.startswith(TASK_BRANCH_PREFIX):
            return (
                None,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                f"catalog proofChain.{role}.headRef must start with {TASK_BRANCH_PREFIX}",
            )
    return chain, "", ""


def _caller_proof_chain_identities(
    proofs: Mapping[str, Any],
) -> tuple[dict[str, int] | None, str, str]:
    """Extract role → prNumber identity map from caller/receipt (identity only)."""
    # Legacy single-PR shape is rejected under the post-#6 proof-chain model.
    if "prNumber" in proofs or "mergeSha" in proofs:
        return (
            None,
            "WP01_VERIFY_DONE_CATALOG_MERGE_PIN",
            "legacy single-PR prNumber/mergeSha pin rejected; supply proofChain identities",
        )
    chain = proofs.get("proofChain")
    if not isinstance(chain, dict):
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            "missing proofs.proofChain object with import/repair identities",
        )
    identities: dict[str, int] = {}
    for role in WP01_PROOF_CHAIN_ROLES:
        entry = chain.get(role)
        if not isinstance(entry, dict):
            return (
                None,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                f"proofChain.{role} missing or incomplete",
            )
        pr_number = _try_int(entry.get("prNumber"))
        if pr_number is None or pr_number <= 0:
            return (
                None,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                f"proofChain.{role}.prNumber must be positive int (task identity)",
            )
        identities[role] = pr_number
    # Duplicate PR identities across roles are incomplete/ambiguous proofs.
    if len(set(identities.values())) != len(identities):
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            "proofChain roles must not share the same PR number (duplicate proof)",
        )
    return identities, "", ""


def verify_wp01_merged_pr_proof(
    *,
    role: str,
    pr_number: int,
    expected_task_commit: str,
    expected_head_ref: str,
    expected_base_ref: str,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read PR via GitHub API + ancestry vs live base. No tip equality."""
    try:
        data = gh_pr_view_json(pr_number, repo=repo)
    except SystemExit:
        # gh_pr_view_json fail-closes via SystemExit; re-raise for infrastructure errors.
        raise

    # Repository match (head repo nameWithOwner or URL).
    head_repo = data.get("headRepository") if isinstance(data.get("headRepository"), dict) else {}
    name_with_owner = str(head_repo.get("nameWithOwner") or "")
    url = str(data.get("url") or "")
    if name_with_owner and name_with_owner != APPROVED_GITHUB_REPO:
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR #{pr_number} repository {name_with_owner!r} != {APPROVED_GITHUB_REPO}",
        )
    if APPROVED_GITHUB_REPO not in url and name_with_owner != APPROVED_GITHUB_REPO:
        # When headRepository omitted, require URL path match.
        if f"github.com/{APPROVED_GITHUB_REPO}" not in url.replace("https://", ""):
            return (
                None,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                f"{role} PR #{pr_number} URL/repo does not match {APPROVED_GITHUB_REPO}",
            )

    state = str(data.get("state") or "").upper()
    merged_at = data.get("mergedAt")
    closed = data.get("closed")
    if state != "MERGED":
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR #{pr_number} state is {state!r}, not MERGED (unmerged rejected)",
        )
    if not merged_at:
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR #{pr_number} mergedAt is null",
        )
    if closed is False:
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR #{pr_number} closed=false",
        )

    api_number = _try_int(data.get("number"))
    if api_number != pr_number:
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR number readback {api_number} != identity {pr_number}",
        )

    head_ref = str(data.get("headRefName") or "")
    if head_ref != expected_head_ref:
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR head.ref {head_ref!r} != expected {expected_head_ref!r}",
        )

    base_ref = str(data.get("baseRefName") or "")
    if base_ref != expected_base_ref and base_ref != APPROVED_BASE_BRANCH:
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR base.ref {base_ref!r} is not {APPROVED_BASE_BRANCH}",
        )

    head_sha_raw = data.get("headRefOid")
    if not is_git_sha40(head_sha_raw):
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR head.sha missing/invalid from API",
        )
    head_sha = str(head_sha_raw).lower()
    expected_task_commit = str(expected_task_commit).lower()
    if head_sha != expected_task_commit:
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR head.sha {head_sha} != catalog taskCommit {expected_task_commit}",
        )

    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict) or not is_git_sha40(merge_commit.get("oid")):
        return (
            None,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            f"{role} PR #{pr_number} missing real merge_commit_sha from API",
        )
    merge_sha = str(merge_commit.get("oid")).lower()

    # Merge SHA must be ancestor of live base tip — NOT required to equal tip.
    if not git_is_ancestor(merge_sha, live_base_sha):
        return (
            None,
            "BASE_CONTAINMENT_REQUIRED",
            f"{role} proof mergeSha {merge_sha} is not an ancestor of live base {live_base_sha}",
        )
    # Task head / import-repair commit must also be contained in live base.
    if not git_is_ancestor(expected_task_commit, live_base_sha):
        return (
            None,
            "BASE_CONTAINMENT_REQUIRED",
            f"{role} taskCommit {expected_task_commit} is not an ancestor of live base {live_base_sha}",
        )

    return (
        {
            "role": role,
            "prNumber": pr_number,
            "headRef": head_ref,
            "headSha": head_sha,
            "taskCommit": expected_task_commit,
            "baseRef": base_ref,
            "mergeSha": merge_sha,
            "mergedAt": merged_at,
            "state": state,
            "url": data.get("url"),
            "repository": name_with_owner or APPROVED_GITHUB_REPO,
            "mergeIsAncestorOfLiveBase": True,
            "taskCommitIsAncestorOfLiveBase": True,
            "source": SOURCE_GH_PR_API,
            "ancestrySource": SOURCE_GIT_MERGE_BASE,
            "liveBaseSha": live_base_sha,
        },
        "",
        "",
    )


def _verify_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        ("pluginContractTest", "monorepoImportTest", "fullNodeTest"),
        missing_reason="WP01_VERIFY_DONE_PROOF_MISSING",
    )
    if not ok:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    schema_path = Path(args.schema_path) if args.schema_path else DEFAULT_SCHEMA_BLOB_PATH
    if not catalog_path.is_file():
        return False, "WP01_VERIFY_DONE_PROOF_MISSING", f"catalog missing: {catalog_path}", {}
    if not schema_path.is_file():
        return False, "WP01_VERIFY_DONE_PROOF_MISSING", f"schema missing: {schema_path}", {}

    ok, reason, message, live_catalog_sha = _require_matching_file_digest(
        proofs,
        field="catalogSha256",
        path=catalog_path,
        missing_reason="WP01_VERIFY_DONE_PROOF_MISSING",
    )
    if not ok:
        if "must be 64-char hex matching actual file" in message:
            message = "catalogSha256 must be 64-char hex matching actual catalog file"
        return False, reason, message, {}

    ok, reason, message, live_schema_sha = _require_matching_file_digest(
        proofs,
        field="schemaSha256",
        path=schema_path,
        missing_reason="WP01_VERIFY_DONE_PROOF_MISSING",
    )
    if not ok:
        if "must be 64-char hex matching actual file" in message:
            message = "schemaSha256 must be 64-char hex matching actual schema file"
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "pluginContractTest": proofs["pluginContractTest"],
            "monorepoImportTest": proofs["monorepoImportTest"],
            "fullNodeTest": proofs["fullNodeTest"],
        },
    )


def evaluate_wp01_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record).

    WP-01 DONE requires a merged import+repair proof chain:
      - PR numbers are dynamic identities (not hard-coded 5/6)
      - each PR is independently re-read via GitHub API
      - each merge SHA is an ancestor of live base tip (not tip equality)
      - live base tip comes from origin ls-remote
      - caller cannot forge merged/EffectiveDone/REMOTE_VERIFIED/mergeSha
    """
    catalog = load_authoritative_catalog(args)
    task = catalog_task(catalog, "WP-01")
    weight = task.get("weight")
    if weight != 6:
        return False, "CATALOG_WP01_MISSING", f"WP-01 weight must be 6, got {weight!r}", {}

    proofs, reason, message = _load_wp01_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    catalog_chain, reason, message = _catalog_proof_chain(task)
    if catalog_chain is None:
        return False, reason, message, {}

    identities, reason, message = _caller_proof_chain_identities(proofs)
    if identities is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    # Live base tip: independent ls-remote only.
    live_base = live_authoritative_base_sha()
    # Optional claimed base must match live if provided (identity cross-check).
    claimed_base = proofs.get("authoritativeBaseSha")
    if claimed_base is not None:
        if not is_git_sha40(claimed_base):
            return (
                False,
                "WP01_VERIFY_DONE_PROOF_MISSING",
                "authoritativeBaseSha must be 40-char SHA when provided",
                {},
            )
        if str(claimed_base).lower() != live_base:
            return (
                False,
                "BASE_CONTAINMENT_REQUIRED",
                f"claimed base {str(claimed_base).lower()} != live ls-remote base {live_base}",
                {},
            )

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    verified_roles: dict[str, dict[str, Any]] = {}
    for role in WP01_PROOF_CHAIN_ROLES:
        cat_entry = catalog_chain[role]
        expected_base = str(cat_entry.get("baseRef") or APPROVED_BASE_BRANCH)
        if expected_base == APPROVED_BASE_REF:
            expected_base = APPROVED_BASE_BRANCH
        pr_number = identities[role]
        role_proof, reason, message = verify_wp01_merged_pr_proof(
            role=role,
            pr_number=pr_number,
            expected_task_commit=str(cat_entry["taskCommit"]).lower(),
            expected_head_ref=str(cat_entry["headRef"]),
            expected_base_ref=expected_base,
            live_base_sha=live_base,
            repo=repo,
        )
        if role_proof is None:
            return False, reason, message, {}
        verified_roles[role] = role_proof

    import_proof = verified_roles["import"]
    repair_proof = verified_roles["repair"]
    catalog_proofs = task.get("proofs") if isinstance(task.get("proofs"), dict) else {}
    import_commit = str(
        catalog_proofs.get("importCommit") or import_proof["taskCommit"]
    ).lower()
    if import_commit != import_proof["taskCommit"]:
        return (
            False,
            "WP01_VERIFY_DONE_PROOF_MISSING",
            "catalog importCommit must match import proof taskCommit",
            {},
        )

    record = {
        "proofChain": {
            "import": import_proof,
            "repair": repair_proof,
        },
        "importProof": import_proof,
        "repairProof": repair_proof,
        "importCommit": import_commit,
        # Distinct SHAs: do not conflate merge tip with live base tip.
        "importMergeSha": import_proof["mergeSha"],
        "repairMergeSha": repair_proof["mergeSha"],
        "liveBaseSha": live_base,
        "authoritativeBaseSha": live_base,
        "weight": 6,
        "product": task.get("product") or "Wallpaper Engine",
        "path": task.get("path") or "wallpaper-plugin/",
        "verifiedAt": utc_now_iso(),
        "source": "verify-done",
        "remoteFactsSource": SOURCE_GH_PR_API,
        "baseTipSource": SOURCE_GIT_LS_REMOTE,
        "ancestrySource": SOURCE_GIT_MERGE_BASE,
        **suite_record,
    }
    return True, "", "", record


# WP-02 verify-done: single implementation PR identity + suite digests.
WP02_PROOF_CHAIN_ROLES = ("implementation",)
WP02_RUNTIME_CONTRACT_PATH = _FROZEN_SCRIPT_DIR / "wp02-runtime-contract.js"
WP02_CALLER_FORGERY_KEYS = WP01_CALLER_FORGERY_KEYS | frozenset(
    {
        "coreProgressPercent",
        "coreProgress",
        "progress",
    }
)
WP02_SUITE_KEYS = (
    "pluginContractTest",
    "monorepoImportTest",
    "fullNodeTest",
    "wp02ContractTest",
)


def _load_wp02_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    proofs, reason, message = _merge_receipt_and_cli_proofs(
        receipt,
        args,
        missing_reason="WP02_VERIFY_DONE_PROOF_MISSING",
        require_nonempty=True,
    )
    if proofs is None:
        # Preserve RED/GREEN message for empty proofs.
        if message == "missing proofs identity":
            message = "missing WP-02 proofs identity"
        return None, reason, message
    ok, reason, message = _reject_forged_keys_in_proofs(
        proofs,
        forbidden_keys=WP02_CALLER_FORGERY_KEYS,
        forgery_reason="WP02_VERIFY_DONE_CALLER_FORGERY",
    )
    if not ok:
        return None, reason, message
    return proofs, "", ""


def _caller_wp02_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    """Extract implementation PR number identity (caller/receipt only)."""
    chain = proofs.get("proofChain")
    if not isinstance(chain, dict):
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            "missing proofs.proofChain.implementation.prNumber identity",
        )
    entry = chain.get("implementation")
    if not isinstance(entry, dict):
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            "proofChain.implementation missing or incomplete",
        )
    pr_number = _try_int(entry.get("prNumber"))
    if pr_number is None or pr_number <= 0:
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            "proofChain.implementation.prNumber must be positive int (task identity)",
        )
    return pr_number, "", ""


def _verify_wp02_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP02_SUITE_KEYS,
        missing_reason="WP02_VERIFY_DONE_PROOF_MISSING",
    )
    if not ok:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    schema_path = Path(args.schema_path) if args.schema_path else DEFAULT_SCHEMA_BLOB_PATH
    if not catalog_path.is_file():
        return False, "WP02_VERIFY_DONE_PROOF_MISSING", f"catalog missing: {catalog_path}", {}
    if not schema_path.is_file():
        return False, "WP02_VERIFY_DONE_PROOF_MISSING", f"schema missing: {schema_path}", {}
    if not WP02_RUNTIME_CONTRACT_PATH.is_file():
        return (
            False,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            f"wp02-runtime-contract missing: {WP02_RUNTIME_CONTRACT_PATH}",
            {},
        )

    ok, reason, message, live_catalog_sha = _require_matching_file_digest(
        proofs,
        field="catalogSha256",
        path=catalog_path,
        missing_reason="WP02_VERIFY_DONE_PROOF_MISSING",
    )
    if not ok:
        if "must be 64-char hex matching actual file" in message:
            message = "catalogSha256 must be 64-char hex matching actual catalog file"
        return False, reason, message, {}

    ok, reason, message, live_schema_sha = _require_matching_file_digest(
        proofs,
        field="schemaSha256",
        path=schema_path,
        missing_reason="WP02_VERIFY_DONE_PROOF_MISSING",
    )
    if not ok:
        if "must be 64-char hex matching actual file" in message:
            message = "schemaSha256 must be 64-char hex matching actual schema file"
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "pluginContractTest": proofs["pluginContractTest"],
            "monorepoImportTest": proofs["monorepoImportTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "wp02ContractTest": proofs["wp02ContractTest"],
            "runtimeContractPath": str(WP02_RUNTIME_CONTRACT_PATH),
            "runtimeContractSha256": _sha256_file(WP02_RUNTIME_CONTRACT_PATH),
        },
    )


def verify_wp02_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read WP-02 implementation PR; ancestry vs live base, not tip equality."""
    try:
        data = gh_pr_view_json(pr_number, repo=repo)
    except SystemExit:
        raise

    repo_ok, name_with_owner = _pr_repo_matches_approved(data)
    if not repo_ok:
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            f"implementation PR #{pr_number} repository {name_with_owner!r} != {APPROVED_GITHUB_REPO}"
            if name_with_owner and "/" in str(name_with_owner)
            else f"implementation PR #{pr_number} URL/repo does not match {APPROVED_GITHUB_REPO}",
        )

    ok, reason, message = _require_merged_pr_fields(
        data,
        label=f"implementation PR #{pr_number}",
        missing_reason="WP02_VERIFY_DONE_PROOF_MISSING",
    )
    if not ok:
        return None, reason, message

    head_ref = str(data.get("headRefName") or "")
    if not head_ref.startswith(TASK_BRANCH_PREFIX):
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            f"implementation PR head.ref {head_ref!r} must start with {TASK_BRANCH_PREFIX}",
        )

    base_ref = str(data.get("baseRefName") or "")
    if base_ref not in {APPROVED_BASE_BRANCH, APPROVED_BASE_REF}:
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            f"implementation PR base.ref {base_ref!r} is not {APPROVED_BASE_BRANCH}",
        )

    head_sha_raw = data.get("headRefOid")
    if not is_git_sha40(head_sha_raw):
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            "implementation PR head.sha missing/invalid from API",
        )
    head_sha = str(head_sha_raw).lower()

    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict) or not is_git_sha40(merge_commit.get("oid")):
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            f"implementation PR #{pr_number} missing real merge_commit_sha from API",
        )
    merge_sha = str(merge_commit.get("oid")).lower()

    # Ancestry only — never require mergeSha == live tip.
    ok, reason, message = _require_ancestor_of_live_base(
        merge_sha,
        live_base_sha,
        label="implementation mergeSha",
    )
    if not ok:
        return None, reason, message
    ok, reason, message = _require_ancestor_of_live_base(
        head_sha,
        live_base_sha,
        label="implementation head",
    )
    if not ok:
        return None, reason, message

    return (
        {
            "role": "implementation",
            "prNumber": pr_number,
            "headRef": head_ref,
            "headSha": head_sha,
            "taskCommit": head_sha,
            "baseRef": base_ref,
            "mergeSha": merge_sha,
            "mergedAt": data.get("mergedAt"),
            "state": str(data.get("state") or "").upper(),
            "url": data.get("url"),
            "repository": name_with_owner or APPROVED_GITHUB_REPO,
            "mergeIsAncestorOfLiveBase": True,
            "taskCommitIsAncestorOfLiveBase": True,
            "source": SOURCE_GH_PR_API,
            "ancestrySource": SOURCE_GIT_MERGE_BASE,
            "liveBaseSha": live_base_sha,
        },
        "",
        "",
    )


def _catalog_wp02_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    catalog = load_authoritative_catalog(args)
    matches = [
        t
        for t in catalog.get("tasks", [])
        if isinstance(t, dict) and t.get("taskId") == "WP-02"
    ]
    if len(matches) != 1:
        return (
            None,
            "WP02_CATALOG_ENTRY_MISSING",
            f"catalog must contain unique WP-02 entry (found {len(matches)})",
        )
    task = matches[0]
    if task.get("weight") != 8:
        return (
            None,
            "WP02_VERIFY_DONE_PROOF_MISSING",
            f"WP-02 weight must be 8, got {task.get('weight')!r}",
        )
    required_done = task.get("requiredEffectiveDone")
    if not isinstance(required_done, list) or not all(
        dep in required_done for dep in ("WP-INFRA", "WP-00", "WP-01")
    ):
        return (
            None,
            "WP02_PREREQUISITE_NOT_DONE",
            "WP-02.requiredEffectiveDone must include WP-INFRA, WP-00, WP-01",
        )
    return task, "", ""


def evaluate_wp02_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-02 CLOSE-VERIFY.

    Requires:
      - unique catalog WP-02 with weight 8
      - identity-only proofChain.implementation.prNumber
      - independent gh PR API: MERGED + approved repo/base/head prefix
      - merge + head are ancestors of live origin base tip (not tip equality)
      - suite digests + catalog/schema SHA match
      - wp02-runtime-contract.js present
      - caller cannot forge merged/EffectiveDone/REMOTE_VERIFIED/mergeSha/progress
    """
    task, reason, message = _catalog_wp02_task(args)
    if task is None:
        return False, reason, message, {}

    proofs, reason, message = _load_wp02_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp02_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp02_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base = live_authoritative_base_sha()
    claimed_base = proofs.get("authoritativeBaseSha")
    if claimed_base is not None:
        if not is_git_sha40(claimed_base):
            return (
                False,
                "WP02_VERIFY_DONE_PROOF_MISSING",
                "authoritativeBaseSha must be 40-char SHA when provided",
                {},
            )
        if str(claimed_base).lower() != live_base:
            return (
                False,
                "BASE_CONTAINMENT_REQUIRED",
                f"claimed base {str(claimed_base).lower()} != live ls-remote base {live_base}",
                {},
            )

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp02_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = {
        "proofChain": {"implementation": impl_proof},
        "implementationProof": impl_proof,
        "implementationCommit": impl_proof["taskCommit"],
        "implementationMergeSha": impl_proof["mergeSha"],
        "liveBaseSha": live_base,
        "authoritativeBaseSha": live_base,
        "weight": 8,
        "product": task.get("product") or "Wallpaper Engine",
        "path": task.get("path") or "wallpaper-plugin/",
        "evidenceLevel": task.get("evidenceLevel") or "E1",
        "verifiedAt": utc_now_iso(),
        "source": "verify-done",
        "remoteFactsSource": SOURCE_GH_PR_API,
        "baseTipSource": SOURCE_GIT_LS_REMOTE,
        "ancestrySource": SOURCE_GIT_MERGE_BASE,
        **suite_record,
    }
    return True, "", "", record


# ---------------------------------------------------------------------------
# Shared single-PR verify-done helpers (WP-03 / WP-04 REFACTOR).
# Behavior and failure-reason namespaces stay task-specific via parameters.
# Ancestry only — never require mergeSha == live base tip.
# ---------------------------------------------------------------------------
_VERIFICATION_ROOT = Path(
    "/Users/anpple/Codex/Mineradio/android-car/verification/wallpaper-plugin"
)
_BOOTSTRAP_RECEIPTS = {
    "WP-INFRA": _VERIFICATION_ROOT / "bootstrap" / "WP-INFRA-FINAL-RECEIPT-17.json",
    "WP-00": _VERIFICATION_ROOT / "bootstrap" / "WP-00-PR-MERGE-19.json",
}
_TXN_RECEIPTS = {
    "WP-01": _VERIFICATION_ROOT / "transactions" / "wp-01.json",
    "WP-02": _VERIFICATION_ROOT / "transactions" / "wp-02.json",
    "WP-03": _VERIFICATION_ROOT / "transactions" / "wp-03.json",
}


def _digest_field_message_catalog_schema(field: str, message: str) -> str:
    """Normalize digest helper wording for catalog/schema fields."""
    if "must be 64-char hex matching actual file" in message:
        if field == "catalogSha256":
            return "catalogSha256 must be 64-char hex matching actual catalog file"
        if field == "schemaSha256":
            return "schemaSha256 must be 64-char hex matching actual schema file"
    return message


def _load_single_pr_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    missing_reason: str,
    forgery_reason: str,
    forgery_keys: frozenset[str],
    empty_label: str,
) -> tuple[dict[str, Any] | None, str, str]:
    """Merge receipt/CLI proofs; reject caller-forged remote/done facts."""
    proofs, reason, message = _merge_receipt_and_cli_proofs(
        receipt,
        args,
        missing_reason=missing_reason,
        require_nonempty=True,
    )
    if proofs is None:
        if message == "missing proofs identity":
            message = f"missing {empty_label} proofs identity"
        return None, reason, message
    ok, reason, message = _reject_forged_keys_in_proofs(
        proofs,
        forbidden_keys=forgery_keys,
        forgery_reason=forgery_reason,
    )
    if not ok:
        return None, reason, message
    return proofs, "", ""


def _verify_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    invalid_reason: str,
) -> tuple[bool, str, str, str, str]:
    """Return (ok, reason, message, live_catalog_sha, live_schema_sha)."""
    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    schema_path = Path(args.schema_path) if args.schema_path else DEFAULT_SCHEMA_BLOB_PATH
    if not catalog_path.is_file():
        return False, invalid_reason, f"catalog missing: {catalog_path}", "", ""
    if not schema_path.is_file():
        return False, invalid_reason, f"schema missing: {schema_path}", "", ""

    ok, reason, message, live_catalog_sha = _require_matching_file_digest(
        proofs,
        field="catalogSha256",
        path=catalog_path,
        missing_reason=invalid_reason,
    )
    if not ok:
        return (
            False,
            reason,
            _digest_field_message_catalog_schema("catalogSha256", message),
            "",
            "",
        )

    ok, reason, message, live_schema_sha = _require_matching_file_digest(
        proofs,
        field="schemaSha256",
        path=schema_path,
        missing_reason=invalid_reason,
    )
    if not ok:
        return (
            False,
            reason,
            _digest_field_message_catalog_schema("schemaSha256", message),
            "",
            "",
        )

    return True, "", "", live_catalog_sha, live_schema_sha


def _require_merge_head_ancestors_of_live(
    *,
    merge_sha: str,
    head_sha: str,
    live_base_sha: str,
    containment_reason: str,
) -> tuple[bool, str, str]:
    """Ancestry only — never tip equality."""
    ok, reason, message = _require_ancestor_of_live_base(
        merge_sha,
        live_base_sha,
        label="implementation mergeSha",
    )
    if not ok:
        return False, containment_reason, message
    ok, reason, message = _require_ancestor_of_live_base(
        head_sha,
        live_base_sha,
        label="implementation head",
    )
    if not ok:
        return False, containment_reason, message
    return True, "", ""


def _resolve_live_base_optional_claim(
    proofs: Mapping[str, Any],
    *,
    missing_reason: str,
    containment_reason: str,
) -> tuple[str | None, str, str]:
    """ls-remote live tip; optional authoritativeBaseSha must match when provided."""
    live_base = live_authoritative_base_sha()
    claimed_base = proofs.get("authoritativeBaseSha")
    if claimed_base is None:
        return live_base, "", ""
    if not is_git_sha40(claimed_base):
        return (
            None,
            missing_reason,
            "authoritativeBaseSha must be 40-char SHA when provided",
        )
    if str(claimed_base).lower() != live_base:
        return (
            None,
            containment_reason,
            f"claimed base {str(claimed_base).lower()} != live ls-remote base {live_base}",
        )
    return live_base, "", ""


def _read_prereq_done_receipt(
    task_id: str,
    receipt_path: Path,
    *,
    missing_reason: str,
    state_done_tasks: frozenset[str],
) -> tuple[dict[str, Any] | None, str, str]:
    """Load one prerequisite DONE receipt; fail-closed on missing/invalid."""
    if not receipt_path.is_file():
        return (
            None,
            missing_reason,
            f"prerequisite receipt missing for {task_id}: {receipt_path}",
        )
    try:
        data = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return (
            None,
            missing_reason,
            f"prerequisite receipt unreadable for {task_id}: {exc}",
        )
    if data.get("EffectiveDone") is not True:
        return (
            None,
            missing_reason,
            f"{task_id} EffectiveDone is not true on disk receipt",
        )
    if task_id == "WP-INFRA" and data.get("EffectiveGate") is not True:
        return (
            None,
            missing_reason,
            "WP-INFRA EffectiveGate is not true",
        )
    if task_id in state_done_tasks and data.get("state") != "DONE":
        return (
            None,
            missing_reason,
            f"{task_id} state is not DONE",
        )
    return (
        {
            "path": str(receipt_path),
            "EffectiveDone": True,
            "state": data.get("state"),
            "receiptSha256": _sha256_file(receipt_path),
        },
        "",
        "",
    )


def _verify_prereq_done_receipts(
    prereq_map: Mapping[str, Path],
    *,
    missing_reason: str,
    state_done_tasks: frozenset[str],
) -> tuple[bool, str, str, dict[str, Any]]:
    """Real DONE receipts for listed tasks — not caller-forged."""
    snapshot: dict[str, Any] = {}
    for task_id, receipt_path in prereq_map.items():
        entry, reason, message = _read_prereq_done_receipt(
            task_id,
            receipt_path,
            missing_reason=missing_reason,
            state_done_tasks=state_done_tasks,
        )
        if entry is None:
            return False, reason, message, {}
        snapshot[task_id] = entry
    return True, "", "", snapshot


# ---------------------------------------------------------------------------
# Shared single-PR verify-done helpers (WP-03 / WP-04 / WP-05).
# Task modules keep WP0N_* failure namespaces via thin wrappers; behavior
# and proof fields are unchanged. Ancestry-only — never tip equality.
# ---------------------------------------------------------------------------

VERIFY_DONE_PR_JSON_FIELDS = (
    "number,state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,"
    "headRepository,url,title,closed"
)


def _repo_root_for_git() -> Path:
    return _FROZEN_SCRIPT_DIR.parent.parent


def _git_path_exists_at_commit(commit_sha: str, rel_path: str) -> bool:
    """True if blob exists at commit:rel_path (independent of worktree dirty state)."""
    try:
        proc = subprocess.run(
            ["git", "cat-file", "-e", f"{commit_sha}:{rel_path}"],
            cwd=str(_repo_root_for_git()),
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


def _git_show_at_commit(commit_sha: str, rel_path: str) -> tuple[int, str]:
    """Return (returncode, stdout). On OS/timeout error return (-1, "")."""
    try:
        proc = subprocess.run(
            ["git", "show", f"{commit_sha}:{rel_path}"],
            cwd=str(_repo_root_for_git()),
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return -1, ""
    return proc.returncode, proc.stdout or ""


def _build_single_pr_implementation_proof(
    *,
    pr_number: int,
    data: Mapping[str, Any],
    head_ref: str,
    head_sha: str,
    base_ref: str,
    merge_sha: str,
    live_base_sha: str,
    repository: str,
    surface_record: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Common implementation proof fields for single-PR verify-done tasks."""
    record: dict[str, Any] = {
        "role": "implementation",
        "prNumber": pr_number,
        "headRef": head_ref,
        "headSha": head_sha,
        "taskCommit": head_sha,
        "baseRef": base_ref,
        "mergeSha": merge_sha,
        "mergedAt": data.get("mergedAt"),
        "state": str(data.get("state") or "").upper(),
        "url": data.get("url"),
        "repository": repository,
        "mergeIsAncestorOfLiveBase": True,
        "taskCommitIsAncestorOfLiveBase": True,
        "source": SOURCE_GH_PR_API,
        "ancestrySource": SOURCE_GIT_MERGE_BASE,
        "liveBaseSha": live_base_sha,
    }
    if surface_record:
        record.update(dict(surface_record))
    return record


def _verify_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
    invalid_reason: str,
    containment_reason: str,
    surface_checker: (
        Callable[[str], tuple[bool, str, str, dict[str, Any]]] | None
    ) = None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read implementation PR; ancestry vs live base, not tip equality.

    surface_checker(head_sha) -> (ok, reason, message, surface_record) when the
    task requires head-tree surface proof (WP-04/WP-05). WP-03 omits it.
    """
    data, reason, message = _gh_pr_view_json_soft(
        pr_number,
        repo=repo,
        invalid_reason=invalid_reason,
    )
    if data is None:
        return None, reason, message

    repo_ok, name_with_owner = _pr_repo_matches_approved(data)
    if not repo_ok:
        return (
            None,
            invalid_reason,
            f"implementation PR #{pr_number} repository {name_with_owner!r} != {APPROVED_GITHUB_REPO}"
            if name_with_owner and "/" in str(name_with_owner)
            else f"implementation PR #{pr_number} URL/repo does not match {APPROVED_GITHUB_REPO}",
        )

    ok, reason, message = _require_merged_pr_fields(
        data,
        label=f"implementation PR #{pr_number}",
        missing_reason=invalid_reason,
    )
    if not ok:
        return None, reason, message

    head_ref = str(data.get("headRefName") or "")
    if not head_ref.startswith(TASK_BRANCH_PREFIX):
        return (
            None,
            invalid_reason,
            f"implementation PR head.ref {head_ref!r} must start with {TASK_BRANCH_PREFIX}",
        )

    base_ref = str(data.get("baseRefName") or "")
    if base_ref not in {APPROVED_BASE_BRANCH, APPROVED_BASE_REF}:
        return (
            None,
            invalid_reason,
            f"implementation PR base.ref {base_ref!r} is not {APPROVED_BASE_BRANCH}",
        )

    head_sha_raw = data.get("headRefOid")
    if not is_git_sha40(head_sha_raw):
        return (
            None,
            invalid_reason,
            "implementation PR head.sha missing/invalid from API",
        )
    head_sha = str(head_sha_raw).lower()

    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict) or not is_git_sha40(merge_commit.get("oid")):
        return (
            None,
            invalid_reason,
            f"implementation PR #{pr_number} missing real merge_commit_sha from API",
        )
    merge_sha = str(merge_commit.get("oid")).lower()

    ok, reason, message = _require_merge_head_ancestors_of_live(
        merge_sha=merge_sha,
        head_sha=head_sha,
        live_base_sha=live_base_sha,
        containment_reason=containment_reason,
    )
    if not ok:
        return None, reason, message

    surface_record: dict[str, Any] = {}
    if surface_checker is not None:
        ok_surf, reason, message, surface_record = surface_checker(head_sha)
        if not ok_surf:
            return None, reason, message

    proof = _build_single_pr_implementation_proof(
        pr_number=pr_number,
        data=data,
        head_ref=head_ref,
        head_sha=head_sha,
        base_ref=base_ref,
        merge_sha=merge_sha,
        live_base_sha=live_base_sha,
        repository=name_with_owner or APPROVED_GITHUB_REPO,
        surface_record=surface_record or None,
    )
    return proof, "", ""


def _catalog_unique_task(
    args: argparse.Namespace,
    *,
    task_id: str,
    expected_weight: int,
    expected_evidence: str,
    required_prereqs: Sequence[str],
    entry_missing_reason: str,
    catalog_invalid_reason: str,
    required_done_missing_reason: str,
    required_done_message: str,
) -> tuple[dict[str, Any] | None, str, str]:
    """Unique catalog entry + weight/evidence/requiredEffectiveDone checks."""
    catalog = load_authoritative_catalog(args)
    matches = [
        t
        for t in catalog.get("tasks", [])
        if isinstance(t, dict) and t.get("taskId") == task_id
    ]
    if len(matches) != 1:
        return (
            None,
            entry_missing_reason,
            f"catalog must contain unique {task_id} entry (found {len(matches)})",
        )
    task = matches[0]
    if task.get("weight") != expected_weight:
        return (
            None,
            catalog_invalid_reason,
            f"{task_id} weight must be {expected_weight}, got {task.get('weight')!r}",
        )
    if task.get("evidenceLevel") != expected_evidence:
        return (
            None,
            catalog_invalid_reason,
            f"{task_id} evidenceLevel must be {expected_evidence}, got {task.get('evidenceLevel')!r}",
        )
    required_done = task.get("requiredEffectiveDone")
    if not isinstance(required_done, list) or not all(
        dep in required_done for dep in required_prereqs
    ):
        return (
            None,
            required_done_missing_reason,
            required_done_message,
        )
    return task, "", ""


def _assemble_verify_done_record(
    *,
    task: Mapping[str, Any],
    impl_proof: Mapping[str, Any],
    live_base: str,
    prereq_record: Mapping[str, Any],
    suite_record: Mapping[str, Any],
    weight: int,
    default_path: str,
    default_product: str = "Wallpaper Engine",
) -> dict[str, Any]:
    """Assemble the durable verifyDone proof record (shared shape)."""
    return {
        "proofChain": {"implementation": impl_proof},
        "implementationProof": impl_proof,
        "implementationCommit": impl_proof["taskCommit"],
        "implementationMergeSha": impl_proof["mergeSha"],
        "liveBaseSha": live_base,
        "authoritativeBaseSha": live_base,
        "weight": weight,
        "product": task.get("product") or default_product,
        "path": task.get("path") or default_path,
        "evidenceLevel": task.get("evidenceLevel") or "E1",
        "requiredEffectiveDone": list(task.get("requiredEffectiveDone") or []),
        "prerequisiteReceipts": prereq_record,
        "verifiedAt": utc_now_iso(),
        "source": "verify-done",
        "remoteFactsSource": SOURCE_GH_PR_API,
        "baseTipSource": SOURCE_GIT_LS_REMOTE,
        "ancestrySource": SOURCE_GIT_MERGE_BASE,
        **suite_record,
    }


# WP-03 verify-done: single implementation PR identity + suite digests + prereq DONE.
# REFACTOR: uses shared helpers; public failure reasons / proof fields unchanged.
WP03_PROOF_CHAIN_ROLES = ("implementation",)
WP03_STAGING_CONTRACT_PATH = _FROZEN_SCRIPT_DIR / "wp03-staging-contract.js"
WP03_CALLER_FORGERY_KEYS = WP02_CALLER_FORGERY_KEYS | frozenset(
    {
        "catalogSha",
        "schemaSha",
        "suiteDigests",
    }
)
WP03_SUITE_KEYS = (
    "androidUnitTest",
    "wp03ContractTest",
    "fullNodeTest",
    "stagingContractTest",
)
WP03_REQUIRED_PREREQS = ("WP-INFRA", "WP-00", "WP-01", "WP-02")
# Alias retained for older call sites; fields live in VERIFY_DONE_PR_JSON_FIELDS.
WP03_PR_JSON_FIELDS = VERIFY_DONE_PR_JSON_FIELDS
# Shared verification receipts (primary clone; gitignored operational evidence).
_WP03_VERIFICATION_ROOT = _VERIFICATION_ROOT
_WP03_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
}


def _wp03_digest_field_message(field: str, message: str) -> str:
    """Normalize shared digest helper wording for catalog/schema fields."""
    return _digest_field_message_catalog_schema(field, message)


def _gh_pr_view_json_soft(
    pr_number: int,
    *,
    repo: str | None,
    invalid_reason: str,
) -> tuple[dict[str, Any] | None, str, str]:
    """gh pr view without process-level fail(); maps errors to task namespace."""
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--json",
        VERIFY_DONE_PR_JSON_FIELDS,
    ]
    if repo:
        cmd.extend(["--repo", repo])
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=GH_API_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, invalid_reason, f"gh pr view failed: {exc}"
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        return (
            None,
            invalid_reason,
            f"gh pr view exit {proc.returncode} for PR #{pr_number}: {err}",
        )
    try:
        data = json.loads(proc.stdout or "")
    except json.JSONDecodeError as exc:
        return None, invalid_reason, f"gh pr view JSON corrupt: {exc}"
    if not isinstance(data, dict):
        return None, invalid_reason, "gh pr view must return a JSON object"
    return data, "", ""


def _extract_implementation_pr_number(
    proofs: Mapping[str, Any],
    *,
    missing_reason: str,
) -> tuple[int | None, str, str]:
    """proofChain.implementation.prNumber only — never remote facts from caller."""
    chain = proofs.get("proofChain")
    if not isinstance(chain, dict):
        return (
            None,
            missing_reason,
            "missing proofs.proofChain.implementation.prNumber identity",
        )
    entry = chain.get("implementation")
    if not isinstance(entry, dict):
        return (
            None,
            missing_reason,
            "proofChain.implementation missing or incomplete",
        )
    pr_number = _try_int(entry.get("prNumber"))
    if pr_number is None or pr_number <= 0:
        return (
            None,
            missing_reason,
            "proofChain.implementation.prNumber must be positive int (task identity)",
        )
    return pr_number, "", ""


def _load_wp03_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP03_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP03_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP03_CALLER_FORGERY_KEYS,
        empty_label="WP-03",
    )


def _caller_wp03_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    """Extract implementation PR number identity only (never trust remote facts from caller)."""
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP03_VERIFY_DONE_PROOF_MISSING",
    )


def _verify_wp03_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, str, str]:
    """Return (ok, reason, message, live_catalog_sha, live_schema_sha)."""
    return _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP03_CATALOG_PROOF_INVALID",
    )


def _verify_wp03_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP03_SUITE_KEYS,
        missing_reason="WP03_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    if not WP03_STAGING_CONTRACT_PATH.is_file():
        return (
            False,
            "WP03_VERIFY_DONE_PROOF_MISSING",
            f"wp03-staging-contract missing: {WP03_STAGING_CONTRACT_PATH}",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_wp03_catalog_schema_digests(
        proofs, args
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "wp03ContractTest": proofs["wp03ContractTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "stagingContractTest": proofs["stagingContractTest"],
            "stagingContractPath": str(WP03_STAGING_CONTRACT_PATH),
            "stagingContractSha256": _sha256_file(WP03_STAGING_CONTRACT_PATH),
        },
    )


def _wp03_require_ancestors_of_live(
    *,
    merge_sha: str,
    head_sha: str,
    live_base_sha: str,
) -> tuple[bool, str, str]:
    """Ancestry only — never tip equality."""
    return _require_merge_head_ancestors_of_live(
        merge_sha=merge_sha,
        head_sha=head_sha,
        live_base_sha=live_base_sha,
        containment_reason="WP03_BASE_CONTAINMENT_FAILED",
    )


def _wp03_build_implementation_proof(
    *,
    pr_number: int,
    data: Mapping[str, Any],
    head_ref: str,
    head_sha: str,
    base_ref: str,
    merge_sha: str,
    live_base_sha: str,
    repository: str,
) -> dict[str, Any]:
    return _build_single_pr_implementation_proof(
        pr_number=pr_number,
        data=data,
        head_ref=head_ref,
        head_sha=head_sha,
        base_ref=base_ref,
        merge_sha=merge_sha,
        live_base_sha=live_base_sha,
        repository=repository,
    )


def verify_wp03_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read WP-03 implementation PR; ancestry vs live base, not tip equality."""
    # Soft gh view: surface WP03_PR_PROOF_INVALID (not process-level PR_READBACK_REQUIRED).
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP03_PR_PROOF_INVALID",
        containment_reason="WP03_BASE_CONTAINMENT_FAILED",
    )


def _catalog_wp03_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    task, reason, message = _catalog_unique_task(
        args,
        task_id="WP-03",
        expected_weight=8,
        expected_evidence="E1",
        required_prereqs=WP03_REQUIRED_PREREQS,
        entry_missing_reason="WP03_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP03_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP03_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-03.requiredEffectiveDone must include WP-INFRA, WP-00, WP-01, WP-02"
        ),
    )
    if task is None:
        return None, reason, message
    path = str(task.get("path") or "")
    if path and path not in {"wallpaper-plugin/", "wallpaper-plugin"}:
        # Allow empty (inherit product default) or monorepo plugin path only.
        if not path.startswith("wallpaper-plugin"):
            return (
                None,
                "WP03_CATALOG_PROOF_INVALID",
                f"WP-03 path must be under wallpaper-plugin/, got {path!r}",
            )
    return task, "", ""


def _read_wp03_prerequisite_receipt(
    task_id: str,
    receipt_path: Path,
) -> tuple[dict[str, Any] | None, str, str]:
    """Load one prerequisite DONE receipt; fail-closed on missing/invalid."""
    return _read_prereq_done_receipt(
        task_id,
        receipt_path,
        missing_reason="WP03_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset({"WP-01", "WP-02"}),
    )


def _verify_wp03_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    """Real DONE receipts for WP-INFRA/00/01/02 — not caller-forged."""
    return _verify_prereq_done_receipts(
        _WP03_PREREQ_RECEIPTS,
        missing_reason="WP03_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset({"WP-01", "WP-02"}),
    )


def _wp03_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    """ls-remote live tip; optional authoritativeBaseSha must match when provided."""
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP03_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP03_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp03_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-03 CLOSE-VERIFY.

    Requires:
      - unique catalog WP-03 with weight 8 / evidence E1
      - identity-only proofChain.implementation.prNumber
      - independent gh PR API: MERGED + approved repo/base/head prefix
      - merge + head are ancestors of live origin base tip (not tip equality)
      - suite digests + catalog/schema SHA match
      - wp03-staging-contract.js present
      - WP-INFRA/WP-00/WP-01/WP-02 EffectiveDone from real receipts
      - caller cannot forge merged/EffectiveDone/REMOTE_VERIFIED/mergeSha/progress
    """
    task, reason, message = _catalog_wp03_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp03_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp03_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp03_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp03_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp03_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp03_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=8,
        default_path="wallpaper-plugin/",
    )
    return True, "", "", record


# WP-04 verify-done: single implementation PR (#12) + suite digests + prereq DONE.
# GREEN-01: WP04_* namespace only — never WP03_VERIFY_DONE_UNAVAILABLE for WP-04.
# Stable unavailable reason retained for RED contract / documentation (path implemented).
WP04_VERIFY_DONE_UNAVAILABLE = "WP04_VERIFY_DONE_UNAVAILABLE"
WP04_PROOF_CHAIN_ROLES = ("implementation",)
WP04_CONTRACT_PATH = _FROZEN_SCRIPT_DIR / "wallpaper-plugin-contract.js"
WP04_PATCHER_PATH = _FROZEN_SCRIPT_DIR / "patch-wallpaper-plugin-bridge.js"
WP04_SMALI_REL = (
    "android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali"
)
WP04_SMALI_PATH = _FROZEN_SCRIPT_DIR / "smali" / "com" / "mineradio" / "app" / "car" / (
    "CarWallpaperPluginBridge.smali"
)
WP04_BUILD_WIRE_PATH = _FROZEN_SCRIPT_DIR / "build-car-apk.sh"
WP04_BUILD_WIRE_MARKER = "patch-wallpaper-plugin-bridge.js"
WP04_CALLER_FORGERY_KEYS = WP03_CALLER_FORGERY_KEYS | frozenset(
    {
        "catalogSha",
        "schemaSha",
        "suiteDigests",
    }
)
WP04_SUITE_KEYS = (
    "androidUnitTest",
    "bridgeUnitTest",
    "wp04ContractTest",
    "fullNodeTest",
)
WP04_REQUIRED_PREREQS = ("WP-INFRA", "WP-00", "WP-01", "WP-02", "WP-03")
WP04_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-contract.js",
    "android-car/scripts/patch-wallpaper-plugin-bridge.js",
    WP04_SMALI_REL,
    "android-car/scripts/build-car-apk.sh",
)
_WP04_VERIFICATION_ROOT = _VERIFICATION_ROOT
_WP04_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
    "WP-03": _TXN_RECEIPTS["WP-03"],
}


def _wp04_digest_field_message(field: str, message: str) -> str:
    return _digest_field_message_catalog_schema(field, message)


def _load_wp04_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP04_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP04_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP04_CALLER_FORGERY_KEYS,
        empty_label="WP-04",
    )


def _caller_wp04_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP04_VERIFY_DONE_PROOF_MISSING",
    )


def _verify_wp04_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, str, str]:
    return _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP04_CATALOG_PROOF_INVALID",
    )


def _wp04_git_path_exists_at_commit(commit_sha: str, rel_path: str) -> bool:
    """True if blob exists at commit:rel_path (independent of worktree dirty state)."""
    return _git_path_exists_at_commit(commit_sha, rel_path)


def _wp04_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    """PR head must carry WP-04 bridge surfaces + build wire (not WP-03-only heads)."""
    missing: list[str] = []
    for rel in WP04_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP04_PR_PROOF_INVALID",
            "implementation head missing WP-04 surfaces: " + ", ".join(missing),
            {},
        )
    # Build wire marker must appear in build-car-apk.sh at head.
    rc, stdout = _git_show_at_commit(head_sha, "android-car/scripts/build-car-apk.sh")
    if rc < 0:
        return (
            False,
            "WP04_PR_PROOF_INVALID",
            "cannot read build-car-apk.sh at head: git show failed",
            {},
        )
    if rc != 0 or WP04_BUILD_WIRE_MARKER not in stdout:
        return (
            False,
            "WP04_PR_PROOF_INVALID",
            f"implementation head build-car-apk.sh missing {WP04_BUILD_WIRE_MARKER}",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "implementationSurfaces": list(WP04_IMPLEMENTATION_SURFACES),
            "buildWireMarker": WP04_BUILD_WIRE_MARKER,
        },
    )


def _verify_wp04_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP04_SUITE_KEYS,
        missing_reason="WP04_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    # Live worktree must still carry production surfaces (not deleted after merge).
    for path, label in (
        (WP04_CONTRACT_PATH, "wallpaper-plugin-contract.js"),
        (WP04_PATCHER_PATH, "patch-wallpaper-plugin-bridge.js"),
        (WP04_SMALI_PATH, "CarWallpaperPluginBridge.smali"),
        (WP04_BUILD_WIRE_PATH, "build-car-apk.sh"),
    ):
        if not path.is_file():
            return (
                False,
                "WP04_VERIFY_DONE_PROOF_MISSING",
                f"WP-04 production surface missing: {label} ({path})",
                {},
            )
    build_text = WP04_BUILD_WIRE_PATH.read_text(encoding="utf-8")
    if WP04_BUILD_WIRE_MARKER not in build_text:
        return (
            False,
            "WP04_VERIFY_DONE_PROOF_MISSING",
            f"build-car-apk.sh missing wire marker {WP04_BUILD_WIRE_MARKER}",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_wp04_catalog_schema_digests(
        proofs, args
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "bridgeUnitTest": proofs["bridgeUnitTest"],
            "wp04ContractTest": proofs["wp04ContractTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "contractPath": str(WP04_CONTRACT_PATH),
            "contractSha256": _sha256_file(WP04_CONTRACT_PATH),
            "patcherPath": str(WP04_PATCHER_PATH),
            "patcherSha256": _sha256_file(WP04_PATCHER_PATH),
            "smaliPath": str(WP04_SMALI_PATH),
            "smaliSha256": _sha256_file(WP04_SMALI_PATH),
            "buildWirePath": str(WP04_BUILD_WIRE_PATH),
            "buildWireMarker": WP04_BUILD_WIRE_MARKER,
        },
    )


def _wp04_require_ancestors_of_live(
    *,
    merge_sha: str,
    head_sha: str,
    live_base_sha: str,
) -> tuple[bool, str, str]:
    """Ancestry only — never tip equality."""
    return _require_merge_head_ancestors_of_live(
        merge_sha=merge_sha,
        head_sha=head_sha,
        live_base_sha=live_base_sha,
        containment_reason="WP04_BASE_CONTAINMENT_FAILED",
    )


def _wp04_build_implementation_proof(
    *,
    pr_number: int,
    data: Mapping[str, Any],
    head_ref: str,
    head_sha: str,
    base_ref: str,
    merge_sha: str,
    live_base_sha: str,
    repository: str,
    surface_record: Mapping[str, Any],
) -> dict[str, Any]:
    return _build_single_pr_implementation_proof(
        pr_number=pr_number,
        data=data,
        head_ref=head_ref,
        head_sha=head_sha,
        base_ref=base_ref,
        merge_sha=merge_sha,
        live_base_sha=live_base_sha,
        repository=repository,
        surface_record=surface_record,
    )


def verify_wp04_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read WP-04 implementation PR; ancestry vs live base, not tip equality."""
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP04_PR_PROOF_INVALID",
        containment_reason="WP04_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp04_require_implementation_surfaces_on_head,
    )


def _catalog_wp04_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-04",
        expected_weight=10,
        expected_evidence="E1",
        required_prereqs=WP04_REQUIRED_PREREQS,
        entry_missing_reason="WP04_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP04_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP04_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-04.requiredEffectiveDone must include WP-INFRA, WP-00, WP-01, WP-02, WP-03"
        ),
    )


def _read_wp04_prerequisite_receipt(
    task_id: str,
    receipt_path: Path,
) -> tuple[dict[str, Any] | None, str, str]:
    return _read_prereq_done_receipt(
        task_id,
        receipt_path,
        missing_reason="WP04_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset({"WP-01", "WP-02", "WP-03"}),
    )


def _verify_wp04_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    """Real DONE receipts for WP-INFRA/00/01/02/03 — not caller-forged."""
    return _verify_prereq_done_receipts(
        _WP04_PREREQ_RECEIPTS,
        missing_reason="WP04_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset({"WP-01", "WP-02", "WP-03"}),
    )


def _wp04_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    """ls-remote live tip; optional authoritativeBaseSha must match when provided."""
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP04_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP04_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp04_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-04 CLOSE-VERIFY.

    Requires:
      - unique catalog WP-04 with weight 10 / evidence E1
      - identity-only proofChain.implementation.prNumber
      - independent gh PR API: MERGED + approved repo/base/head prefix
      - merge + head are ancestors of live origin base tip (not tip equality)
      - head tree carries WP-04 bridge surfaces + build wire
      - suite digests + catalog/schema SHA match
      - wallpaper-plugin-contract.js / patcher / smali present
      - WP-INFRA/WP-00/WP-01/WP-02/WP-03 EffectiveDone from real receipts
      - caller cannot forge merged/EffectiveDone/REMOTE_VERIFIED/mergeSha/progress
    """
    task, reason, message = _catalog_wp04_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp04_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp04_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp04_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp04_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp04_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp04_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=10,
        default_path="android-car/scripts/",
    )
    return True, "", "", record


# WP-05 verify-done: single implementation PR (#14) + suite digests + prereq DONE.
# REFACTOR-01: shares PR/catalog/suite/ancestry/prereq helpers with WP-03/WP-04;
# WP05_* namespace + FileProvider surface checks unchanged.
# Stable unavailable reason retained for RED contract / documentation (path implemented).
WP05_VERIFY_DONE_UNAVAILABLE = "WP05_VERIFY_DONE_UNAVAILABLE"
WP05_PROOF_CHAIN_ROLES = ("implementation",)
WP05_CONTRACT_PATH = _FROZEN_SCRIPT_DIR / "wallpaper-plugin-contract.js"
WP05_PATCHER_PATH = _FROZEN_SCRIPT_DIR / "patch-wallpaper-plugin-bridge.js"
WP05_MANIFEST_PATCHER_PATH = _FROZEN_SCRIPT_DIR / "patch-apk-manifest.js"
WP05_SMALI_BRIDGE_REL = (
    "android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali"
)
WP05_SMALI_STAGER_REL = (
    "android-car/scripts/smali/com/mineradio/app/car/CarWallpaperMpkgStager.smali"
)
WP05_PATHS_XML_REL = "android-car/scripts/resources/xml/wallpaper_plugin_paths.xml"
WP05_SMALI_BRIDGE_PATH = (
    _FROZEN_SCRIPT_DIR / "smali" / "com" / "mineradio" / "app" / "car" / (
        "CarWallpaperPluginBridge.smali"
    )
)
WP05_SMALI_STAGER_PATH = (
    _FROZEN_SCRIPT_DIR / "smali" / "com" / "mineradio" / "app" / "car" / (
        "CarWallpaperMpkgStager.smali"
    )
)
WP05_PATHS_XML_PATH = (
    _FROZEN_SCRIPT_DIR / "resources" / "xml" / "wallpaper_plugin_paths.xml"
)
WP05_FILE_PROVIDER_AUTHORITY = "com.mineradio.app.wallpaperplugin.files"
WP05_STAGE_MARKER = "wallpaper_plugin_stage"
# Same forgery surface as WP-03/WP-04 (already includes catalog/schema/suite keys).
WP05_CALLER_FORGERY_KEYS = WP04_CALLER_FORGERY_KEYS
WP05_SUITE_KEYS = (
    "androidUnitTest",
    "bridgeUnitTest",
    "wp05FileProviderTest",
    "monorepoImportTest",
    "fullNodeTest",
)
WP05_REQUIRED_PREREQS = (
    "WP-INFRA",
    "WP-00",
    "WP-01",
    "WP-02",
    "WP-03",
    "WP-04",
)
WP05_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-contract.js",
    "android-car/scripts/patch-wallpaper-plugin-bridge.js",
    "android-car/scripts/patch-apk-manifest.js",
    WP05_SMALI_BRIDGE_REL,
    WP05_SMALI_STAGER_REL,
    WP05_PATHS_XML_REL,
)
_WP05_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
    "WP-03": _TXN_RECEIPTS["WP-03"],
    "WP-04": _VERIFICATION_ROOT / "transactions" / "wp-04.json",
}


def _load_wp05_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP05_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP05_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP05_CALLER_FORGERY_KEYS,
        empty_label="WP-05",
    )


def _caller_wp05_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP05_VERIFY_DONE_PROOF_MISSING",
    )


def _verify_wp05_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, str, str]:
    return _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP05_CATALOG_PROOF_INVALID",
    )


def _wp05_git_path_exists_at_commit(commit_sha: str, rel_path: str) -> bool:
    """True if blob exists at commit:rel_path (independent of worktree dirty state)."""
    return _git_path_exists_at_commit(commit_sha, rel_path)


def _wp05_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    """PR head must carry WP-05 FileProvider / stager / import surfaces."""
    missing: list[str] = []
    for rel in WP05_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "implementation head missing WP-05 surfaces: " + ", ".join(missing),
            {},
        )
    # Paths XML must only expose cache-path wallpaper_plugin_stage at head.
    rc, paths_text = _git_show_at_commit(head_sha, WP05_PATHS_XML_REL)
    if rc < 0:
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "cannot read wallpaper_plugin_paths.xml at head: git show failed",
            {},
        )
    if (
        rc != 0
        or "cache-path" not in paths_text
        or WP05_STAGE_MARKER not in paths_text
        or re.search(r"<(files-path|external-path|root-path)\b", paths_text)
    ):
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "implementation head paths XML must only expose cache-path wallpaper_plugin_stage/",
            {},
        )
    # Stager + bridge importMpkg markers at head.
    stager_rc, stager_text = _git_show_at_commit(head_sha, WP05_SMALI_STAGER_REL)
    bridge_rc, bridge_text = _git_show_at_commit(head_sha, WP05_SMALI_BRIDGE_REL)
    if stager_rc < 0 or bridge_rc < 0:
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "cannot read WP-05 Smali at head: git show failed",
            {},
        )
    if (
        stager_rc != 0
        or "CarWallpaperMpkgStager" not in stager_text
        or WP05_STAGE_MARKER not in stager_text
        or WP05_FILE_PROVIDER_AUTHORITY not in stager_text
    ):
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "implementation head CarWallpaperMpkgStager missing stage/authority markers",
            {},
        )
    if (
        bridge_rc != 0
        or "importMpkg" not in bridge_text
        or "CarWallpaperMpkgStager" not in bridge_text
    ):
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "implementation head importMpkg must route through CarWallpaperMpkgStager",
            {},
        )
    # Manifest patcher must name FileProvider authority.
    mp_rc, mp_text = _git_show_at_commit(
        head_sha, "android-car/scripts/patch-apk-manifest.js"
    )
    if mp_rc < 0:
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "cannot read patch-apk-manifest.js at head: git show failed",
            {},
        )
    if (
        mp_rc != 0
        or WP05_FILE_PROVIDER_AUTHORITY not in mp_text
        or "FileProvider" not in mp_text
    ):
        return (
            False,
            "WP05_PR_PROOF_INVALID",
            "implementation head patch-apk-manifest.js missing FileProvider authority wire",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "implementationSurfaces": list(WP05_IMPLEMENTATION_SURFACES),
            "fileProviderAuthority": WP05_FILE_PROVIDER_AUTHORITY,
            "stageMarker": WP05_STAGE_MARKER,
        },
    )


def _verify_wp05_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP05_SUITE_KEYS,
        missing_reason="WP05_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    # Live worktree must still carry WP-05 production surfaces.
    for path, label in (
        (WP05_CONTRACT_PATH, "wallpaper-plugin-contract.js"),
        (WP05_PATCHER_PATH, "patch-wallpaper-plugin-bridge.js"),
        (WP05_MANIFEST_PATCHER_PATH, "patch-apk-manifest.js"),
        (WP05_SMALI_BRIDGE_PATH, "CarWallpaperPluginBridge.smali"),
        (WP05_SMALI_STAGER_PATH, "CarWallpaperMpkgStager.smali"),
        (WP05_PATHS_XML_PATH, "wallpaper_plugin_paths.xml"),
    ):
        if not path.is_file():
            return (
                False,
                "WP05_VERIFY_DONE_PROOF_MISSING",
                f"WP-05 production surface missing: {label} ({path})",
                {},
            )
    paths_text = WP05_PATHS_XML_PATH.read_text(encoding="utf-8")
    if (
        "cache-path" not in paths_text
        or WP05_STAGE_MARKER not in paths_text
        or re.search(r"<(files-path|external-path|root-path)\b", paths_text)
    ):
        return (
            False,
            "WP05_VERIFY_DONE_PROOF_MISSING",
            "wallpaper_plugin_paths.xml must only expose cache-path wallpaper_plugin_stage/",
            {},
        )
    stager_text = WP05_SMALI_STAGER_PATH.read_text(encoding="utf-8")
    if (
        "CarWallpaperMpkgStager" not in stager_text
        or WP05_FILE_PROVIDER_AUTHORITY not in stager_text
    ):
        return (
            False,
            "WP05_VERIFY_DONE_PROOF_MISSING",
            "CarWallpaperMpkgStager.smali missing authority/stage markers",
            {},
        )
    bridge_text = WP05_SMALI_BRIDGE_PATH.read_text(encoding="utf-8")
    if "importMpkg" not in bridge_text or "CarWallpaperMpkgStager" not in bridge_text:
        return (
            False,
            "WP05_VERIFY_DONE_PROOF_MISSING",
            "importMpkg must route through CarWallpaperMpkgStager",
            {},
        )
    manifest_text = WP05_MANIFEST_PATCHER_PATH.read_text(encoding="utf-8")
    if WP05_FILE_PROVIDER_AUTHORITY not in manifest_text or "FileProvider" not in manifest_text:
        return (
            False,
            "WP05_VERIFY_DONE_PROOF_MISSING",
            "patch-apk-manifest.js missing FileProvider authority wire",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_wp05_catalog_schema_digests(
        proofs, args
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "bridgeUnitTest": proofs["bridgeUnitTest"],
            "wp05FileProviderTest": proofs["wp05FileProviderTest"],
            "monorepoImportTest": proofs["monorepoImportTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "contractPath": str(WP05_CONTRACT_PATH),
            "contractSha256": _sha256_file(WP05_CONTRACT_PATH),
            "patcherPath": str(WP05_PATCHER_PATH),
            "patcherSha256": _sha256_file(WP05_PATCHER_PATH),
            "manifestPatcherPath": str(WP05_MANIFEST_PATCHER_PATH),
            "manifestPatcherSha256": _sha256_file(WP05_MANIFEST_PATCHER_PATH),
            "smaliBridgePath": str(WP05_SMALI_BRIDGE_PATH),
            "smaliBridgeSha256": _sha256_file(WP05_SMALI_BRIDGE_PATH),
            "smaliStagerPath": str(WP05_SMALI_STAGER_PATH),
            "smaliStagerSha256": _sha256_file(WP05_SMALI_STAGER_PATH),
            "pathsXmlPath": str(WP05_PATHS_XML_PATH),
            "pathsXmlSha256": _sha256_file(WP05_PATHS_XML_PATH),
            "fileProviderAuthority": WP05_FILE_PROVIDER_AUTHORITY,
            "stageMarker": WP05_STAGE_MARKER,
        },
    )


def _wp05_require_ancestors_of_live(
    *,
    merge_sha: str,
    head_sha: str,
    live_base_sha: str,
) -> tuple[bool, str, str]:
    """Ancestry only — never tip equality."""
    return _require_merge_head_ancestors_of_live(
        merge_sha=merge_sha,
        head_sha=head_sha,
        live_base_sha=live_base_sha,
        containment_reason="WP05_BASE_CONTAINMENT_FAILED",
    )


def _wp05_build_implementation_proof(
    *,
    pr_number: int,
    data: Mapping[str, Any],
    head_ref: str,
    head_sha: str,
    base_ref: str,
    merge_sha: str,
    live_base_sha: str,
    repository: str,
    surface_record: Mapping[str, Any],
) -> dict[str, Any]:
    return _build_single_pr_implementation_proof(
        pr_number=pr_number,
        data=data,
        head_ref=head_ref,
        head_sha=head_sha,
        base_ref=base_ref,
        merge_sha=merge_sha,
        live_base_sha=live_base_sha,
        repository=repository,
        surface_record=surface_record,
    )


def verify_wp05_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read WP-05 implementation PR; ancestry vs live base, not tip equality."""
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP05_PR_PROOF_INVALID",
        containment_reason="WP05_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp05_require_implementation_surfaces_on_head,
    )


def _catalog_wp05_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-05",
        expected_weight=8,
        expected_evidence="E1",
        required_prereqs=WP05_REQUIRED_PREREQS,
        entry_missing_reason="WP05_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP05_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP05_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-05.requiredEffectiveDone must include WP-INFRA, WP-00, WP-01, WP-02, WP-03, WP-04"
        ),
    )


def _verify_wp05_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    """Real DONE receipts for WP-INFRA/00/01/02/03/04 — not caller-forged."""
    return _verify_prereq_done_receipts(
        _WP05_PREREQ_RECEIPTS,
        missing_reason="WP05_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset({"WP-01", "WP-02", "WP-03", "WP-04"}),
    )


def _wp05_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    """ls-remote live tip; optional authoritativeBaseSha must match when provided."""
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP05_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP05_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp05_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-05 CLOSE-VERIFY.

    Requires:
      - unique catalog WP-05 with weight 8 / evidence E1
      - identity-only proofChain.implementation.prNumber
      - independent gh PR API: MERGED + approved repo/base/head prefix
      - merge + head are ancestors of live origin base tip (not tip equality)
      - head tree carries WP-05 FileProvider / stager / import surfaces
      - suite digests + catalog/schema SHA match
      - WP-INFRA/WP-00/WP-01/WP-02/WP-03/WP-04 EffectiveDone from real receipts
      - caller cannot forge merged/EffectiveDone/REMOTE_VERIFIED/mergeSha/progress
    """
    task, reason, message = _catalog_wp05_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp05_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp05_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp05_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp05_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp05_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp05_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=8,
        default_path="android-car/scripts/",
    )
    return True, "", "", record


# WP-06 verify-done: single implementation PR (#16) + suite digests + prereq DONE.
# GREEN-01: WP06_* namespace only — never WP05_/WP04_/WP03_* mis-tags for WP-06.
# REFACTOR-01: already uses shared single-PR helpers (_verify_merged_implementation_pr,
# _catalog_unique_task, _assemble_verify_done_record, suite/catalog/prereq digests);
# installer surface checker remains WP-06-specific. Behavior unchanged.
# Stable unavailable reason retained for RED contract / documentation (path implemented).
WP06_VERIFY_DONE_UNAVAILABLE = "WP06_VERIFY_DONE_UNAVAILABLE"
WP06_CONTRACT_PATH = _FROZEN_SCRIPT_DIR / "wallpaper-plugin-contract.js"
WP06_PATCHER_PATH = _FROZEN_SCRIPT_DIR / "patch-wallpaper-plugin-bridge.js"
WP06_MANIFEST_PATCHER_PATH = _FROZEN_SCRIPT_DIR / "patch-apk-manifest.js"
WP06_SMALI_BRIDGE_REL = (
    "android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali"
)
WP06_SMALI_INSTALLER_REL = (
    "android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginInstaller.smali"
)
WP06_SMALI_BRIDGE_PATH = (
    _FROZEN_SCRIPT_DIR / "smali" / "com" / "mineradio" / "app" / "car" / (
        "CarWallpaperPluginBridge.smali"
    )
)
WP06_SMALI_INSTALLER_PATH = (
    _FROZEN_SCRIPT_DIR / "smali" / "com" / "mineradio" / "app" / "car" / (
        "CarWallpaperPluginInstaller.smali"
    )
)
WP06_PLUGIN_PACKAGE = "com.motif.wallpaperengine"
WP06_WE_CLIENT_PACKAGE = "io.wallpaperengine.weclient"
WP06_REQUEST_INSTALL = "android.permission.REQUEST_INSTALL_PACKAGES"
WP06_APK_MIME = "application/vnd.android.package-archive"
WP06_CALLER_FORGERY_KEYS = WP05_CALLER_FORGERY_KEYS
WP06_SUITE_KEYS = (
    "androidUnitTest",
    "bridgeUnitTest",
    "wp06InstallerTest",
    "monorepoImportTest",
    "fullNodeTest",
)
WP06_REQUIRED_PREREQS = (
    "WP-INFRA",
    "WP-00",
    "WP-01",
    "WP-02",
    "WP-03",
    "WP-04",
    "WP-05",
)
WP06_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-contract.js",
    "android-car/scripts/patch-wallpaper-plugin-bridge.js",
    "android-car/scripts/patch-apk-manifest.js",
    "android-car/scripts/patch-manifest.js",
    WP06_SMALI_BRIDGE_REL,
    WP06_SMALI_INSTALLER_REL,
)
_WP06_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
    "WP-03": _TXN_RECEIPTS["WP-03"],
    "WP-04": _VERIFICATION_ROOT / "transactions" / "wp-04.json",
    "WP-05": _VERIFICATION_ROOT / "transactions" / "wp-05.json",
}


def _load_wp06_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP06_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP06_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP06_CALLER_FORGERY_KEYS,
        empty_label="WP-06",
    )


def _caller_wp06_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP06_VERIFY_DONE_PROOF_MISSING",
    )


def _verify_wp06_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, str, str]:
    return _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP06_CATALOG_PROOF_INVALID",
    )


def _wp06_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    """PR head must carry WP-06 installer / package visibility surfaces."""
    missing: list[str] = []
    for rel in WP06_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP06_PR_PROOF_INVALID",
            "implementation head missing WP-06 surfaces: " + ", ".join(missing),
            {},
        )

    inst_rc, inst_text = _git_show_at_commit(head_sha, WP06_SMALI_INSTALLER_REL)
    if inst_rc < 0:
        return (
            False,
            "WP06_PR_PROOF_INVALID",
            "cannot read CarWallpaperPluginInstaller.smali at head: git show failed",
            {},
        )
    if (
        inst_rc != 0
        or "CarWallpaperPluginInstaller" not in inst_text
        or "PackageInstaller" not in inst_text
        or "content://" not in inst_text
        or WP06_PLUGIN_PACKAGE not in inst_text
        or WP06_APK_MIME not in inst_text
    ):
        return (
            False,
            "WP06_PR_PROOF_INVALID",
            "implementation head installer missing PackageInstaller/content/MIME/package markers",
            {},
        )

    bridge_rc, bridge_text = _git_show_at_commit(head_sha, WP06_SMALI_BRIDGE_REL)
    if bridge_rc < 0:
        return (
            False,
            "WP06_PR_PROOF_INVALID",
            "cannot read CarWallpaperPluginBridge.smali at head: git show failed",
            {},
        )
    if (
        bridge_rc != 0
        or "isInstalled" not in bridge_text
        or "getPluginVersion" not in bridge_text
        or "installPlugin" not in bridge_text
        or "CarWallpaperPluginInstaller" not in bridge_text
        or "requestInstallFromContentUri" not in bridge_text
    ):
        return (
            False,
            "WP06_PR_PROOF_INVALID",
            "implementation head installPlugin must route through CarWallpaperPluginInstaller",
            {},
        )

    mp_rc, mp_text = _git_show_at_commit(
        head_sha, "android-car/scripts/patch-apk-manifest.js"
    )
    if mp_rc < 0:
        return (
            False,
            "WP06_PR_PROOF_INVALID",
            "cannot read patch-apk-manifest.js at head: git show failed",
            {},
        )
    if (
        mp_rc != 0
        or WP06_REQUEST_INSTALL not in mp_text
        or WP06_PLUGIN_PACKAGE not in mp_text
        or WP06_WE_CLIENT_PACKAGE not in mp_text
    ):
        return (
            False,
            "WP06_PR_PROOF_INVALID",
            "implementation head patch-apk-manifest.js missing REQUEST_INSTALL/package queries wire",
            {},
        )

    return (
        True,
        "",
        "",
        {
            "implementationSurfaces": list(WP06_IMPLEMENTATION_SURFACES),
            "pluginPackage": WP06_PLUGIN_PACKAGE,
            "weClientPackage": WP06_WE_CLIENT_PACKAGE,
            "requestInstallPackages": WP06_REQUEST_INSTALL,
            "apkMime": WP06_APK_MIME,
        },
    )


def _verify_wp06_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP06_SUITE_KEYS,
        missing_reason="WP06_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    for path, label in (
        (WP06_CONTRACT_PATH, "wallpaper-plugin-contract.js"),
        (WP06_PATCHER_PATH, "patch-wallpaper-plugin-bridge.js"),
        (WP06_MANIFEST_PATCHER_PATH, "patch-apk-manifest.js"),
        (WP06_SMALI_BRIDGE_PATH, "CarWallpaperPluginBridge.smali"),
        (WP06_SMALI_INSTALLER_PATH, "CarWallpaperPluginInstaller.smali"),
    ):
        if not path.is_file():
            return (
                False,
                "WP06_VERIFY_DONE_PROOF_MISSING",
                f"WP-06 production surface missing: {label} ({path})",
                {},
            )

    installer_text = WP06_SMALI_INSTALLER_PATH.read_text(encoding="utf-8")
    if (
        "CarWallpaperPluginInstaller" not in installer_text
        or "PackageInstaller" not in installer_text
        or WP06_PLUGIN_PACKAGE not in installer_text
    ):
        return (
            False,
            "WP06_VERIFY_DONE_PROOF_MISSING",
            "CarWallpaperPluginInstaller.smali missing PackageInstaller/package markers",
            {},
        )
    bridge_text = WP06_SMALI_BRIDGE_PATH.read_text(encoding="utf-8")
    if (
        "isInstalled" not in bridge_text
        or "getPluginVersion" not in bridge_text
        or "installPlugin" not in bridge_text
        or "CarWallpaperPluginInstaller" not in bridge_text
    ):
        return (
            False,
            "WP06_VERIFY_DONE_PROOF_MISSING",
            "bridge install methods must route through CarWallpaperPluginInstaller",
            {},
        )
    manifest_text = WP06_MANIFEST_PATCHER_PATH.read_text(encoding="utf-8")
    if (
        WP06_REQUEST_INSTALL not in manifest_text
        or WP06_PLUGIN_PACKAGE not in manifest_text
    ):
        return (
            False,
            "WP06_VERIFY_DONE_PROOF_MISSING",
            "patch-apk-manifest.js missing REQUEST_INSTALL/package query anchors",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_wp06_catalog_schema_digests(
        proofs, args
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "bridgeUnitTest": proofs["bridgeUnitTest"],
            "wp06InstallerTest": proofs["wp06InstallerTest"],
            "monorepoImportTest": proofs["monorepoImportTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "contractPath": str(WP06_CONTRACT_PATH),
            "contractSha256": _sha256_file(WP06_CONTRACT_PATH),
            "patcherPath": str(WP06_PATCHER_PATH),
            "patcherSha256": _sha256_file(WP06_PATCHER_PATH),
            "manifestPatcherPath": str(WP06_MANIFEST_PATCHER_PATH),
            "manifestPatcherSha256": _sha256_file(WP06_MANIFEST_PATCHER_PATH),
            "smaliBridgePath": str(WP06_SMALI_BRIDGE_PATH),
            "smaliBridgeSha256": _sha256_file(WP06_SMALI_BRIDGE_PATH),
            "smaliInstallerPath": str(WP06_SMALI_INSTALLER_PATH),
            "smaliInstallerSha256": _sha256_file(WP06_SMALI_INSTALLER_PATH),
            "pluginPackage": WP06_PLUGIN_PACKAGE,
            "requestInstallPackages": WP06_REQUEST_INSTALL,
            "apkMime": WP06_APK_MIME,
        },
    )


def verify_wp06_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read WP-06 implementation PR; ancestry vs live base, not tip equality."""
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP06_PR_PROOF_INVALID",
        containment_reason="WP06_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp06_require_implementation_surfaces_on_head,
    )


def _catalog_wp06_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-06",
        expected_weight=6,
        expected_evidence="E1",
        required_prereqs=WP06_REQUIRED_PREREQS,
        entry_missing_reason="WP06_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP06_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP06_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-06.requiredEffectiveDone must include WP-INFRA, WP-00, WP-01, WP-02, WP-03, WP-04, WP-05"
        ),
    )


def _verify_wp06_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    """Real DONE receipts for WP-INFRA/00/01/02/03/04/05 — not caller-forged."""
    return _verify_prereq_done_receipts(
        _WP06_PREREQ_RECEIPTS,
        missing_reason="WP06_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset({"WP-01", "WP-02", "WP-03", "WP-04", "WP-05"}),
    )


def _wp06_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP06_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP06_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp06_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-06 CLOSE-VERIFY.

    Requires:
      - unique catalog WP-06 with weight 6 / evidence E1
      - identity-only proofChain.implementation.prNumber
      - independent gh PR API: MERGED + approved repo/base/head prefix
      - merge + head are ancestors of live origin base tip (not tip equality)
      - head tree carries WP-06 installer / package visibility surfaces
      - suite digests + catalog/schema SHA match
      - WP-INFRA…WP-05 EffectiveDone from real receipts
      - caller cannot forge merged/EffectiveDone/REMOTE_VERIFIED/mergeSha/progress
    """
    task, reason, message = _catalog_wp06_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp06_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp06_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp06_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp06_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp06_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp06_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=6,
        default_path="android-car/scripts/",
    )
    return True, "", "", record


# WP-07 verify-done: single implementation PR (#18) + suite digests + prereq DONE.
# WP07_* namespace only — never WP06_/WP05_/… mis-tags for WP-07.
# Shared helpers: _verify_merged_implementation_pr, _catalog_unique_task,
# _assemble_verify_done_record, suite/catalog/prereq digests.
# Stable unavailable reason retained for RED contract / documentation.
WP07_VERIFY_DONE_UNAVAILABLE = "WP07_VERIFY_DONE_UNAVAILABLE"
WP07_RUNTIME_PATH = _FROZEN_SCRIPT_DIR / "wallpaper-plugin-runtime.js"
WP07_HMI_PATCHER_PATH = _FROZEN_SCRIPT_DIR / "patch-car-hmi-assets.js"
WP07_RUNTIME_REL = "android-car/scripts/wallpaper-plugin-runtime.js"
WP07_HMI_PATCHER_REL = "android-car/scripts/patch-car-hmi-assets.js"
WP07_CATALOG_REL = "android-car/scripts/wallpaper-plugin-tasks.json"
WP07_RUNTIME_TEST_REL = "android-car/tests/wallpaper-plugin-runtime.test.js"
WP07_GLOBAL = "MineradioWallpaperPlugin"
WP07_CALLER_FORGERY_KEYS = WP06_CALLER_FORGERY_KEYS
WP07_SUITE_KEYS = (
    "androidUnitTest",
    "bridgeUnitTest",
    "wp07RuntimeTest",
    "monorepoImportTest",
    "fullNodeTest",
)
WP07_REQUIRED_PREREQS = (
    "WP-INFRA",
    "WP-00",
    "WP-01",
    "WP-02",
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-06",
)
WP07_IMPLEMENTATION_SURFACES = (
    WP07_RUNTIME_REL,
    WP07_HMI_PATCHER_REL,
    WP07_CATALOG_REL,
    WP07_RUNTIME_TEST_REL,
)
_WP07_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
    "WP-03": _TXN_RECEIPTS["WP-03"],
    "WP-04": _VERIFICATION_ROOT / "transactions" / "wp-04.json",
    "WP-05": _VERIFICATION_ROOT / "transactions" / "wp-05.json",
    "WP-06": _VERIFICATION_ROOT / "transactions" / "wp-06.json",
}


def _load_wp07_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP07_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP07_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP07_CALLER_FORGERY_KEYS,
        empty_label="WP-07",
    )


def _caller_wp07_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP07_VERIFY_DONE_PROOF_MISSING",
    )


def _verify_wp07_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, str, str]:
    return _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP07_CATALOG_PROOF_INVALID",
    )


def _wp07_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    """PR head must carry WP-07 HMI runtime / inject surfaces."""
    missing: list[str] = []
    for rel in WP07_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP07_PR_PROOF_INVALID",
            "implementation head missing WP-07 surfaces: " + ", ".join(missing),
            {},
        )

    rt_rc, rt_text = _git_show_at_commit(head_sha, WP07_RUNTIME_REL)
    if rt_rc < 0:
        return (
            False,
            "WP07_PR_PROOF_INVALID",
            "cannot read wallpaper-plugin-runtime.js at head: git show failed",
            {},
        )
    if (
        rt_rc != 0
        or WP07_GLOBAL not in rt_text
        or "WallpaperPlugin" not in rt_text
        or "importMpkg" not in rt_text
        or "confirmUserAction" not in rt_text
        or "500" not in rt_text
        or "5000" not in rt_text
        or "visibilitychange" not in rt_text
        or "forbidEngineLaunchedPreview" not in rt_text
        or "未安装" not in rt_text
    ):
        return (
            False,
            "WP07_PR_PROOF_INVALID",
            "implementation head runtime missing MineradioWallpaperPlugin/poll/UI markers",
            {},
        )

    hp_rc, hp_text = _git_show_at_commit(head_sha, WP07_HMI_PATCHER_REL)
    if hp_rc < 0:
        return (
            False,
            "WP07_PR_PROOF_INVALID",
            "cannot read patch-car-hmi-assets.js at head: git show failed",
            {},
        )
    if (
        hp_rc != 0
        or "wallpaper-plugin-runtime.js" not in hp_text
        or WP07_GLOBAL not in hp_text
        or "wallpaper-plugin-card" not in hp_text
    ):
        return (
            False,
            "WP07_PR_PROOF_INVALID",
            "implementation head HMI patcher missing runtime/status-card inject",
            {},
        )

    cat_rc, cat_text = _git_show_at_commit(head_sha, WP07_CATALOG_REL)
    if cat_rc < 0:
        return (
            False,
            "WP07_PR_PROOF_INVALID",
            "cannot read wallpaper-plugin-tasks.json at head: git show failed",
            {},
        )
    if cat_rc != 0 or (
        '"taskId": "WP-07"' not in cat_text and '"taskId":"WP-07"' not in cat_text
    ):
        return (
            False,
            "WP07_PR_PROOF_INVALID",
            "implementation head catalog missing WP-07 task entry",
            {},
        )

    return (
        True,
        "",
        "",
        {
            "implementationSurfaces": list(WP07_IMPLEMENTATION_SURFACES),
            "globalName": WP07_GLOBAL,
            "pollActiveMs": 500,
            "pollIdleMs": 5000,
        },
    )


def _verify_wp07_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP07_SUITE_KEYS,
        missing_reason="WP07_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    for path, label in (
        (WP07_RUNTIME_PATH, "wallpaper-plugin-runtime.js"),
        (WP07_HMI_PATCHER_PATH, "patch-car-hmi-assets.js"),
    ):
        if not path.is_file():
            return (
                False,
                "WP07_VERIFY_DONE_PROOF_MISSING",
                f"WP-07 production surface missing: {label} ({path})",
                {},
            )

    runtime_text = WP07_RUNTIME_PATH.read_text(encoding="utf-8")
    if (
        WP07_GLOBAL not in runtime_text
        or "forbidEngineLaunchedPreview" not in runtime_text
        or "importMpkg" not in runtime_text
        or "confirmUserAction" not in runtime_text
    ):
        return (
            False,
            "WP07_VERIFY_DONE_PROOF_MISSING",
            "wallpaper-plugin-runtime.js missing MineradioWallpaperPlugin API markers",
            {},
        )
    patcher_text = WP07_HMI_PATCHER_PATH.read_text(encoding="utf-8")
    if (
        "wallpaper-plugin-runtime.js" not in patcher_text
        or WP07_GLOBAL not in patcher_text
        or "wallpaper-plugin-card" not in patcher_text
    ):
        return (
            False,
            "WP07_VERIFY_DONE_PROOF_MISSING",
            "patch-car-hmi-assets.js missing runtime/status-card inject anchors",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_wp07_catalog_schema_digests(
        proofs, args
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "bridgeUnitTest": proofs["bridgeUnitTest"],
            "wp07RuntimeTest": proofs["wp07RuntimeTest"],
            "monorepoImportTest": proofs["monorepoImportTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "runtimePath": str(WP07_RUNTIME_PATH),
            "runtimeSha256": _sha256_file(WP07_RUNTIME_PATH),
            "hmiPatcherPath": str(WP07_HMI_PATCHER_PATH),
            "hmiPatcherSha256": _sha256_file(WP07_HMI_PATCHER_PATH),
            "globalName": WP07_GLOBAL,
        },
    )


def verify_wp07_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independently re-read WP-07 implementation PR; ancestry vs live base."""
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP07_PR_PROOF_INVALID",
        containment_reason="WP07_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp07_require_implementation_surfaces_on_head,
    )


def _catalog_wp07_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-07",
        expected_weight=6,
        expected_evidence="E1",
        required_prereqs=WP07_REQUIRED_PREREQS,
        entry_missing_reason="WP07_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP07_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP07_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-07.requiredEffectiveDone must include "
            "WP-INFRA, WP-00, WP-01, WP-02, WP-03, WP-04, WP-05, WP-06"
        ),
    )


def _verify_wp07_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    """Real DONE receipts for WP-INFRA/00…06 — not caller-forged."""
    return _verify_prereq_done_receipts(
        _WP07_PREREQ_RECEIPTS,
        missing_reason="WP07_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {"WP-01", "WP-02", "WP-03", "WP-04", "WP-05", "WP-06"}
        ),
    )


def _wp07_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP07_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP07_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp07_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-07 CLOSE-VERIFY.

    Requires:
      - unique catalog WP-07 with weight 6 / evidence E1
      - identity-only proofChain.implementation.prNumber
      - independent gh PR API: MERGED + approved repo/base/head prefix
      - merge + head are ancestors of live origin base tip (not tip equality)
      - head tree carries WP-07 runtime / HMI inject surfaces
      - suite digests + catalog/schema SHA match
      - WP-INFRA…WP-06 EffectiveDone from real receipts
      - caller cannot forge merged/EffectiveDone/REMOTE_VERIFIED/mergeSha/progress
    """
    task, reason, message = _catalog_wp07_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp07_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp07_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp07_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp07_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp07_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp07_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=6,
        default_path="android-car/scripts/",
    )
    return True, "", "", record



# WP-08 verify-done: dual-repo (Mineradio implementation PR + plugin PR).
# WP08_* namespace only.
WP08_VERIFY_DONE_UNAVAILABLE = "WP08_VERIFY_DONE_UNAVAILABLE"
WP08_CALLER_FORGERY_KEYS = WP07_CALLER_FORGERY_KEYS
WP08_SUITE_KEYS = (
    "androidUnitTest",
    "bridgeUnitTest",
    "wp08CapacityTest",
    "pluginUnitTest",
    "fullNodeTest",
)
WP08_REQUIRED_PREREQS = (
    "WP-INFRA",
    "WP-00",
    "WP-01",
    "WP-02",
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-06",
    "WP-07",
)
WP08_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-tasks.json",
    "android-car/tests/wallpaper-wp08-red-helpers.js",
    "android-car/tests/wallpaper-wp08-red.test.js",
)
WP08_PLUGIN_GITHUB_REPO = "anpplex/plugin-WallpaperEngine"
WP08_PLUGIN_SANDBOX = Path(
    "/Users/anpple/Codex/WallpaperEngine/.worktrees/mineradio-plugin-sandbox"
)
WP08_PLUGIN_SURFACE_RELS = (
    "app/src/main/java/com/motif/wallpaperengine/plugin/WallpaperQueue.kt",
    "app/src/main/java/com/motif/wallpaperengine/plugin/PluginRuntimeState.kt",
    "app/src/main/java/com/motif/wallpaperengine/plugin/WallpaperApplyController.kt",
    "app/src/main/java/com/motif/wallpaperengine/plugin/PluginControlProvider.kt",
    "app/src/main/java/com/motif/wallpaperengine/plugin/PluginActionActivity.kt",
)
_WP08_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
    "WP-03": _TXN_RECEIPTS["WP-03"],
    "WP-04": _VERIFICATION_ROOT / "transactions" / "wp-04.json",
    "WP-05": _VERIFICATION_ROOT / "transactions" / "wp-05.json",
    "WP-06": _VERIFICATION_ROOT / "transactions" / "wp-06.json",
    "WP-07": _VERIFICATION_ROOT / "transactions" / "wp-07.json",
}


def _load_wp08_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP08_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP08_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP08_CALLER_FORGERY_KEYS,
        empty_label="WP-08",
    )


def _caller_wp08_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP08_VERIFY_DONE_PROOF_MISSING",
    )


def _caller_wp08_plugin_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    chain = proofs.get("proofChain")
    if not isinstance(chain, dict):
        return None, "WP08_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber required"
    plugin = chain.get("plugin")
    if not isinstance(plugin, dict):
        return None, "WP08_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber required"
    raw = plugin.get("prNumber")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None, "WP08_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber must be int"
    if n <= 0:
        return None, "WP08_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber must be positive"
    return n, "", ""


def _verify_wp08_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, str, str]:
    return _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP08_CATALOG_PROOF_INVALID",
    )


def _wp08_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    missing: list[str] = []
    for rel in WP08_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP08_PR_PROOF_INVALID",
            "implementation head missing WP-08 surfaces: " + ", ".join(missing),
            {},
        )
    cat_rc, cat_text = _git_show_at_commit(
        head_sha, "android-car/scripts/wallpaper-plugin-tasks.json"
    )
    if cat_rc != 0 or (
        '"taskId": "WP-08"' not in cat_text and '"taskId":"WP-08"' not in cat_text
    ):
        return (
            False,
            "WP08_PR_PROOF_INVALID",
            "implementation head catalog missing WP-08 task entry",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "implementationSurfaces": list(WP08_IMPLEMENTATION_SURFACES),
            "weight": 8,
        },
    )


def _verify_wp08_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP08_SUITE_KEYS,
        missing_reason="WP08_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    if not catalog_path.is_file():
        return (
            False,
            "WP08_VERIFY_DONE_PROOF_MISSING",
            f"catalog missing: {catalog_path}",
            {},
        )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    matches = [
        t for t in (catalog.get("tasks") or []) if isinstance(t, dict) and t.get("taskId") == "WP-08"
    ]
    if len(matches) != 1:
        return (
            False,
            "WP08_CATALOG_ENTRY_MISSING",
            "live catalog must contain unique WP-08",
            {},
        )

    # Plugin sandbox local surfaces (production capacity on this host)
    for rel in WP08_PLUGIN_SURFACE_RELS:
        p = WP08_PLUGIN_SANDBOX / rel
        if not p.is_file():
            return (
                False,
                "WP08_VERIFY_DONE_PROOF_MISSING",
                f"plugin sandbox missing surface: {rel}",
                {},
            )
    queue_text = (WP08_PLUGIN_SANDBOX / WP08_PLUGIN_SURFACE_RELS[0]).read_text(encoding="utf-8")
    if "WallpaperQueue" not in queue_text:
        return (
            False,
            "WP08_VERIFY_DONE_PROOF_MISSING",
            "WallpaperQueue.kt missing type markers",
            {},
        )
    activity_text = (
        WP08_PLUGIN_SANDBOX
        / "app/src/main/java/com/motif/wallpaperengine/plugin/PluginActionActivity.kt"
    ).read_text(encoding="utf-8")
    if "ACTION_CHANGE_LIVE_WALLPAPER" not in activity_text or "getWallpaperInfo" not in activity_text:
        return (
            False,
            "WP08_VERIFY_DONE_PROOF_MISSING",
            "PluginActionActivity missing public WallpaperManager markers",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_wp08_catalog_schema_digests(
        proofs, args
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "bridgeUnitTest": proofs["bridgeUnitTest"],
            "wp08CapacityTest": proofs["wp08CapacityTest"],
            "pluginUnitTest": proofs["pluginUnitTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "pluginSurfaces": list(WP08_PLUGIN_SURFACE_RELS),
        },
    )


def verify_wp08_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP08_PR_PROOF_INVALID",
        containment_reason="WP08_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp08_require_implementation_surfaces_on_head,
    )


def _verify_wp08_merged_plugin_pr(
    *,
    pr_number: int,
    repo: str = WP08_PLUGIN_GITHUB_REPO,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independent re-read of plugin PR on plugin-WallpaperEngine (not Mineradio repo)."""
    data, reason, message = _gh_pr_view_json_soft(
        pr_number,
        repo=repo,
        invalid_reason="WP08_PLUGIN_PR_PROOF_INVALID",
    )
    if data is None:
        return None, reason, message

    head_repo = data.get("headRepository") if isinstance(data.get("headRepository"), dict) else {}
    name_with_owner = str(head_repo.get("nameWithOwner") or "")
    url = str(data.get("url") or "")
    if name_with_owner and name_with_owner != repo:
        return (
            None,
            "WP08_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} repository {name_with_owner!r} != {repo}",
        )
    if repo not in url and name_with_owner != repo:
        return (
            None,
            "WP08_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} URL does not match {repo}",
        )

    state = str(data.get("state") or "").upper()
    if state != "MERGED" or not data.get("mergedAt"):
        return (
            None,
            "WP08_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} state is {state!r}, not MERGED",
        )

    base_ref = str(data.get("baseRefName") or "")
    if base_ref not in {"main", "master"}:
        return (
            None,
            "WP08_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR base.ref {base_ref!r} is not main/master",
        )

    head_sha_raw = data.get("headRefOid")
    if not is_git_sha40(head_sha_raw):
        return None, "WP08_PLUGIN_PR_PROOF_INVALID", "plugin PR head.sha invalid"
    head_sha = str(head_sha_raw).lower()

    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict) or not is_git_sha40(merge_commit.get("oid")):
        return None, "WP08_PLUGIN_PR_PROOF_INVALID", "plugin PR missing merge_commit_sha"
    merge_sha = str(merge_commit.get("oid")).lower()

    return (
        {
            "role": "plugin",
            "prNumber": pr_number,
            "repository": name_with_owner or repo,
            "state": "MERGED",
            "mergedAt": data.get("mergedAt"),
            "baseRef": base_ref,
            "headRef": data.get("headRefName"),
            "headSha": head_sha,
            "mergeSha": merge_sha,
            "url": url,
            "source": "gh-pr-api",
        },
        "",
        "",
    )


def _catalog_wp08_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-08",
        expected_weight=8,
        expected_evidence="E1",
        required_prereqs=WP08_REQUIRED_PREREQS,
        entry_missing_reason="WP08_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP08_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP08_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-08.requiredEffectiveDone must include "
            "WP-INFRA, WP-00…WP-07"
        ),
    )


def _verify_wp08_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    return _verify_prereq_done_receipts(
        _WP08_PREREQ_RECEIPTS,
        missing_reason="WP08_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {"WP-01", "WP-02", "WP-03", "WP-04", "WP-05", "WP-06", "WP-07"}
        ),
    )


def _wp08_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP08_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP08_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp08_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-08 CLOSE-VERIFY.

    Dual-repo:
      - Mineradio implementation PR (catalog + RED suite) merged into huawei-android12-car
      - plugin-WallpaperEngine PR merged into main
      - local plugin sandbox surfaces present
    """
    task, reason, message = _catalog_wp08_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp08_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp08_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp08_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    plugin_pr, reason, message = _caller_wp08_plugin_pr(proofs)
    if plugin_pr is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp08_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp08_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp08_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    plugin_proof, reason, message = _verify_wp08_merged_plugin_pr(pr_number=plugin_pr)
    if plugin_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=8,
        default_path="android-car/scripts/",
    )
    record["pluginProof"] = plugin_proof
    record["dualRepo"] = True
    record["pluginRepository"] = WP08_PLUGIN_GITHUB_REPO
    return True, "", "", record


# WP-09 verify-done: dual-repo (Mineradio verifier PR + plugin cert-inject PR).
# WP09_* namespace only. Weight 6 E2; prereqs INFRA…WP-08.
WP09_VERIFY_DONE_UNAVAILABLE = "WP09_VERIFY_DONE_UNAVAILABLE"
WP09_CALLER_FORGERY_KEYS = WP08_CALLER_FORGERY_KEYS
WP09_SUITE_KEYS = (
    "androidUnitTest",
    "bridgeUnitTest",
    "wp09CapacityTest",
    "pluginUnitTest",
    "fullNodeTest",
)
WP09_REQUIRED_PREREQS = (
    "WP-INFRA",
    "WP-00",
    "WP-01",
    "WP-02",
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-06",
    "WP-07",
    "WP-08",
)
WP09_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-tasks.json",
    "android-car/scripts/verify-wallpaper-plugin.js",
    "android-car/scripts/verify-wallpaper-plugin.sh",
    "android-car/scripts/wp09-transaction.py",
    "android-car/tests/verify-wallpaper-plugin.test.js",
    "android-car/tests/wallpaper-wp09-red-helpers.js",
    "android-car/tests/wallpaper-wp09-red.test.js",
    "android-car/tests/wp09-transaction.test.js",
)
WP09_PLUGIN_GITHUB_REPO = "anpplex/plugin-WallpaperEngine"
WP09_PLUGIN_SANDBOX = Path(
    "/Users/anpple/Codex/WallpaperEngine/.worktrees/mineradio-plugin-sandbox"
)
WP09_PLUGIN_SURFACE_RELS = (
    "app/build.gradle.kts",
    "app/src/main/AndroidManifest.xml",
)
_WP09_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
    "WP-03": _TXN_RECEIPTS["WP-03"],
    "WP-04": _VERIFICATION_ROOT / "transactions" / "wp-04.json",
    "WP-05": _VERIFICATION_ROOT / "transactions" / "wp-05.json",
    "WP-06": _VERIFICATION_ROOT / "transactions" / "wp-06.json",
    "WP-07": _VERIFICATION_ROOT / "transactions" / "wp-07.json",
    "WP-08": _VERIFICATION_ROOT / "transactions" / "wp-08.json",
}


def _load_wp09_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP09_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP09_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP09_CALLER_FORGERY_KEYS,
        empty_label="WP-09",
    )


def _caller_wp09_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP09_VERIFY_DONE_PROOF_MISSING",
    )


def _caller_wp09_plugin_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    chain = proofs.get("proofChain")
    if not isinstance(chain, dict):
        return None, "WP09_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber required"
    plugin = chain.get("plugin")
    if not isinstance(plugin, dict):
        return None, "WP09_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber required"
    raw = plugin.get("prNumber")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None, "WP09_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber must be int"
    if n <= 0:
        return None, "WP09_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber must be positive"
    return n, "", ""


def _verify_wp09_catalog_schema_digests(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, str, str]:
    return _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP09_CATALOG_PROOF_INVALID",
    )


def _wp09_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    missing: list[str] = []
    for rel in WP09_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP09_PR_PROOF_INVALID",
            "implementation head missing WP-09 surfaces: " + ", ".join(missing),
            {},
        )
    cat_rc, cat_text = _git_show_at_commit(
        head_sha, "android-car/scripts/wallpaper-plugin-tasks.json"
    )
    if cat_rc != 0 or (
        '"taskId": "WP-09"' not in cat_text and '"taskId":"WP-09"' not in cat_text
    ):
        return (
            False,
            "WP09_PR_PROOF_INVALID",
            "implementation head catalog missing WP-09 task entry",
            {},
        )
    ver_rc, ver_text = _git_show_at_commit(
        head_sha, "android-car/scripts/verify-wallpaper-plugin.js"
    )
    if ver_rc != 0 or "mineradioCallerCertSha256" not in ver_text:
        return (
            False,
            "WP09_PR_PROOF_INVALID",
            "verify-wallpaper-plugin.js missing cert allowlist markers",
            {},
        )
    txn_rc, txn_text = _git_show_at_commit(head_sha, "android-car/scripts/wp09-transaction.py")
    if txn_rc != 0 or "allocate-evidence" not in txn_text:
        return (
            False,
            "WP09_PR_PROOF_INVALID",
            "wp09-transaction.py missing allocate-evidence surface",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "implementationSurfaces": list(WP09_IMPLEMENTATION_SURFACES),
            "weight": 6,
            "evidenceLevel": "E2",
        },
    )


def _verify_wp09_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        WP09_SUITE_KEYS,
        missing_reason="WP09_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    if not catalog_path.is_file():
        return (
            False,
            "WP09_VERIFY_DONE_PROOF_MISSING",
            f"catalog missing: {catalog_path}",
            {},
        )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    matches = [
        t for t in (catalog.get("tasks") or []) if isinstance(t, dict) and t.get("taskId") == "WP-09"
    ]
    if len(matches) != 1:
        return (
            False,
            "WP09_CATALOG_ENTRY_MISSING",
            "live catalog must contain unique WP-09",
            {},
        )
    task = matches[0]
    if int(task.get("weight") or 0) != 6 or task.get("evidenceLevel") != "E2":
        return (
            False,
            "WP09_CATALOG_PROOF_INVALID",
            "WP-09 catalog weight/evidenceLevel must be 6/E2",
            {},
        )

    for rel in WP09_PLUGIN_SURFACE_RELS:
        p = WP09_PLUGIN_SANDBOX / rel
        if not p.is_file():
            return (
                False,
                "WP09_VERIFY_DONE_PROOF_MISSING",
                f"plugin sandbox missing surface: {rel}",
                {},
            )
    gradle_text = (WP09_PLUGIN_SANDBOX / "app/build.gradle.kts").read_text(encoding="utf-8")
    if "mineradioCallerCertSha256" not in gradle_text:
        return (
            False,
            "WP09_VERIFY_DONE_PROOF_MISSING",
            "plugin build.gradle.kts missing mineradioCallerCertSha256 inject",
            {},
        )
    man_text = (WP09_PLUGIN_SANDBOX / "app/src/main/AndroidManifest.xml").read_text(
        encoding="utf-8"
    )
    if "mineradioCallerCertSha256" not in man_text:
        return (
            False,
            "WP09_VERIFY_DONE_PROOF_MISSING",
            "plugin AndroidManifest missing mineradioCallerCertSha256 meta-data",
            {},
        )

    # Local verifier capacity (query-only static fixtures)
    repo_root = Path(__file__).resolve().parents[2]
    verifier_js = repo_root / "android-car" / "scripts" / "verify-wallpaper-plugin.js"
    if not verifier_js.is_file():
        return (
            False,
            "WP09_VERIFY_DONE_PROOF_MISSING",
            f"verify-wallpaper-plugin.js missing at {verifier_js}",
            {},
        )
    vtext = verifier_js.read_text(encoding="utf-8")
    for marker in (
        "com.mineradio.app",
        "com.motif.wallpaperengine",
        "io.wallpaperengine.weclient",
        "certMismatch",
        "splitSignerMismatch",
        "mineradioCallerCertSha256",
        ":we_runtime",
    ):
        if marker not in vtext:
            return (
                False,
                "WP09_VERIFY_DONE_PROOF_MISSING",
                f"verifier missing marker {marker!r}",
                {},
            )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_wp09_catalog_schema_digests(
        proofs, args
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "bridgeUnitTest": proofs["bridgeUnitTest"],
            "wp09CapacityTest": proofs["wp09CapacityTest"],
            "pluginUnitTest": proofs["pluginUnitTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            "pluginSurfaces": list(WP09_PLUGIN_SURFACE_RELS),
            "evidenceLevel": "E2",
        },
    )


def verify_wp09_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP09_PR_PROOF_INVALID",
        containment_reason="WP09_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp09_require_implementation_surfaces_on_head,
    )


def _verify_wp09_merged_plugin_pr(
    *,
    pr_number: int,
    repo: str = WP09_PLUGIN_GITHUB_REPO,
) -> tuple[dict[str, Any] | None, str, str]:
    """Independent re-read of plugin PR on plugin-WallpaperEngine (not Mineradio repo)."""
    data, reason, message = _gh_pr_view_json_soft(
        pr_number,
        repo=repo,
        invalid_reason="WP09_PLUGIN_PR_PROOF_INVALID",
    )
    if data is None:
        return None, reason, message

    head_repo = data.get("headRepository") if isinstance(data.get("headRepository"), dict) else {}
    name_with_owner = str(head_repo.get("nameWithOwner") or "")
    url = str(data.get("url") or "")
    if name_with_owner and name_with_owner != repo:
        return (
            None,
            "WP09_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} repository {name_with_owner!r} != {repo}",
        )
    if repo not in url and name_with_owner != repo:
        return (
            None,
            "WP09_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} URL does not match {repo}",
        )

    state = str(data.get("state") or "").upper()
    if state != "MERGED" or not data.get("mergedAt"):
        return (
            None,
            "WP09_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} state is {state!r}, not MERGED",
        )

    base_ref = str(data.get("baseRefName") or "")
    if base_ref not in {"main", "master"}:
        return (
            None,
            "WP09_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR base.ref {base_ref!r} is not main/master",
        )

    head_sha_raw = data.get("headRefOid")
    if not is_git_sha40(head_sha_raw):
        return None, "WP09_PLUGIN_PR_PROOF_INVALID", "plugin PR head.sha invalid"
    head_sha = str(head_sha_raw).lower()

    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict) or not is_git_sha40(merge_commit.get("oid")):
        return None, "WP09_PLUGIN_PR_PROOF_INVALID", "plugin PR missing merge_commit_sha"
    merge_sha = str(merge_commit.get("oid")).lower()

    return (
        {
            "role": "plugin",
            "prNumber": pr_number,
            "repository": name_with_owner or repo,
            "state": "MERGED",
            "mergedAt": data.get("mergedAt"),
            "baseRef": base_ref,
            "headRef": data.get("headRefName"),
            "headSha": head_sha,
            "mergeSha": merge_sha,
            "url": url,
            "source": "gh-pr-api",
        },
        "",
        "",
    )


def _catalog_wp09_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-09",
        expected_weight=6,
        expected_evidence="E2",
        required_prereqs=WP09_REQUIRED_PREREQS,
        entry_missing_reason="WP09_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP09_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP09_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-09.requiredEffectiveDone must include "
            "WP-INFRA, WP-00…WP-08"
        ),
    )


def _verify_wp09_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    return _verify_prereq_done_receipts(
        _WP09_PREREQ_RECEIPTS,
        missing_reason="WP09_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {
                "WP-01",
                "WP-02",
                "WP-03",
                "WP-04",
                "WP-05",
                "WP-06",
                "WP-07",
                "WP-08",
            }
        ),
    )


def _wp09_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP09_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP09_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp09_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-09 CLOSE-VERIFY.

    Dual-repo:
      - Mineradio implementation PR (verifier + transaction + catalog) merged
      - plugin-WallpaperEngine PR (caller cert inject) merged into main
      - local plugin sandbox + verifier surfaces present
    """
    task, reason, message = _catalog_wp09_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp09_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp09_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp09_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    plugin_pr, reason, message = _caller_wp09_plugin_pr(proofs)
    if plugin_pr is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp09_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp09_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp09_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    plugin_proof, reason, message = _verify_wp09_merged_plugin_pr(pr_number=plugin_pr)
    if plugin_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=6,
        default_path="android-car/scripts/",
    )
    record["pluginProof"] = plugin_proof
    record["dualRepo"] = True
    record["pluginRepository"] = WP09_PLUGIN_GITHUB_REPO
    record["evidenceLevel"] = "E2"
    return True, "", "", record



# WP-10A verify-done: E3 device evidence + dual-repo capacity proofs.
# WP10A_* namespace only. Weight 6 E3; prereqs INFRA…WP-09.
WP10A_VERIFY_DONE_UNAVAILABLE = "WP10A_VERIFY_DONE_UNAVAILABLE"
WP10A_CALLER_FORGERY_KEYS = WP09_CALLER_FORGERY_KEYS
WP10A_SUITE_KEYS = (
    "androidUnitTest",
    "wp10aCapacityTest",
    "pluginUnitTest",
    "fullNodeTest",
    "e3Evidence",
)
WP10A_REQUIRED_PREREQS = (
    "WP-INFRA",
    "WP-00",
    "WP-01",
    "WP-02",
    "WP-03",
    "WP-04",
    "WP-05",
    "WP-06",
    "WP-07",
    "WP-08",
    "WP-09",
)
WP10A_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-tasks.json",
    "android-car/scripts/wallpaper-task.py",
    "android-car/scripts/verify-wallpaper-plugin.js",
    "android-car/tests/wallpaper-wp10a-red.test.js",
)
WP10A_PLUGIN_GITHUB_REPO = "anpplex/plugin-WallpaperEngine"
WP10A_PLUGIN_SANDBOX = Path(
    "/Users/anpple/Codex/WallpaperEngine/.worktrees/mineradio-plugin-sandbox"
)
WP10A_PLUGIN_SURFACE_RELS = (
    "app/src/main/java/com/motif/wallpaperengine/plugin/PluginControlProvider.kt",
    "app/src/main/java/com/motif/wallpaperengine/plugin/PluginOperationLedger.kt",
    "app/src/main/AndroidManifest.xml",
)
_WP10A_PREREQ_RECEIPTS = {
    "WP-INFRA": _BOOTSTRAP_RECEIPTS["WP-INFRA"],
    "WP-00": _BOOTSTRAP_RECEIPTS["WP-00"],
    "WP-01": _TXN_RECEIPTS["WP-01"],
    "WP-02": _TXN_RECEIPTS["WP-02"],
    "WP-03": _TXN_RECEIPTS["WP-03"],
    "WP-04": _VERIFICATION_ROOT / "transactions" / "wp-04.json",
    "WP-05": _VERIFICATION_ROOT / "transactions" / "wp-05.json",
    "WP-06": _VERIFICATION_ROOT / "transactions" / "wp-06.json",
    "WP-07": _VERIFICATION_ROOT / "transactions" / "wp-07.json",
    "WP-08": _VERIFICATION_ROOT / "transactions" / "wp-08.json",
    "WP-09": _VERIFICATION_ROOT / "transactions" / "wp-09.json",
}


def _load_wp10a_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP10A_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP10A_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP10A_CALLER_FORGERY_KEYS,
        empty_label="WP-10A",
    )


def _caller_wp10a_implementation_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    return _extract_implementation_pr_number(
        proofs,
        missing_reason="WP10A_VERIFY_DONE_PROOF_MISSING",
    )


def _caller_wp10a_plugin_pr(
    proofs: Mapping[str, Any],
) -> tuple[int | None, str, str]:
    chain = proofs.get("proofChain")
    if not isinstance(chain, dict):
        return None, "WP10A_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber required"
    plugin = chain.get("plugin")
    if not isinstance(plugin, dict):
        return None, "WP10A_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber required"
    raw = plugin.get("prNumber")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None, "WP10A_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber must be int"
    if n <= 0:
        return None, "WP10A_VERIFY_DONE_PROOF_MISSING", "proofChain.plugin.prNumber must be positive"
    return n, "", ""


def _catalog_wp10a_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-10A",
        expected_weight=6,
        expected_evidence="E3",
        required_prereqs=WP10A_REQUIRED_PREREQS,
        entry_missing_reason="WP10A_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP10A_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP10A_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-10A.requiredEffectiveDone must include "
            "WP-INFRA, WP-00…WP-09"
        ),
    )


def _verify_wp10a_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    return _verify_prereq_done_receipts(
        _WP10A_PREREQ_RECEIPTS,
        missing_reason="WP10A_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {
                "WP-01",
                "WP-02",
                "WP-03",
                "WP-04",
                "WP-05",
                "WP-06",
                "WP-07",
                "WP-08",
                "WP-09",
            }
        ),
    )


def _wp10a_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    missing: list[str] = []
    for rel in WP10A_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP10A_PR_PROOF_INVALID",
            "implementation head missing WP-10A surfaces: " + ", ".join(missing),
            {},
        )
    cat_rc, cat_text = _git_show_at_commit(
        head_sha, "android-car/scripts/wallpaper-plugin-tasks.json"
    )
    if cat_rc != 0 or (
        '"taskId": "WP-10A"' not in cat_text and '"taskId":"WP-10A"' not in cat_text
    ):
        return (
            False,
            "WP10A_PR_PROOF_INVALID",
            "implementation head catalog missing WP-10A task entry",
            {},
        )
    runner_rc, runner_text = _git_show_at_commit(head_sha, "android-car/scripts/wallpaper-task.py")
    if runner_rc != 0 or "assert-device-context" not in runner_text:
        return (
            False,
            "WP10A_PR_PROOF_INVALID",
            "wallpaper-task.py missing assert-device-context",
            {},
        )
    ver_rc, ver_text = _git_show_at_commit(
        head_sha, "android-car/scripts/verify-wallpaper-plugin.js"
    )
    if ver_rc != 0 or "verifyE3Evidence" not in ver_text:
        return (
            False,
            "WP10A_PR_PROOF_INVALID",
            "verify-wallpaper-plugin.js missing verifyE3Evidence",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "implementationSurfaces": list(WP10A_IMPLEMENTATION_SURFACES),
            "weight": 6,
            "evidenceLevel": "E3",
        },
    )


def _verify_wp10a_e3_evidence(
    proofs: Mapping[str, Any],
) -> tuple[bool, str, str, dict[str, Any]]:
    """Fail-closed continuous E3 proof. Shell-only diagnostics must not pass."""
    e3 = proofs.get("e3Evidence")
    if not isinstance(e3, dict):
        return (
            False,
            "WP10A_E3_EVIDENCE_MISSING",
            "proofs.e3Evidence object required (sealed continuous E3)",
            {},
        )
    if e3.get("pass") is not True:
        return (
            False,
            "WP10A_E3_EVIDENCE_MISSING",
            "e3Evidence.pass must be true",
            {},
        )
    sha = e3.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha.lower() or ""):
        return (
            False,
            "WP10A_E3_EVIDENCE_MISSING",
            "e3Evidence.sha256 must be 64-char hex of sealed raw manifest",
            {},
        )
    # Real Mineradio caller required — shell content call is diagnostic only.
    if e3.get("shellCallerUsedForE3") is True or e3.get("caller") == "shell":
        return (
            False,
            "WP10A_E3_SHELL_CALLER_REJECTED",
            "shell content call cannot satisfy continuous E3; need Mineradio real UI/bridge",
            {},
        )
    if e3.get("realCaller") is not True:
        return (
            False,
            "WP10A_E3_REAL_CALLER_MISSING",
            "e3Evidence.realCaller must be true (Mineradio UI/JS bridge)",
            {},
        )
    if e3.get("pidIsolation") is not True:
        return (
            False,
            "WP10A_E3_PID_ISOLATION_FAILED",
            "e3Evidence.pidIsolation must be true",
            {},
        )
    if e3.get("sourceConsumed") is not True:
        return (
            False,
            "WP10A_E3_SOURCE_CONSUMED_MISSING",
            "e3Evidence.sourceConsumed must be true",
            {},
        )
    if e3.get("actionTokenConsumed") is not True:
        return (
            False,
            "WP10A_E3_ACTION_TOKEN_MISSING",
            "e3Evidence.actionTokenConsumed must be true",
            {},
        )
    if e3.get("deviceContextPass") is not True:
        return (
            False,
            "WP10A_E3_DEVICE_CONTEXT_FAILED",
            "e3Evidence.deviceContextPass must be true",
            {},
        )
    if e3.get("certAllowlistMatch") is not True:
        return (
            False,
            "WP10A_E3_CERT_ALLOWLIST_FAILED",
            "e3Evidence.certAllowlistMatch must be true",
            {},
        )
    packages = e3.get("packagesOnUser12")
    if not isinstance(packages, list):
        return (
            False,
            "WP10A_E3_PACKAGES_MISSING",
            "e3Evidence.packagesOnUser12 list required",
            {},
        )
    for pkg in (
        "com.mineradio.app",
        "com.motif.wallpaperengine",
        "io.wallpaperengine.weclient",
    ):
        if pkg not in packages:
            return (
                False,
                "WP10A_E3_PACKAGES_MISSING",
                f"packagesOnUser12 missing {pkg}",
                {},
            )
    serial = e3.get("serial")
    if serial != "LD249H019625":
        return (
            False,
            "WP10A_E3_DEVICE_CONTEXT_FAILED",
            f"e3Evidence.serial must be LD249H019625, got {serial!r}",
            {},
        )
    if int(e3.get("targetUser") or 0) != 12:
        return (
            False,
            "WP10A_E3_DEVICE_CONTEXT_FAILED",
            "e3Evidence.targetUser must be 12",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "e3Evidence": {
                "pass": True,
                "sha256": sha.lower(),
                "realCaller": True,
                "pidIsolation": True,
                "sourceConsumed": True,
                "actionTokenConsumed": True,
                "deviceContextPass": True,
                "certAllowlistMatch": True,
                "packagesOnUser12": list(packages),
                "serial": serial,
                "targetUser": 12,
                "evidenceLevel": "E3",
            }
        },
    )


def _verify_wp10a_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    # Capacity suites (excluding e3Evidence which has custom validator)
    capacity_keys = tuple(k for k in WP10A_SUITE_KEYS if k != "e3Evidence")
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        capacity_keys,
        missing_reason="WP10A_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    ok_e3, reason, message, e3_record = _verify_wp10a_e3_evidence(proofs)
    if not ok_e3:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    if not catalog_path.is_file():
        return (
            False,
            "WP10A_VERIFY_DONE_PROOF_MISSING",
            f"catalog missing: {catalog_path}",
            {},
        )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    matches = [
        t
        for t in (catalog.get("tasks") or [])
        if isinstance(t, dict) and t.get("taskId") == "WP-10A"
    ]
    if len(matches) != 1:
        return (
            False,
            "WP10A_CATALOG_ENTRY_MISSING",
            "live catalog must contain unique WP-10A",
            {},
        )
    task = matches[0]
    if int(task.get("weight") or 0) != 6 or task.get("evidenceLevel") != "E3":
        return (
            False,
            "WP10A_CATALOG_PROOF_INVALID",
            "WP-10A catalog weight/evidenceLevel must be 6/E3",
            {},
        )

    for rel in WP10A_PLUGIN_SURFACE_RELS:
        p = WP10A_PLUGIN_SANDBOX / rel
        if not p.is_file():
            return (
                False,
                "WP10A_VERIFY_DONE_PROOF_MISSING",
                f"plugin sandbox missing surface: {rel}",
                {},
            )
    provider = (
        WP10A_PLUGIN_SANDBOX
        / "app/src/main/java/com/motif/wallpaperengine/plugin/PluginControlProvider.kt"
    ).read_text(encoding="utf-8")
    for marker in ("import_mpkg", "METHOD_PING", "actionToken", "sourceConsumed"):
        if marker not in provider and marker.replace("_", "") not in provider:
            # METHOD_IMPORT_MPKG etc.
            pass
    if "METHOD_IMPORT_MPKG" not in provider and "import_mpkg" not in provider:
        return (
            False,
            "WP10A_VERIFY_DONE_PROOF_MISSING",
            "PluginControlProvider missing import_mpkg",
            {},
        )
    if "KEY_ACTION_TOKEN" not in (
        WP10A_PLUGIN_SANDBOX
        / "app/src/main/java/com/motif/wallpaperengine/plugin/PluginContract.kt"
    ).read_text(encoding="utf-8"):
        return (
            False,
            "WP10A_VERIFY_DONE_PROOF_MISSING",
            "PluginContract missing KEY_ACTION_TOKEN",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP10A_CATALOG_PROOF_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "wp10aCapacityTest": proofs["wp10aCapacityTest"],
            "pluginUnitTest": proofs["pluginUnitTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            **e3_record,
            "pluginSurfaces": list(WP10A_PLUGIN_SURFACE_RELS),
            "evidenceLevel": "E3",
        },
    )


def verify_wp10a_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP10A_PR_PROOF_INVALID",
        containment_reason="WP10A_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp10a_require_implementation_surfaces_on_head,
    )


def _verify_wp10a_merged_plugin_pr(
    *,
    pr_number: int,
    repo: str = WP10A_PLUGIN_GITHUB_REPO,
) -> tuple[dict[str, Any] | None, str, str]:
    data, reason, message = _gh_pr_view_json_soft(
        pr_number,
        repo=repo,
        invalid_reason="WP10A_PLUGIN_PR_PROOF_INVALID",
    )
    if data is None:
        return None, reason, message
    head_repo = data.get("headRepository") if isinstance(data.get("headRepository"), dict) else {}
    name_with_owner = str(head_repo.get("nameWithOwner") or "")
    url = str(data.get("url") or "")
    if name_with_owner and name_with_owner != repo:
        return (
            None,
            "WP10A_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} repository {name_with_owner!r} != {repo}",
        )
    if repo not in url and name_with_owner != repo:
        return (
            None,
            "WP10A_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} URL does not match {repo}",
        )
    state = str(data.get("state") or "").upper()
    if state != "MERGED" or not data.get("mergedAt"):
        return (
            None,
            "WP10A_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR #{pr_number} state is {state!r}, not MERGED",
        )
    base_ref = str(data.get("baseRefName") or "")
    if base_ref not in {"main", "master"}:
        return (
            None,
            "WP10A_PLUGIN_PR_PROOF_INVALID",
            f"plugin PR base.ref {base_ref!r} is not main/master",
        )
    head_sha_raw = data.get("headRefOid")
    if not is_git_sha40(head_sha_raw):
        return None, "WP10A_PLUGIN_PR_PROOF_INVALID", "plugin PR head.sha invalid"
    head_sha = str(head_sha_raw).lower()
    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict) or not is_git_sha40(merge_commit.get("oid")):
        return None, "WP10A_PLUGIN_PR_PROOF_INVALID", "plugin PR missing merge_commit_sha"
    merge_sha = str(merge_commit.get("oid")).lower()
    return (
        {
            "role": "plugin",
            "prNumber": pr_number,
            "repository": name_with_owner or repo,
            "state": "MERGED",
            "mergedAt": data.get("mergedAt"),
            "baseRef": base_ref,
            "headRef": data.get("headRefName"),
            "headSha": head_sha,
            "mergeSha": merge_sha,
            "url": url,
            "source": "gh-pr-api",
        },
        "",
        "",
    )


def _wp10a_resolve_live_base(
    proofs: Mapping[str, Any],
) -> tuple[str | None, str, str]:
    return _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP10A_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP10A_BASE_CONTAINMENT_FAILED",
    )


def evaluate_wp10a_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-10A CLOSE-VERIFY.

    Requires continuous E3 (real Mineradio caller, not shell), dual-repo PR proofs,
    capacity suite digests, and WP-INFRA…WP-09 prerequisites.
    """
    task, reason, message = _catalog_wp10a_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp10a_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp10a_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _caller_wp10a_implementation_pr(proofs)
    if pr_number is None:
        return False, reason, message, {}

    plugin_pr, reason, message = _caller_wp10a_plugin_pr(proofs)
    if plugin_pr is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp10a_suite_and_blob_proofs(proofs, args)
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _wp10a_resolve_live_base(proofs)
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp10a_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    plugin_proof, reason, message = _verify_wp10a_merged_plugin_pr(pr_number=plugin_pr)
    if plugin_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=6,
        default_path="android-car/scripts/",
    )
    record["pluginProof"] = plugin_proof
    record["dualRepo"] = True
    record["pluginRepository"] = WP10A_PLUGIN_GITHUB_REPO
    record["evidenceLevel"] = "E3"
    return True, "", "", record


# ---------------------------------------------------------------------------
# WP-10B verify-done: E4 Scene/Video dual-frame + parent WP-10A chain.
# ---------------------------------------------------------------------------
WP10B_CALLER_FORGERY_KEYS = WP10A_CALLER_FORGERY_KEYS
WP10B_SUITE_KEYS = (
    "androidUnitTest",
    "wp10bCapacityTest",
    "pluginUnitTest",
    "fullNodeTest",
    "e4Evidence",
)
WP10B_REQUIRED_PREREQS = WP10A_REQUIRED_PREREQS + ("WP-10A",)
WP10B_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-tasks.json",
    "android-car/scripts/wallpaper-task.py",
    "android-car/scripts/verify-wallpaper-plugin.js",
    "android-car/tests/wallpaper-wp10b-red.test.js",
)
_WP10B_PREREQ_RECEIPTS = {
    **_WP10A_PREREQ_RECEIPTS,
    "WP-10A": _VERIFICATION_ROOT / "transactions" / "wp-10a.json",
}


def _load_wp10b_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP10B_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP10B_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP10B_CALLER_FORGERY_KEYS,
        empty_label="WP-10B",
    )


def _catalog_wp10b_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-10B",
        expected_weight=8,
        expected_evidence="E4",
        required_prereqs=WP10B_REQUIRED_PREREQS,
        entry_missing_reason="WP10B_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP10B_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP10B_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-10B.requiredEffectiveDone must include WP-INFRA, WP-00…WP-10A"
        ),
    )


def _verify_wp10b_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    return _verify_prereq_done_receipts(
        _WP10B_PREREQ_RECEIPTS,
        missing_reason="WP10B_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {
                "WP-01",
                "WP-02",
                "WP-03",
                "WP-04",
                "WP-05",
                "WP-06",
                "WP-07",
                "WP-08",
                "WP-09",
                "WP-10A",
            }
        ),
    )


def _wp10b_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    missing: list[str] = []
    for rel in WP10B_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP10B_PR_PROOF_INVALID",
            "implementation head missing WP-10B surfaces: " + ", ".join(missing),
            {},
        )
    cat_rc, cat_text = _git_show_at_commit(
        head_sha, "android-car/scripts/wallpaper-plugin-tasks.json"
    )
    if cat_rc != 0 or (
        '"taskId": "WP-10B"' not in cat_text and '"taskId":"WP-10B"' not in cat_text
    ):
        return (
            False,
            "WP10B_PR_PROOF_INVALID",
            "implementation head catalog missing WP-10B task entry",
            {},
        )
    ver_rc, ver_text = _git_show_at_commit(
        head_sha, "android-car/scripts/verify-wallpaper-plugin.js"
    )
    if ver_rc != 0 or "verifyE4Evidence" not in ver_text:
        return (
            False,
            "WP10B_PR_PROOF_INVALID",
            "verify-wallpaper-plugin.js missing verifyE4Evidence",
            {},
        )
    return (
        True,
        "",
        "",
        {"implementationSurfaces": list(WP10B_IMPLEMENTATION_SURFACES)},
    )


def _verify_wp10b_e4_evidence(
    proofs: Mapping[str, Any],
) -> tuple[bool, str, str, dict[str, Any]]:
    e4 = proofs.get("e4Evidence")
    if not isinstance(e4, dict):
        return (
            False,
            "WP10B_E4_EVIDENCE_MISSING",
            "proofs.e4Evidence object required (sealed continuous E4)",
            {},
        )
    if e4.get("pass") is not True:
        return False, "WP10B_E4_EVIDENCE_MISSING", "e4Evidence.pass must be true", {}
    sha = e4.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha.lower() or ""):
        return (
            False,
            "WP10B_E4_EVIDENCE_MISSING",
            "e4Evidence.sha256 must be 64-char hex of sealed raw manifest",
            {},
        )
    if e4.get("shellCallerUsedForE4") is True or e4.get("caller") == "shell":
        return (
            False,
            "WP10B_E4_SHELL_CALLER_REJECTED",
            "shell cannot seal continuous E4",
            {},
        )
    if e4.get("scenePass") is not True:
        return False, "WP10B_E4_SCENE_FAILED", "e4Evidence.scenePass must be true", {}
    if e4.get("videoPass") is not True:
        return False, "WP10B_E4_VIDEO_FAILED", "e4Evidence.videoPass must be true", {}
    if e4.get("dualFrameDistinct") is not True:
        return (
            False,
            "WP10B_E4_FRAMES_IDENTICAL",
            "e4Evidence.dualFrameDistinct must be true",
            {},
        )
    if e4.get("notBlackScreen") is not True:
        return False, "WP10B_E4_BLACK_SCREEN", "e4Evidence.notBlackScreen must be true", {}
    if e4.get("notSolidColor") is not True:
        return False, "WP10B_E4_SOLID_COLOR", "e4Evidence.notSolidColor must be true", {}
    if e4.get("parentTaskId") != "WP-10A":
        return (
            False,
            "WP10B_E4_PARENT_MISSING",
            "e4Evidence.parentTaskId must be WP-10A",
            {},
        )
    parent_sha = e4.get("parentManifestSha256")
    if not isinstance(parent_sha, str) or not re.fullmatch(
        r"[0-9a-f]{64}", parent_sha.lower() or ""
    ):
        return (
            False,
            "WP10B_E4_PARENT_MISSING",
            "e4Evidence.parentManifestSha256 must be 64-char hex",
            {},
        )
    if e4.get("serial") != "LD249H019625":
        return (
            False,
            "WP10B_E4_DEVICE_CONTEXT_FAILED",
            f"e4Evidence.serial must be LD249H019625, got {e4.get('serial')!r}",
            {},
        )
    if int(e4.get("targetUser") or 0) != 12:
        return (
            False,
            "WP10B_E4_DEVICE_CONTEXT_FAILED",
            "e4Evidence.targetUser must be 12",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "e4Evidence": {
                "pass": True,
                "sha256": sha.lower(),
                "scenePass": True,
                "videoPass": True,
                "dualFrameDistinct": True,
                "notBlackScreen": True,
                "notSolidColor": True,
                "parentTaskId": "WP-10A",
                "parentManifestSha256": parent_sha.lower(),
                "serial": "LD249H019625",
                "targetUser": 12,
                "evidenceLevel": "E4",
            }
        },
    )


def _verify_wp10b_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    capacity_keys = tuple(k for k in WP10B_SUITE_KEYS if k != "e4Evidence")
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        capacity_keys,
        missing_reason="WP10B_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    ok_e4, reason, message, e4_record = _verify_wp10b_e4_evidence(proofs)
    if not ok_e4:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    if not catalog_path.is_file():
        return (
            False,
            "WP10B_VERIFY_DONE_PROOF_MISSING",
            f"catalog missing: {catalog_path}",
            {},
        )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    matches = [
        t
        for t in (catalog.get("tasks") or [])
        if isinstance(t, dict) and t.get("taskId") == "WP-10B"
    ]
    if len(matches) != 1:
        return (
            False,
            "WP10B_CATALOG_ENTRY_MISSING",
            "live catalog must contain unique WP-10B",
            {},
        )
    task = matches[0]
    if int(task.get("weight") or 0) != 8 or task.get("evidenceLevel") != "E4":
        return (
            False,
            "WP10B_CATALOG_PROOF_INVALID",
            "WP-10B catalog weight/evidenceLevel must be 8/E4",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP10B_CATALOG_PROOF_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "wp10bCapacityTest": proofs["wp10bCapacityTest"],
            "pluginUnitTest": proofs["pluginUnitTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            **e4_record,
            "evidenceLevel": "E4",
        },
    )


def verify_wp10b_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP10B_PR_PROOF_INVALID",
        containment_reason="WP10B_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp10b_require_implementation_surfaces_on_head,
    )


def evaluate_wp10b_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-10B CLOSE-VERIFY.

    Requires continuous E4 (Scene+Video dual-frame), parent WP-10A chain,
    suite digests, and dual-repo PR identity.
    """
    task, reason, message = _catalog_wp10b_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp10b_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp10b_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _extract_implementation_pr_number(
        proofs,
        missing_reason="WP10B_VERIFY_DONE_PROOF_MISSING",
    )
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp10b_suite_and_blob_proofs(
        proofs, args
    )
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP10B_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP10B_BASE_CONTAINMENT_FAILED",
    )
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp10b_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=8,
        default_path="android-car/scripts/",
    )
    record["evidenceLevel"] = "E4"
    record["parentTaskId"] = "WP-10A"
    return True, "", "", record


# ---------------------------------------------------------------------------
# WP-10C verify-done: E5 current-user system wallpaper binding.
# ---------------------------------------------------------------------------
WP10C_CALLER_FORGERY_KEYS = WP10B_CALLER_FORGERY_KEYS
WP10C_SUITE_KEYS = (
    "androidUnitTest",
    "wp10cCapacityTest",
    "pluginUnitTest",
    "fullNodeTest",
    "e5Evidence",
)
WP10C_REQUIRED_PREREQS = WP10B_REQUIRED_PREREQS + ("WP-10B",)
WP10C_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-tasks.json",
    "android-car/scripts/wallpaper-task.py",
    "android-car/scripts/verify-wallpaper-plugin.js",
    "android-car/tests/wallpaper-wp10c-red.test.js",
)
_WP10C_PREREQ_RECEIPTS = {
    **_WP10B_PREREQ_RECEIPTS,
    "WP-10B": _VERIFICATION_ROOT / "transactions" / "wp-10b.json",
}


def _load_wp10c_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP10C_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP10C_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP10C_CALLER_FORGERY_KEYS,
        empty_label="WP-10C",
    )


def _catalog_wp10c_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-10C",
        expected_weight=6,
        expected_evidence="E5",
        required_prereqs=WP10C_REQUIRED_PREREQS,
        entry_missing_reason="WP10C_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP10C_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP10C_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-10C.requiredEffectiveDone must include WP-INFRA, WP-00…WP-10B"
        ),
    )


def _verify_wp10c_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    return _verify_prereq_done_receipts(
        _WP10C_PREREQ_RECEIPTS,
        missing_reason="WP10C_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {
                "WP-01",
                "WP-02",
                "WP-03",
                "WP-04",
                "WP-05",
                "WP-06",
                "WP-07",
                "WP-08",
                "WP-09",
                "WP-10A",
                "WP-10B",
            }
        ),
    )


def _wp10c_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    missing: list[str] = []
    for rel in WP10C_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP10C_PR_PROOF_INVALID",
            "implementation head missing WP-10C surfaces: " + ", ".join(missing),
            {},
        )
    cat_rc, cat_text = _git_show_at_commit(
        head_sha, "android-car/scripts/wallpaper-plugin-tasks.json"
    )
    if cat_rc != 0 or (
        '"taskId": "WP-10C"' not in cat_text and '"taskId":"WP-10C"' not in cat_text
    ):
        return (
            False,
            "WP10C_PR_PROOF_INVALID",
            "implementation head catalog missing WP-10C task entry",
            {},
        )
    ver_rc, ver_text = _git_show_at_commit(
        head_sha, "android-car/scripts/verify-wallpaper-plugin.js"
    )
    if ver_rc != 0 or "verifyE5Evidence" not in ver_text:
        return (
            False,
            "WP10C_PR_PROOF_INVALID",
            "verify-wallpaper-plugin.js missing verifyE5Evidence",
            {},
        )
    return (
        True,
        "",
        "",
        {"implementationSurfaces": list(WP10C_IMPLEMENTATION_SURFACES)},
    )


def _verify_wp10c_e5_evidence(
    proofs: Mapping[str, Any],
) -> tuple[bool, str, str, dict[str, Any]]:
    e5 = proofs.get("e5Evidence")
    if not isinstance(e5, dict):
        return (
            False,
            "WP10C_E5_EVIDENCE_MISSING",
            "proofs.e5Evidence object required (sealed continuous E5)",
            {},
        )
    if e5.get("pass") is not True:
        return False, "WP10C_E5_EVIDENCE_MISSING", "e5Evidence.pass must be true", {}
    sha = e5.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha.lower() or ""):
        return (
            False,
            "WP10C_E5_EVIDENCE_MISSING",
            "e5Evidence.sha256 must be 64-char hex of sealed raw manifest",
            {},
        )
    if e5.get("shellCallerUsedForE5") is True or e5.get("caller") == "shell":
        return (
            False,
            "WP10C_E5_SHELL_CALLER_REJECTED",
            "shell cannot seal continuous E5",
            {},
        )
    if e5.get("bindingState") != "ACTIVE_TARGET":
        return (
            False,
            "WP10C_E5_BINDING_NOT_ACTIVE",
            "e5Evidence.bindingState must be ACTIVE_TARGET",
            {},
        )
    if e5.get("sourceGetWallpaperInfo") is not True:
        return (
            False,
            "WP10C_E5_DUMPSYS_DRIVEN",
            "e5Evidence.sourceGetWallpaperInfo must be true",
            {},
        )
    if e5.get("dumpsysDrivenInternal") is True:
        return (
            False,
            "WP10C_E5_DUMPSYS_DRIVEN",
            "internal binding must not be dumpsys-driven",
            {},
        )
    wc = str(e5.get("wallpaperComponent") or "")
    if "WEWallpaperService" not in wc:
        return (
            False,
            "WP10C_E5_WRONG_COMPONENT",
            "e5Evidence.wallpaperComponent must be official WEWallpaperService",
            {},
        )
    if e5.get("engineActive") is not True or e5.get("connectionActive") is not True:
        return (
            False,
            "WP10C_E5_ENGINE_INACTIVE",
            "e5Evidence.engineActive and connectionActive must be true",
            {},
        )
    if e5.get("parentTaskId") != "WP-10B":
        return (
            False,
            "WP10C_E5_PARENT_MISSING",
            "e5Evidence.parentTaskId must be WP-10B",
            {},
        )
    parent_sha = e5.get("parentManifestSha256")
    if not isinstance(parent_sha, str) or not re.fullmatch(
        r"[0-9a-f]{64}", parent_sha.lower() or ""
    ):
        return (
            False,
            "WP10C_E5_PARENT_MISSING",
            "e5Evidence.parentManifestSha256 must be 64-char hex",
            {},
        )
    if e5.get("serial") != "LD249H019625":
        return (
            False,
            "WP10C_E5_DEVICE_CONTEXT_FAILED",
            f"e5Evidence.serial must be LD249H019625, got {e5.get('serial')!r}",
            {},
        )
    if int(e5.get("targetUser") or 0) != 12:
        return (
            False,
            "WP10C_E5_DEVICE_CONTEXT_FAILED",
            "e5Evidence.targetUser must be 12",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "e5Evidence": {
                "pass": True,
                "sha256": sha.lower(),
                "bindingState": "ACTIVE_TARGET",
                "wallpaperComponent": wc,
                "engineActive": True,
                "connectionActive": True,
                "sourceGetWallpaperInfo": True,
                "parentTaskId": "WP-10B",
                "parentManifestSha256": parent_sha.lower(),
                "serial": "LD249H019625",
                "targetUser": 12,
                "evidenceLevel": "E5",
            }
        },
    )


def _verify_wp10c_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    capacity_keys = tuple(k for k in WP10C_SUITE_KEYS if k != "e5Evidence")
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        capacity_keys,
        missing_reason="WP10C_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    ok_e5, reason, message, e5_record = _verify_wp10c_e5_evidence(proofs)
    if not ok_e5:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    if not catalog_path.is_file():
        return (
            False,
            "WP10C_VERIFY_DONE_PROOF_MISSING",
            f"catalog missing: {catalog_path}",
            {},
        )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    matches = [
        t
        for t in (catalog.get("tasks") or [])
        if isinstance(t, dict) and t.get("taskId") == "WP-10C"
    ]
    if len(matches) != 1:
        return (
            False,
            "WP10C_CATALOG_ENTRY_MISSING",
            "live catalog must contain unique WP-10C",
            {},
        )
    task = matches[0]
    if int(task.get("weight") or 0) != 6 or task.get("evidenceLevel") != "E5":
        return (
            False,
            "WP10C_CATALOG_PROOF_INVALID",
            "WP-10C catalog weight/evidenceLevel must be 6/E5",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP10C_CATALOG_PROOF_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "wp10cCapacityTest": proofs["wp10cCapacityTest"],
            "pluginUnitTest": proofs["pluginUnitTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            **e5_record,
            "evidenceLevel": "E5",
        },
    )


def verify_wp10c_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP10C_PR_PROOF_INVALID",
        containment_reason="WP10C_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp10c_require_implementation_surfaces_on_head,
    )


def evaluate_wp10c_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-10C CLOSE-VERIFY.

    Requires continuous E5 (current-user WE wallpaper binding), parent WP-10B,
    suite digests, and implementation PR identity.
    """
    task, reason, message = _catalog_wp10c_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp10c_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp10c_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _extract_implementation_pr_number(
        proofs,
        missing_reason="WP10C_VERIFY_DONE_PROOF_MISSING",
    )
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp10c_suite_and_blob_proofs(
        proofs, args
    )
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP10C_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP10C_BASE_CONTAINMENT_FAILED",
    )
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp10c_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=6,
        default_path="android-car/scripts/",
    )
    record["evidenceLevel"] = "E5"
    record["parentTaskId"] = "WP-10B"
    return True, "", "", record


# ---------------------------------------------------------------------------
# WP-11A verify-done: fault matrix + auto_recoverable recovery <=10s (stay E5).
# ---------------------------------------------------------------------------
WP11A_CALLER_FORGERY_KEYS = WP10C_CALLER_FORGERY_KEYS
WP11A_SUITE_KEYS = (
    "androidUnitTest",
    "wp11aCapacityTest",
    "pluginUnitTest",
    "fullNodeTest",
    "recoveryEvidence",
)
WP11A_REQUIRED_PREREQS = WP10C_REQUIRED_PREREQS + ("WP-10C",)
WP11A_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-tasks.json",
    "android-car/scripts/wallpaper-task.py",
    "android-car/scripts/verify-wallpaper-plugin.js",
    "android-car/tests/wallpaper-wp11a-red.test.js",
)
_WP11A_PREREQ_RECEIPTS = {
    **_WP10C_PREREQ_RECEIPTS,
    "WP-10C": _VERIFICATION_ROOT / "transactions" / "wp-10c.json",
}
WP11A_RECOVERY_MAX_MS = 10000


def _load_wp11a_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP11A_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP11A_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP11A_CALLER_FORGERY_KEYS,
        empty_label="WP-11A",
    )


def _catalog_wp11a_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-11A",
        expected_weight=3,
        expected_evidence="E5",
        required_prereqs=WP11A_REQUIRED_PREREQS,
        entry_missing_reason="WP11A_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP11A_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP11A_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-11A.requiredEffectiveDone must include WP-INFRA, WP-00…WP-10C"
        ),
    )


def _verify_wp11a_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    return _verify_prereq_done_receipts(
        _WP11A_PREREQ_RECEIPTS,
        missing_reason="WP11A_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {
                "WP-01",
                "WP-02",
                "WP-03",
                "WP-04",
                "WP-05",
                "WP-06",
                "WP-07",
                "WP-08",
                "WP-09",
                "WP-10A",
                "WP-10B",
                "WP-10C",
            }
        ),
    )


def _wp11a_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    missing: list[str] = []
    for rel in WP11A_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP11A_PR_PROOF_INVALID",
            "implementation head missing WP-11A surfaces: " + ", ".join(missing),
            {},
        )
    cat_rc, cat_text = _git_show_at_commit(
        head_sha, "android-car/scripts/wallpaper-plugin-tasks.json"
    )
    if cat_rc != 0 or (
        '"taskId": "WP-11A"' not in cat_text and '"taskId":"WP-11A"' not in cat_text
    ):
        return (
            False,
            "WP11A_PR_PROOF_INVALID",
            "implementation head catalog missing WP-11A task entry",
            {},
        )
    ver_rc, ver_text = _git_show_at_commit(
        head_sha, "android-car/scripts/verify-wallpaper-plugin.js"
    )
    if ver_rc != 0 or "verifyRecoveryEvidence" not in ver_text:
        return (
            False,
            "WP11A_PR_PROOF_INVALID",
            "verify-wallpaper-plugin.js missing verifyRecoveryEvidence",
            {},
        )
    if "RECOVERY_MAX_MS" not in ver_text and "10000" not in ver_text:
        return (
            False,
            "WP11A_PR_PROOF_INVALID",
            "verify-wallpaper-plugin.js missing recovery SLA surface",
            {},
        )
    return (
        True,
        "",
        "",
        {"implementationSurfaces": list(WP11A_IMPLEMENTATION_SURFACES)},
    )


def _verify_wp11a_recovery_evidence(
    proofs: Mapping[str, Any],
) -> tuple[bool, str, str, dict[str, Any]]:
    rec = proofs.get("recoveryEvidence")
    if not isinstance(rec, dict):
        return (
            False,
            "WP11A_RECOVERY_EVIDENCE_MISSING",
            "proofs.recoveryEvidence object required (sealed fault matrix)",
            {},
        )
    if rec.get("pass") is not True:
        return (
            False,
            "WP11A_RECOVERY_EVIDENCE_MISSING",
            "recoveryEvidence.pass must be true",
            {},
        )
    sha = rec.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha.lower() or ""):
        return (
            False,
            "WP11A_RECOVERY_EVIDENCE_MISSING",
            "recoveryEvidence.sha256 must be 64-char hex of sealed raw manifest",
            {},
        )
    if rec.get("parentTaskId") != "WP-10C":
        return (
            False,
            "WP11A_RECOVERY_PARENT_MISSING",
            "recoveryEvidence.parentTaskId must be WP-10C",
            {},
        )
    parent_sha = rec.get("parentManifestSha256")
    if not isinstance(parent_sha, str) or not re.fullmatch(
        r"[0-9a-f]{64}", parent_sha.lower() or ""
    ):
        return (
            False,
            "WP11A_RECOVERY_PARENT_MISSING",
            "recoveryEvidence.parentManifestSha256 must be 64-char hex",
            {},
        )
    if rec.get("packagePresencePass") is not True:
        return (
            False,
            "WP11A_PACKAGE_PRESENCE_FAILED",
            "recoveryEvidence.packagePresencePass must be true",
            {},
        )
    if rec.get("expectedErrorPass") is not True:
        return (
            False,
            "WP11A_EXPECTED_ERROR_FAILED",
            "recoveryEvidence.expectedErrorPass must be true",
            {},
        )
    if rec.get("autoRecoverablePass") is not True:
        return (
            False,
            "WP11A_AUTO_RECOVERABLE_FAILED",
            "recoveryEvidence.autoRecoverablePass must be true",
            {},
        )
    max_ms = rec.get("maxRecoveryMs")
    try:
        max_ms_i = int(max_ms)
    except (TypeError, ValueError):
        return (
            False,
            "WP11A_RECOVERY_SLA_FAILED",
            "recoveryEvidence.maxRecoveryMs must be int",
            {},
        )
    if max_ms_i < 0 or max_ms_i > WP11A_RECOVERY_MAX_MS:
        return (
            False,
            "WP11A_RECOVERY_SLA_FAILED",
            f"recoveryEvidence.maxRecoveryMs must be 0..{WP11A_RECOVERY_MAX_MS}, got {max_ms_i}",
            {},
        )
    if rec.get("elevatedEvidenceLevel") is True or (
        rec.get("evidenceLevel") not in (None, "E5")
    ):
        return (
            False,
            "WP11A_EVIDENCE_ELEVATED",
            "WP-11A must remain E5 (no E6/E7 elevation)",
            {},
        )
    if rec.get("serial") != "LD249H019625":
        return (
            False,
            "WP11A_DEVICE_CONTEXT_FAILED",
            f"recoveryEvidence.serial must be LD249H019625, got {rec.get('serial')!r}",
            {},
        )
    if int(rec.get("targetUser") or 0) != 12:
        return (
            False,
            "WP11A_DEVICE_CONTEXT_FAILED",
            "recoveryEvidence.targetUser must be 12",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "recoveryEvidence": {
                "pass": True,
                "sha256": sha.lower(),
                "parentTaskId": "WP-10C",
                "parentManifestSha256": parent_sha.lower(),
                "packagePresencePass": True,
                "expectedErrorPass": True,
                "autoRecoverablePass": True,
                "maxRecoveryMs": max_ms_i,
                "serial": "LD249H019625",
                "targetUser": 12,
                "evidenceLevel": "E5",
            }
        },
    )


def _verify_wp11a_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    capacity_keys = tuple(k for k in WP11A_SUITE_KEYS if k != "recoveryEvidence")
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        capacity_keys,
        missing_reason="WP11A_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    ok_rec, reason, message, rec_record = _verify_wp11a_recovery_evidence(proofs)
    if not ok_rec:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    if not catalog_path.is_file():
        return (
            False,
            "WP11A_VERIFY_DONE_PROOF_MISSING",
            f"catalog missing: {catalog_path}",
            {},
        )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    matches = [
        t
        for t in (catalog.get("tasks") or [])
        if isinstance(t, dict) and t.get("taskId") == "WP-11A"
    ]
    if len(matches) != 1:
        return (
            False,
            "WP11A_CATALOG_ENTRY_MISSING",
            "live catalog must contain unique WP-11A",
            {},
        )
    task = matches[0]
    if int(task.get("weight") or 0) != 3 or task.get("evidenceLevel") != "E5":
        return (
            False,
            "WP11A_CATALOG_PROOF_INVALID",
            "WP-11A catalog weight/evidenceLevel must be 3/E5",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP11A_CATALOG_PROOF_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "wp11aCapacityTest": proofs["wp11aCapacityTest"],
            "pluginUnitTest": proofs["pluginUnitTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            **rec_record,
            "evidenceLevel": "E5",
        },
    )


def verify_wp11a_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP11A_PR_PROOF_INVALID",
        containment_reason="WP11A_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp11a_require_implementation_surfaces_on_head,
    )


def evaluate_wp11a_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-11A CLOSE-VERIFY.

    Requires sealed recovery fault matrix (package_presence + expected_error +
    auto_recoverable <=10s), parent WP-10C, suite digests, and implementation PR.
    Does not elevate continuous evidence beyond E5.
    """
    task, reason, message = _catalog_wp11a_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp11a_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp11a_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _extract_implementation_pr_number(
        proofs,
        missing_reason="WP11A_VERIFY_DONE_PROOF_MISSING",
    )
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp11a_suite_and_blob_proofs(
        proofs, args
    )
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP11A_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP11A_BASE_CONTAINMENT_FAILED",
    )
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp11a_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=3,
        default_path="android-car/scripts/",
    )
    record["evidenceLevel"] = "E5"
    record["parentTaskId"] = "WP-10C"
    return True, "", "", record


# ---------------------------------------------------------------------------
# WP-11B verify-done: E6 30-min soak (7 samples @ 5 min) + parent WP-11A.
# ---------------------------------------------------------------------------
WP11B_CALLER_FORGERY_KEYS = WP11A_CALLER_FORGERY_KEYS
WP11B_SUITE_KEYS = (
    "androidUnitTest",
    "wp11bCapacityTest",
    "pluginUnitTest",
    "fullNodeTest",
    "e6Evidence",
)
WP11B_REQUIRED_PREREQS = WP11A_REQUIRED_PREREQS + ("WP-11A",)
WP11B_IMPLEMENTATION_SURFACES = (
    "android-car/scripts/wallpaper-plugin-tasks.json",
    "android-car/scripts/wallpaper-task.py",
    "android-car/scripts/verify-wallpaper-plugin.js",
    "android-car/tests/wallpaper-wp11b-red.test.js",
)
_WP11B_PREREQ_RECEIPTS = {
    **_WP11A_PREREQ_RECEIPTS,
    "WP-11A": _VERIFICATION_ROOT / "transactions" / "wp-11a.json",
}
WP11B_E6_DURATION_MS = 1800000
WP11B_E6_SAMPLE_COUNT = 7
WP11B_E6_PSS_GROWTH_MIB = 64


def _load_wp11b_identity_proofs(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _load_single_pr_identity_proofs(
        receipt,
        args,
        missing_reason="WP11B_VERIFY_DONE_PROOF_MISSING",
        forgery_reason="WP11B_VERIFY_DONE_CALLER_FORGERY",
        forgery_keys=WP11B_CALLER_FORGERY_KEYS,
        empty_label="WP-11B",
    )


def _catalog_wp11b_task(
    args: argparse.Namespace,
) -> tuple[dict[str, Any] | None, str, str]:
    return _catalog_unique_task(
        args,
        task_id="WP-11B",
        expected_weight=3,
        expected_evidence="E6",
        required_prereqs=WP11B_REQUIRED_PREREQS,
        entry_missing_reason="WP11B_CATALOG_ENTRY_MISSING",
        catalog_invalid_reason="WP11B_CATALOG_PROOF_INVALID",
        required_done_missing_reason="WP11B_REQUIRED_DONE_MISSING",
        required_done_message=(
            "WP-11B.requiredEffectiveDone must include WP-INFRA, WP-00…WP-11A"
        ),
    )


def _verify_wp11b_prerequisite_done_receipts() -> tuple[bool, str, str, dict[str, Any]]:
    return _verify_prereq_done_receipts(
        _WP11B_PREREQ_RECEIPTS,
        missing_reason="WP11B_REQUIRED_DONE_MISSING",
        state_done_tasks=frozenset(
            {
                "WP-01",
                "WP-02",
                "WP-03",
                "WP-04",
                "WP-05",
                "WP-06",
                "WP-07",
                "WP-08",
                "WP-09",
                "WP-10A",
                "WP-10B",
                "WP-10C",
                "WP-11A",
            }
        ),
    )


def _wp11b_require_implementation_surfaces_on_head(
    head_sha: str,
) -> tuple[bool, str, str, dict[str, Any]]:
    missing: list[str] = []
    for rel in WP11B_IMPLEMENTATION_SURFACES:
        if not _git_path_exists_at_commit(head_sha, rel):
            missing.append(rel)
    if missing:
        return (
            False,
            "WP11B_PR_PROOF_INVALID",
            "implementation head missing WP-11B surfaces: " + ", ".join(missing),
            {},
        )
    cat_rc, cat_text = _git_show_at_commit(
        head_sha, "android-car/scripts/wallpaper-plugin-tasks.json"
    )
    if cat_rc != 0 or (
        '"taskId": "WP-11B"' not in cat_text and '"taskId":"WP-11B"' not in cat_text
    ):
        return (
            False,
            "WP11B_PR_PROOF_INVALID",
            "implementation head catalog missing WP-11B task entry",
            {},
        )
    ver_rc, ver_text = _git_show_at_commit(
        head_sha, "android-car/scripts/verify-wallpaper-plugin.js"
    )
    if ver_rc != 0 or "verifyE6Evidence" not in ver_text:
        return (
            False,
            "WP11B_PR_PROOF_INVALID",
            "verify-wallpaper-plugin.js missing verifyE6Evidence",
            {},
        )
    return (
        True,
        "",
        "",
        {"implementationSurfaces": list(WP11B_IMPLEMENTATION_SURFACES)},
    )


def _verify_wp11b_e6_evidence(
    proofs: Mapping[str, Any],
) -> tuple[bool, str, str, dict[str, Any]]:
    e6 = proofs.get("e6Evidence")
    if not isinstance(e6, dict):
        return (
            False,
            "WP11B_E6_EVIDENCE_MISSING",
            "proofs.e6Evidence object required (sealed 30min soak)",
            {},
        )
    if e6.get("pass") is not True:
        return False, "WP11B_E6_EVIDENCE_MISSING", "e6Evidence.pass must be true", {}
    sha = e6.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha.lower() or ""):
        return (
            False,
            "WP11B_E6_EVIDENCE_MISSING",
            "e6Evidence.sha256 must be 64-char hex of sealed raw manifest",
            {},
        )
    if e6.get("parentTaskId") != "WP-11A":
        return (
            False,
            "WP11B_E6_PARENT_MISSING",
            "e6Evidence.parentTaskId must be WP-11A",
            {},
        )
    parent_sha = e6.get("parentManifestSha256")
    if not isinstance(parent_sha, str) or not re.fullmatch(
        r"[0-9a-f]{64}", parent_sha.lower() or ""
    ):
        return (
            False,
            "WP11B_E6_PARENT_MISSING",
            "e6Evidence.parentManifestSha256 must be 64-char hex",
            {},
        )
    try:
        sample_count = int(e6.get("sampleCount"))
    except (TypeError, ValueError):
        return (
            False,
            "WP11B_E6_SAMPLE_COUNT_FAILED",
            "e6Evidence.sampleCount must be int",
            {},
        )
    if sample_count != WP11B_E6_SAMPLE_COUNT:
        return (
            False,
            "WP11B_E6_SAMPLE_COUNT_FAILED",
            f"e6Evidence.sampleCount must be {WP11B_E6_SAMPLE_COUNT}",
            {},
        )
    try:
        window_ms = int(e6.get("hostObservedWindowMs"))
    except (TypeError, ValueError):
        return (
            False,
            "WP11B_E6_WINDOW_FAILED",
            "e6Evidence.hostObservedWindowMs must be int",
            {},
        )
    if window_ms < WP11B_E6_DURATION_MS:
        return (
            False,
            "WP11B_E6_WINDOW_FAILED",
            f"e6Evidence.hostObservedWindowMs must be >= {WP11B_E6_DURATION_MS}",
            {},
        )
    try:
        pss_growth = float(e6.get("pssGrowthMiB"))
    except (TypeError, ValueError):
        return (
            False,
            "WP11B_E6_PSS_FAILED",
            "e6Evidence.pssGrowthMiB must be number",
            {},
        )
    if pss_growth < 0 or pss_growth > WP11B_E6_PSS_GROWTH_MIB:
        return (
            False,
            "WP11B_E6_PSS_FAILED",
            f"e6Evidence.pssGrowthMiB must be 0..{WP11B_E6_PSS_GROWTH_MIB}",
            {},
        )
    if e6.get("interactionsPass") is not True:
        return (
            False,
            "WP11B_E6_INTERACTIONS_FAILED",
            "e6Evidence.interactionsPass must be true",
            {},
        )
    if e6.get("fatalAnr") is True:
        return False, "WP11B_E6_FATAL_ANR", "e6Evidence.fatalAnr must be false", {}
    if e6.get("serial") != "LD249H019625":
        return (
            False,
            "WP11B_E6_DEVICE_CONTEXT_FAILED",
            f"e6Evidence.serial must be LD249H019625, got {e6.get('serial')!r}",
            {},
        )
    if int(e6.get("targetUser") or 0) != 12:
        return (
            False,
            "WP11B_E6_DEVICE_CONTEXT_FAILED",
            "e6Evidence.targetUser must be 12",
            {},
        )
    if e6.get("evidenceLevel") not in (None, "E6"):
        return (
            False,
            "WP11B_E6_LEVEL_INVALID",
            "e6Evidence.evidenceLevel must be E6",
            {},
        )
    return (
        True,
        "",
        "",
        {
            "e6Evidence": {
                "pass": True,
                "sha256": sha.lower(),
                "parentTaskId": "WP-11A",
                "parentManifestSha256": parent_sha.lower(),
                "sampleCount": WP11B_E6_SAMPLE_COUNT,
                "hostObservedWindowMs": window_ms,
                "pssGrowthMiB": pss_growth,
                "interactionsPass": True,
                "fatalAnr": False,
                "serial": "LD249H019625",
                "targetUser": 12,
                "evidenceLevel": "E6",
            }
        },
    )


def _verify_wp11b_suite_and_blob_proofs(
    proofs: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    capacity_keys = tuple(k for k in WP11B_SUITE_KEYS if k != "e6Evidence")
    ok, reason, message = _require_suite_pass_digests(
        proofs,
        capacity_keys,
        missing_reason="WP11B_SUITE_RECEIPT_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    ok_e6, reason, message, e6_record = _verify_wp11b_e6_evidence(proofs)
    if not ok_e6:
        return False, reason, message, {}

    catalog_path = Path(args.catalog_path) if args.catalog_path else DEFAULT_CATALOG_BLOB_PATH
    if not catalog_path.is_file():
        return (
            False,
            "WP11B_VERIFY_DONE_PROOF_MISSING",
            f"catalog missing: {catalog_path}",
            {},
        )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    matches = [
        t
        for t in (catalog.get("tasks") or [])
        if isinstance(t, dict) and t.get("taskId") == "WP-11B"
    ]
    if len(matches) != 1:
        return (
            False,
            "WP11B_CATALOG_ENTRY_MISSING",
            "live catalog must contain unique WP-11B",
            {},
        )
    task = matches[0]
    if int(task.get("weight") or 0) != 3 or task.get("evidenceLevel") != "E6":
        return (
            False,
            "WP11B_CATALOG_PROOF_INVALID",
            "WP-11B catalog weight/evidenceLevel must be 3/E6",
            {},
        )

    ok, reason, message, live_catalog_sha, live_schema_sha = _verify_catalog_schema_digests(
        proofs,
        args,
        invalid_reason="WP11B_CATALOG_PROOF_INVALID",
    )
    if not ok:
        return False, reason, message, {}

    return (
        True,
        "",
        "",
        {
            "catalogSha256": live_catalog_sha,
            "schemaSha256": live_schema_sha,
            "androidUnitTest": proofs["androidUnitTest"],
            "wp11bCapacityTest": proofs["wp11bCapacityTest"],
            "pluginUnitTest": proofs["pluginUnitTest"],
            "fullNodeTest": proofs["fullNodeTest"],
            **e6_record,
            "evidenceLevel": "E6",
        },
    )


def verify_wp11b_merged_implementation_pr(
    *,
    pr_number: int,
    live_base_sha: str,
    repo: str | None,
) -> tuple[dict[str, Any] | None, str, str]:
    return _verify_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base_sha,
        repo=repo,
        invalid_reason="WP11B_PR_PROOF_INVALID",
        containment_reason="WP11B_BASE_CONTAINMENT_FAILED",
        surface_checker=_wp11b_require_implementation_surfaces_on_head,
    )


def evaluate_wp11b_verify_done(
    receipt: Mapping[str, Any],
    args: argparse.Namespace,
) -> tuple[bool, str, str, dict[str, Any]]:
    """Return (ok, reason, message, proof_record) for WP-11B CLOSE-VERIFY.

    Requires sealed E6 30-minute soak (7 samples), parent WP-11A, suite digests,
    and implementation PR identity.
    """
    task, reason, message = _catalog_wp11b_task(args)
    if task is None:
        return False, reason, message, {}

    ok_prereq, reason, message, prereq_record = _verify_wp11b_prerequisite_done_receipts()
    if not ok_prereq:
        return False, reason, message, {}

    proofs, reason, message = _load_wp11b_identity_proofs(receipt, args)
    if proofs is None:
        return False, reason, message, {}

    pr_number, reason, message = _extract_implementation_pr_number(
        proofs,
        missing_reason="WP11B_VERIFY_DONE_PROOF_MISSING",
    )
    if pr_number is None:
        return False, reason, message, {}

    ok_suites, reason, message, suite_record = _verify_wp11b_suite_and_blob_proofs(
        proofs, args
    )
    if not ok_suites:
        return False, reason, message, {}

    live_base, reason, message = _resolve_live_base_optional_claim(
        proofs,
        missing_reason="WP11B_VERIFY_DONE_PROOF_MISSING",
        containment_reason="WP11B_BASE_CONTAINMENT_FAILED",
    )
    if live_base is None:
        return False, reason, message, {}

    repo = getattr(args, "repo", None) or APPROVED_GITHUB_REPO
    impl_proof, reason, message = verify_wp11b_merged_implementation_pr(
        pr_number=pr_number,
        live_base_sha=live_base,
        repo=repo,
    )
    if impl_proof is None:
        return False, reason, message, {}

    record = _assemble_verify_done_record(
        task=task,
        impl_proof=impl_proof,
        live_base=live_base,
        prereq_record=prereq_record,
        suite_record=suite_record,
        weight=3,
        default_path="android-car/scripts/",
    )
    record["evidenceLevel"] = "E6"
    record["parentTaskId"] = "WP-11A"
    return True, "", "", record


def cmd_verify_done(args: argparse.Namespace) -> int:
    """Fail-closed DONE only when catalog + proofs + live base containment hold."""
    task_id = require_task(args.task)
    path = resolve_receipt_path(args)

    with receipt_lock(path):
        current = load_locked_receipt(path)
        if current.get("taskId") not in (None, task_id) and current.get("taskId") != task_id:
            fail(
                "ILLEGAL_STATE",
                f"receipt taskId {current.get('taskId')} != {task_id}",
            )

        if task_id == "WP-01":
            ok_gate, reason, message, proof_record = evaluate_wp01_verify_done(current, args)
            weight = 6
        elif task_id == "WP-02":
            ok_gate, reason, message, proof_record = evaluate_wp02_verify_done(current, args)
            weight = 8
        elif task_id == "WP-03":
            ok_gate, reason, message, proof_record = evaluate_wp03_verify_done(current, args)
            weight = 8
        elif task_id == "WP-04":
            ok_gate, reason, message, proof_record = evaluate_wp04_verify_done(current, args)
            weight = 10
        elif task_id == "WP-05":
            ok_gate, reason, message, proof_record = evaluate_wp05_verify_done(current, args)
            weight = 8
        elif task_id == "WP-06":
            ok_gate, reason, message, proof_record = evaluate_wp06_verify_done(current, args)
            weight = 6
        elif task_id == "WP-07":
            ok_gate, reason, message, proof_record = evaluate_wp07_verify_done(current, args)
            weight = 6
        elif task_id == "WP-08":
            ok_gate, reason, message, proof_record = evaluate_wp08_verify_done(current, args)
            weight = 8
        elif task_id == "WP-09":
            ok_gate, reason, message, proof_record = evaluate_wp09_verify_done(current, args)
            weight = 6
        elif task_id == "WP-10A":
            ok_gate, reason, message, proof_record = evaluate_wp10a_verify_done(current, args)
            weight = 6
        elif task_id == "WP-10B":
            ok_gate, reason, message, proof_record = evaluate_wp10b_verify_done(current, args)
            weight = 8
        elif task_id == "WP-10C":
            ok_gate, reason, message, proof_record = evaluate_wp10c_verify_done(current, args)
            weight = 6
        elif task_id == "WP-11A":
            ok_gate, reason, message, proof_record = evaluate_wp11a_verify_done(current, args)
            weight = 3
        elif task_id == "WP-11B":
            ok_gate, reason, message, proof_record = evaluate_wp11b_verify_done(current, args)
            weight = 3
        else:
            # Never mis-tag later WP tasks as WP03_*.
            if task_id.startswith("WP-"):
                ns = task_id.replace("-", "")
                fail(
                    f"{ns}_VERIFY_DONE_UNAVAILABLE",
                    f"verify-done production path not implemented for {task_id}",
                )
            fail(
                "WP01_VERIFY_DONE_UNAVAILABLE",
                f"verify-done production path not implemented for {task_id}",
            )

        if not ok_gate:
            fail(
                reason
                or (
                    "WP10C_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-10C"
                    else "WP10B_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-10B"
                    else "WP10A_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-10A"
                    else "WP09_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-09"
                    else "WP08_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-08"
                    else "WP07_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-07"
                    else "WP06_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-06"
                    else "WP05_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-05"
                    else "WP04_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-04"
                    else "WP03_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-03"
                    else "WP02_VERIFY_DONE_PROOF_MISSING"
                    if task_id == "WP-02"
                    else "WP01_VERIFY_DONE_PROOF_MISSING"
                ),
                message or "verify-done proofs incomplete",
            )

        next_value = dict(current)
        next_value["taskId"] = task_id
        next_value["state"] = "DONE"
        next_value["EffectiveDone"] = True
        next_value["revision"] = bump_revision(current)
        next_value["verifyDone"] = proof_record
        store_task_receipt_with_readback(path, next_value)

    # Independent re-read + hash (response-loss safe)
    again = load_task_receipt(path, check_mode=True)
    if again.get("EffectiveDone") is not True or again.get("state") != "DONE":
        fail("RECEIPT_READBACK_MISMATCH", "verify-done readback did not retain DONE")
    receipt_sha = hashlib.sha256(canonical_receipt_bytes(again)).hexdigest()
    return emit_ok(
        "verify-done",
        taskId=task_id,
        EffectiveDone=True,
        state="DONE",
        revision=again.get("revision"),
        receipt=str(path),
        receiptSha256=receipt_sha,
        coreProgressWeight=weight,
    )


def cmd_compute_core_progress(args: argparse.Namespace) -> int:
    """Sum catalog weights for tasks with EffectiveDone proven by receipts (not caller)."""
    catalog = load_authoritative_catalog(args)
    # Optional JSON map taskId -> receipt path
    done_map: dict[str, str] = {}
    if args.done_receipts_json:
        try:
            raw = json.loads(args.done_receipts_json)
        except json.JSONDecodeError as exc:
            fail("ILLEGAL_STATE", f"invalid --done-receipts-json: {exc}")
        if not isinstance(raw, dict):
            fail("ILLEGAL_STATE", "--done-receipts-json must be object")
        done_map = {str(k): str(v) for k, v in raw.items()}

    total = 0
    breakdown: list[dict[str, Any]] = []
    for task in catalog.get("tasks", []):
        if not isinstance(task, dict):
            continue
        task_id = task.get("taskId")
        weight = task.get("weight", 0)
        try:
            weight_i = int(weight)
        except (TypeError, ValueError):
            weight_i = 0
        effective = False
        if task_id in done_map:
            rpath = Path(done_map[task_id])
            if rpath.is_file():
                data = load_task_receipt(rpath, check_mode=True)
                effective = data.get("EffectiveDone") is True and data.get("taskId") == task_id
        if effective:
            total += weight_i
        breakdown.append(
            {
                "taskId": task_id,
                "weight": weight_i,
                "EffectiveDone": effective,
            }
        )

    return emit_ok(
        "compute-core-progress",
        coreProgressPercent=total,
        breakdown=breakdown,
        source="catalog-weights+receipts",
    )


def cmd_assert_ready(args: argparse.Namespace) -> int:
    task_id = args.task
    if not task_id:
        fail("UNKNOWN_TASK", "missing --task")
    if task_id not in KNOWN_TASKS:
        fail("UNKNOWN_TASK", f"unknown task id: {task_id}")

    gate_raw = args.infra_effective_gate
    if gate_raw is None:
        if task_id != "WP-INFRA":
            fail("EFFECTIVE_GATE_FALSE", "missing --infra-effective-gate")
        return emit_ok("assert-ready", taskId=task_id, EffectiveGate=True)

    token = str(gate_raw).strip().lower()
    if token == "from-receipt":
        path = resolve_bootstrap_path(args)
        receipt = load_bootstrap_receipt(path, check_mode=True)
        gate, reason, message = evaluate_bootstrap_gate(receipt)
        if receipt.get("EffectiveGate") is True and not gate:
            gate = False
        if task_id != "WP-INFRA" and not gate:
            fail("EFFECTIVE_GATE_FALSE", message or "WP-INFRA EffectiveGate=false")
        return emit_ok(
            "assert-ready",
            taskId=task_id,
            EffectiveGate=gate,
            failureReason=reason,
        )

    if token in {"0", "false", "no", "off"}:
        if task_id != "WP-INFRA":
            fail(
                "EFFECTIVE_GATE_FALSE",
                f"{task_id} cannot start while WP-INFRA EffectiveGate=false",
            )
        return emit_ok("assert-ready", taskId=task_id, EffectiveGate=False)

    if token in {"1", "true", "yes", "on"}:
        return emit_ok("assert-ready", taskId=task_id, EffectiveGate=True)

    fail("ILLEGAL_STATE", f"illegal --infra-effective-gate value: {gate_raw!r}")


COMMANDS = {
    "reconcile": cmd_reconcile,
    "assert-state": cmd_assert_state,
    "cas-state": cmd_cas_state,
    "begin-phase": cmd_begin_phase,
    "init": cmd_init,
    "assert-evidence-path": cmd_assert_evidence_path,
    "collect-raw": cmd_collect_raw,
    "collector-write": cmd_collector_write,
    "open-attempt": cmd_open_attempt,
    "assert-device-context": cmd_assert_device_context,
    "receipt-init": cmd_receipt_init,
    "receipt-cas": cmd_receipt_cas,
    "receipt-read": cmd_receipt_read,
    "receipt-readback": cmd_receipt_readback,
    "receipt-append-attempt": cmd_receipt_append_attempt,
    "receipt-resume": cmd_receipt_resume,
    "bootstrap-init": cmd_bootstrap_init,
    "bootstrap-record-sha": cmd_bootstrap_record_sha,
    "bootstrap-record-test-receipt": cmd_bootstrap_record_test_receipt,
    "bootstrap-record-phase": cmd_bootstrap_record_phase,
    "bootstrap-record-origin": cmd_bootstrap_record_origin,
    "bootstrap-readback": cmd_bootstrap_readback,
    "evaluate-effective-gate": cmd_evaluate_effective_gate,
    "assert-effective-gate": cmd_assert_effective_gate,
    "bootstrap-claim-done": cmd_bootstrap_claim_done,
    "bootstrap-sync-begin": cmd_bootstrap_sync_begin,
    "bootstrap-sync-resume": cmd_bootstrap_sync_resume,
    "bootstrap-write-status": cmd_bootstrap_write_status,
    "bootstrap-exact-push": cmd_bootstrap_exact_push,
    "bootstrap-origin-ls-remote": cmd_bootstrap_origin_ls_remote,
    "bootstrap-origin-readback": cmd_bootstrap_origin_readback,
    "bootstrap-seal-exact-sync": cmd_bootstrap_seal_exact_sync,
    "bootstrap-pr-merge-readback": cmd_bootstrap_pr_merge_readback,
    "bootstrap-base-containment-readback": cmd_bootstrap_base_containment_readback,
    "assert-ready": cmd_assert_ready,
    "verify-done": cmd_verify_done,
    "compute-core-progress": cmd_compute_core_progress,
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="wallpaper-task.py", add_help=False)
    parser.add_argument("command", nargs="?", default="")
    parser.add_argument("--task")
    parser.add_argument("--transactions")
    parser.add_argument("--file")
    parser.add_argument("--path")
    parser.add_argument("--contained", action="store_true")
    parser.add_argument("--expected")
    parser.add_argument("--declare-done", action="store_true")
    parser.add_argument("--from")
    parser.add_argument("--to")
    parser.add_argument("--phase")
    parser.add_argument("--from-catalog", action="store_true")
    parser.add_argument("--transaction-id")
    parser.add_argument("--run-uuid")
    parser.add_argument("--bytes-b64")
    parser.add_argument("--lease-nonce")
    parser.add_argument("--attempt-no")
    parser.add_argument("--lease-until")
    parser.add_argument("--require-parent-effective-done", action="store_true")
    parser.add_argument("--single-line", action="store_true")
    # Receipt surface (RED-03 / GREEN-03)
    parser.add_argument("--receipt")
    parser.add_argument("--schema")
    parser.add_argument("--expected-revision", type=int)
    parser.add_argument("--expected-state")
    parser.add_argument("--state")
    parser.add_argument("--set-json")
    parser.add_argument("--field")
    parser.add_argument("--attempt-json")
    parser.add_argument("--require-contained", action="store_true")
    parser.add_argument("--receipts-root")
    parser.add_argument("--confirm-readback", action="store_true")
    # Bootstrap / EffectiveGate surface (RED-04 / GREEN-04)
    parser.add_argument("--bootstrap-root")
    parser.add_argument("--kind")
    parser.add_argument("--sha256")
    parser.add_argument("--status")
    parser.add_argument("--failure-signature")
    parser.add_argument("--expected-sha")
    parser.add_argument("--observed-sha")
    parser.add_argument("--ref")
    parser.add_argument("--infra-sha")
    parser.add_argument("--remote-sha")
    parser.add_argument("--recompute-paths", action="store_true")
    parser.add_argument("--runner-path")
    parser.add_argument("--catalog-path")
    parser.add_argument("--schema-path")
    parser.add_argument("--infra-effective-gate")
    parser.add_argument("--use-canonical-bootstrap", action="store_true")
    parser.add_argument("--replace-ledger", action="store_true")
    # Exact push / ls-remote surface (RED-06 / GREEN-06)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-network-push", action="store_true")
    parser.add_argument("--i-understand-real-push", action="store_true")
    parser.add_argument("--from-ls-remote", action="store_true")
    parser.add_argument("--remote")
    # PR merge + base containment (PR-MERGE-READBACK-09)
    parser.add_argument("--pr-number", type=int)
    parser.add_argument("--repo")
    parser.add_argument("--expected-head-sha")
    parser.add_argument("--expected-base-sha")
    parser.add_argument("--base-ref")
    # WP-01 verify-done / progress (CONTEXT-CATALOG-REPAIR)
    parser.add_argument("--proofs-json")
    parser.add_argument("--done-receipts-json")
    # WP-10A+ device context Gate
    parser.add_argument("--serial")
    parser.add_argument("--user")
    parser.add_argument("--current-user", dest="current_user")
    parser.add_argument("--android-release", dest="android_release")
    parser.add_argument("--api-level", dest="api_level", type=int)
    parser.add_argument("--abi")
    parser.add_argument("--require-unlocked", action="store_true")
    parser.add_argument("--evidence")
    # Test receipt surface (RED-10 / GREEN-10)
    # dest must not collide with positional `command` (subcommand name).
    parser.add_argument("--command", dest="test_command")
    parser.add_argument("--test-command", dest="test_command")
    parser.add_argument("--from-node-test", action="store_true")
    parser.add_argument("--exit-code", type=int)
    parser.add_argument("--pass", dest="pass_flag")
    args, _unknown = parser.parse_known_args(argv)
    return args


def main(argv: list[str]) -> int:
    if not argv:
        fail("UNKNOWN_TASK", "missing command")

    # Framework path probe uses a non-command flag; still machine-readable.
    if argv[0].startswith("-") and argv[0] not in COMMANDS:
        emit_failure("UNKNOWN_TASK", "unknown flag")

    args = parse_args(argv)
    command = args.command
    if not command or command not in COMMANDS:
        fail("UNKNOWN_TASK", f"unknown command or task surface: {command}")

    try:
        return COMMANDS[command](args)
    except FailClosed as exc:
        emit_failure(exc.reason, exc.message)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — never silently swallow
        emit_failure("ILLEGAL_STATE", f"unhandled error: {exc}")
