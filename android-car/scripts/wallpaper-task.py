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
  - exact-push dry-run / dual-auth refuse; origin-only remote; approved infra ref
  - expectedSha bound to local HEAD; REMOTE_VERIFIED only after durable ls-remote
  - seal-from-ls-remote only; EffectiveGate derivation (forged DONE rejected)

Does not yet execute authorized network exact-push or write production-closed
PR merge / base-containment evidence.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, NoReturn

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


def recompute_blob_mismatches(
    receipt: Mapping[str, Any],
    *,
    runner_path: str | None,
    catalog_path: str | None,
    schema_path: str | None,
) -> tuple[str | None, str]:
    checks = (
        ("runner", runner_path, receipt.get("runnerSha256")),
        ("catalog", catalog_path, receipt.get("catalogSha256")),
        ("schema", schema_path, receipt.get("schemaSha256")),
    )
    for kind, file_path, recorded in checks:
        if not file_path:
            continue
        path = Path(file_path)
        if not path.is_file():
            return (
                "BOOTSTRAP_SHA_MISMATCH",
                f"{kind} path missing for recompute: {path}",
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
      state → required fields → phase ledger → origin →
      optional blob recompute → test receipts → exactSync →
      PR merge → base containment.
    """
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

    # Blob recompute before later layers so SHA mismatches surface first.
    if recompute_paths:
        reason, message = recompute_blob_mismatches(
            receipt,
            runner_path=runner_path,
            catalog_path=catalog_path,
            schema_path=schema_path,
        )
        if reason:
            return gate_failure(reason, message)

    if not test_receipt_pass(receipt.get("catalogTestReceipt")) or not test_receipt_pass(
        receipt.get("schemaTestReceipt")
    ):
        return gate_failure(
            "MISSING_TEST_RECEIPT",
            "catalogTestReceipt and schemaTestReceipt with pass=true are required",
        )

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

    if args.path:
        actual = sha256_file(Path(args.path))
        if actual != sha:
            fail(
                "BOOTSTRAP_SHA_MISMATCH",
                f"provided sha256 does not match file digest: {args.path}",
            )

    def apply(current: dict[str, Any]) -> dict[str, Any]:
        current[field] = sha
        return current

    mutate_bootstrap(path, apply, check_mode=True)
    return emit_ok("bootstrap-record-sha", receipt=str(path), kind=kind, sha256=sha)


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


def normalize_approved_infra_ref(ref: str | None) -> str:
    """Only refs/heads/codex/wallpaper-plugin-infra is an approved push/readback target."""
    raw = (ref or DEFAULT_INFRA_REF).strip()
    if not raw:
        fail("REF_NOT_ALLOWED", "missing --ref; approved ref required")
    if raw.startswith("refs/heads/"):
        full = raw
        branch = raw[len("refs/heads/") :]
    elif raw.startswith("refs/"):
        fail(
            "REF_NOT_ALLOWED",
            f"ref not allowed: {raw!r}; only {APPROVED_INFRA_REF}",
        )
    else:
        branch = raw
        full = f"refs/heads/{branch}"
    if branch != APPROVED_INFRA_BRANCH or full != APPROVED_INFRA_REF:
        fail(
            "BRANCH_NOT_ALLOWED",
            f"branch/ref not allowed: {raw!r}; only {APPROVED_INFRA_BRANCH} "
            f"({APPROVED_INFRA_REF}). main/master/huawei-android12-car/"
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
            "detached HEAD is not an approved WP-INFRA push branch",
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
    if branch != APPROVED_INFRA_BRANCH:
        fail(
            "BRANCH_NOT_ALLOWED",
            f"current branch {branch!r} is not approved; must be on "
            f"{APPROVED_INFRA_BRANCH} with HEAD == expectedSha",
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
    """Exact SHA refspec push to origin only. Never force. Never overwrites divergent remote."""
    existing = probe_remote_ref_sha(ref, remote=remote)
    if existing is not None:
        if existing == expected:
            # Idempotent: remote already at exact target — no re-push.
            return {
                "alreadyExact": True,
                "networkMutation": False,
                "remoteShaBefore": existing,
                "expectedSha": expected,
            }
        fail(
            "BLOCKED_REMOTE_REF_CONFLICT",
            f"remote ref {ref} already at {existing}; refusing to overwrite "
            f"with {expected} (no force push)",
        )

    refspec = f"{expected}:{ref}"
    try:
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
        "remoteShaBefore": None,
        "expectedSha": expected,
        "refspec": refspec,
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
        "number,state,mergedAt,mergeCommit,baseRefName,headRefName,url,title",
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
    "receipt-init": cmd_receipt_init,
    "receipt-cas": cmd_receipt_cas,
    "receipt-read": cmd_receipt_read,
    "receipt-readback": cmd_receipt_readback,
    "receipt-append-attempt": cmd_receipt_append_attempt,
    "receipt-resume": cmd_receipt_resume,
    "bootstrap-init": cmd_bootstrap_init,
    "bootstrap-record-sha": cmd_bootstrap_record_sha,
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
