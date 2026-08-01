#!/usr/bin/env python3
"""Mineradio wallpaper plugin transaction runner (WP-INFRA minimal core).

Fail-closed gates for:
  - task identity / caller-supplied identity
  - evidence path containment and no-clobber
  - writer leases
  - durable receipt init, revision/state CAS, atomic fsync replace, readback
  - IN_FLIGHT recovery and append-only attempts

Does not yet implement catalog-bound phases, exact origin sync, or PR flow.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterator, Mapping, NoReturn

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
