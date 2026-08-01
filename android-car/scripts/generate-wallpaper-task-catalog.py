#!/usr/bin/env python3
"""Wallpaper plugin task catalog generator/validator (WP-INFRA).

Fail-closed validation for wallpaper-plugin-tasks.json per
WALLPAPER-PLUGIN-DEVELOPMENT §4.1.1. Full plan-doc → catalog generation is deferred.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, NoReturn, Sequence

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_FAIL = 2

SCRIPT_DIR = Path(__file__).resolve().parent
CANONICAL_SCHEMA = (SCRIPT_DIR / "wallpaper-task.schema.json").resolve()
CANONICAL_CATALOG = (SCRIPT_DIR / "wallpaper-plugin-tasks.json").resolve()

KNOWN_TASK_IDS = frozenset(
    {
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

REQUIRED_TASK_FIELDS = (
    "taskId",
    "dependsOn",
    "requiredEffectiveDone",
    "phaseCommands",
    "expectedExit",
    "failureSignaturePolicy",
    "scopeCheck",
)

PHASES = ("RED", "GREEN", "REFACTOR", "VERIFY")
ZERO_EXIT_PHASES = ("GREEN", "REFACTOR", "VERIFY")

LEGAL_EVIDENCE_LEVELS = frozenset(
    {"E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"}
)

# Runtime/terminal fields must never appear as caller-authored catalog truth.
FORBIDDEN_RUNTIME_FIELDS = frozenset(
    {
        "state",
        "EffectiveDone",
        "transactionId",
        "runUuid",
        "revision",
    }
)

CALLER_DONE_FIELDS = frozenset(
    {
        "allowCallerDeclareDone",
        "proposedDone",
        "callerDeclaredDone",
        "declareDone",
    }
)

TRUTHY_GATE = frozenset({"1", "true", "yes", "on"})
FALSY_GATE = frozenset({"0", "false", "no", "off"})
CATALOG_ENV_KEYS = ("WALLPAPER_TASK_CATALOG", "CATALOG_PATH")


# ---------------------------------------------------------------------------
# Fail-closed I/O
# ---------------------------------------------------------------------------


def emit_failure(reason: str, message: str = "", exit_code: int = EXIT_FAIL) -> NoReturn:
    payload = {
        "ok": False,
        "failureReason": reason,
        "message": message or reason,
    }
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    print(text, file=sys.stderr)
    print(text, file=sys.stdout)
    raise SystemExit(exit_code)


def emit_ok(command: str, **fields: Any) -> int:
    payload = {"ok": True, "command": command, **fields}
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        emit_failure("MISSING_REQUIRED_FIELD", f"file not found: {path}")
    except (OSError, json.JSONDecodeError) as exc:
        emit_failure("ILLEGAL_STATE", f"invalid JSON at {path}: {exc}")


def resolve_path(raw: str | None) -> Path | None:
    if raw is None:
        return None
    return Path(raw).expanduser().resolve()


def parse_bool_gate(raw: str | None, *, field: str) -> bool | None:
    """Return True/False for known tokens, None if missing, fail on garbage."""
    if raw is None:
        return None
    token = str(raw).strip().lower()
    if token in TRUTHY_GATE:
        return True
    if token in FALSY_GATE:
        return False
    emit_failure("ILLEGAL_STATE", f"illegal {field} value: {raw!r}")


# ---------------------------------------------------------------------------
# Path / identity guards
# ---------------------------------------------------------------------------


def enforce_canonical_schema(schema_path: Path | None, require: bool) -> Path:
    path = schema_path or CANONICAL_SCHEMA
    if require and path.resolve() != CANONICAL_SCHEMA:
        emit_failure(
            "SCHEMA_INJECTION_REJECTED",
            f"non-canonical schema rejected: {path}",
        )
    return path


def enforce_canonical_catalog(catalog_path: Path | None, require: bool) -> Path:
    if require and any(os.environ.get(key) for key in CATALOG_ENV_KEYS):
        emit_failure(
            "CATALOG_INJECTION_REJECTED",
            "environment catalog injection rejected under --require-canonical-catalog",
        )
    path = catalog_path or CANONICAL_CATALOG
    if require and path.resolve() != CANONICAL_CATALOG:
        emit_failure(
            "CATALOG_INJECTION_REJECTED",
            f"non-canonical catalog rejected: {path}",
        )
    return path


# ---------------------------------------------------------------------------
# Field validators
# ---------------------------------------------------------------------------


def as_task_list(catalog: Any) -> list[dict[str, Any]]:
    if not isinstance(catalog, dict):
        emit_failure("ILLEGAL_STATE", "catalog root must be an object")
    tasks = catalog.get("tasks")
    if not isinstance(tasks, list):
        emit_failure("MISSING_REQUIRED_FIELD", "catalog.tasks must be an array")
    result: list[dict[str, Any]] = []
    for index, item in enumerate(tasks):
        if not isinstance(item, dict):
            emit_failure("ILLEGAL_STATE", f"tasks[{index}] must be an object")
        result.append(item)
    return result


def require_unique_string_list(value: Any, field: str, task_id: str) -> list[str]:
    if not isinstance(value, list):
        emit_failure(
            "MISSING_REQUIRED_FIELD",
            f"{task_id}.{field} must be an array of task ids",
        )
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item:
            emit_failure(
                "ILLEGAL_STATE",
                f"{task_id}.{field} entries must be non-empty strings",
            )
        out.append(item)
    if len(out) != len(set(out)):
        emit_failure("ILLEGAL_STATE", f"{task_id}.{field} has duplicates")
    return out


def validate_required_fields(task: Mapping[str, Any]) -> str:
    missing = [field for field in REQUIRED_TASK_FIELDS if field not in task]
    if missing:
        emit_failure(
            "MISSING_REQUIRED_FIELD",
            f"task missing required fields: {','.join(missing)}",
        )
    task_id = task.get("taskId")
    if not isinstance(task_id, str) or not task_id:
        emit_failure("MISSING_REQUIRED_FIELD", "taskId must be a non-empty string")
    return task_id


def validate_phase_commands(task_id: str, phase_commands: Any) -> None:
    if not isinstance(phase_commands, dict):
        emit_failure(
            "MISSING_REQUIRED_FIELD",
            f"{task_id}.phaseCommands must be an object",
        )
    for phase in PHASES:
        if phase not in phase_commands:
            emit_failure(
                "MISSING_REQUIRED_FIELD",
                f"{task_id}.phaseCommands missing {phase}",
            )
        command = phase_commands[phase]
        if not isinstance(command, dict):
            emit_failure(
                "ILLEGAL_STATE",
                f"{task_id}.phaseCommands.{phase} must be object",
            )
        if "commandId" not in command or "argv" not in command:
            emit_failure(
                "MISSING_REQUIRED_FIELD",
                f"{task_id}.phaseCommands.{phase} requires commandId and argv",
            )
        if not isinstance(command.get("argv"), list):
            emit_failure(
                "ILLEGAL_STATE",
                f"{task_id}.phaseCommands.{phase}.argv must be an array",
            )


def validate_expected_exit(task_id: str, expected_exit: Any) -> None:
    if not isinstance(expected_exit, dict):
        emit_failure(
            "MISSING_REQUIRED_FIELD",
            f"{task_id}.expectedExit must be an object",
        )
    for phase in PHASES:
        if phase not in expected_exit:
            emit_failure(
                "MISSING_REQUIRED_FIELD",
                f"{task_id}.expectedExit missing {phase}",
            )
    # GREEN/VERIFY/REFACTOR must be 0; RED must be non-zero (or non-zero set).
    for phase in ZERO_EXIT_PHASES:
        value = expected_exit[phase]
        if value != 0:
            emit_failure(
                "ILLEGAL_STATE",
                f"{task_id}.expectedExit.{phase} must be 0 (got {value!r})",
            )
    red = expected_exit["RED"]
    if isinstance(red, int):
        if red == 0:
            emit_failure("ILLEGAL_STATE", f"{task_id}.expectedExit.RED must be non-zero")
        return
    if isinstance(red, list):
        if not red or any(not isinstance(item, int) or item == 0 for item in red):
            emit_failure(
                "ILLEGAL_STATE",
                f"{task_id}.expectedExit.RED set must be non-empty non-zero integers",
            )
        return
    emit_failure("ILLEGAL_STATE", f"{task_id}.expectedExit.RED has illegal type")


def validate_runtime_fields(task_id: str, task: Mapping[str, Any]) -> None:
    for field in FORBIDDEN_RUNTIME_FIELDS:
        if field in task:
            emit_failure(
                "ILLEGAL_STATE",
                f"{task_id} must not embed runtime field {field}",
            )
    for field in CALLER_DONE_FIELDS:
        if task.get(field) is True:
            emit_failure(
                "CALLER_DECLARED_DONE",
                f"{task_id} forbids caller-declared DONE via {field}",
            )


def validate_evidence_level(task_id: str, task: Mapping[str, Any]) -> None:
    if "evidenceLevel" not in task:
        return
    level = task.get("evidenceLevel")
    if level not in LEGAL_EVIDENCE_LEVELS:
        emit_failure(
            "ILLEGAL_EVIDENCE_LEVEL",
            f"{task_id}.evidenceLevel illegal: {level!r}",
        )


def validate_object_field(task_id: str, task: Mapping[str, Any], field: str) -> None:
    if not isinstance(task.get(field), dict):
        emit_failure(
            "MISSING_REQUIRED_FIELD",
            f"{task_id}.{field} must be an object",
        )


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------


def detect_cycle(edges: Mapping[str, Sequence[str]]) -> list[str] | None:
    """Return one cycle path if present, else None. Stable by taskId order."""
    visiting: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = []

    def dfs(node: str) -> list[str] | None:
        if node in visiting:
            if node in stack:
                return stack[stack.index(node) :] + [node]
            return [node, node]
        if node in visited:
            return None
        visiting.add(node)
        stack.append(node)
        for nxt in edges.get(node, ()):
            found = dfs(nxt)
            if found is not None:
                return found
        stack.pop()
        visiting.remove(node)
        visited.add(node)
        return None

    for node in sorted(edges):
        found = dfs(node)
        if found is not None:
            return found
    return None


def validate_task_local(
    task: Mapping[str, Any],
    *,
    index: int,
    seen: dict[str, int],
) -> tuple[str, list[str]]:
    """Validate one task's local fields. Returns (taskId, dependsOn)."""
    task_id = validate_required_fields(task)
    if task_id in seen:
        emit_failure(
            "DUPLICATE_TASK_ID",
            f"duplicate taskId {task_id} at indexes {seen[task_id]} and {index}",
        )
    seen[task_id] = index
    if task_id not in KNOWN_TASK_IDS:
        emit_failure("UNKNOWN_TASK", f"unknown task id: {task_id}")

    depends_on = require_unique_string_list(task["dependsOn"], "dependsOn", task_id)
    required_done = require_unique_string_list(
        task["requiredEffectiveDone"], "requiredEffectiveDone", task_id
    )

    validate_phase_commands(task_id, task["phaseCommands"])
    validate_expected_exit(task_id, task["expectedExit"])
    validate_object_field(task_id, task, "failureSignaturePolicy")
    validate_object_field(task_id, task, "scopeCheck")
    validate_runtime_fields(task_id, task)
    validate_evidence_level(task_id, task)

    # requiredEffectiveDone ⊆ dependsOn
    depends_set = set(depends_on)
    for dep in required_done:
        if dep not in depends_set:
            emit_failure(
                "MISSING_DEPENDENCY",
                f"{task_id}.requiredEffectiveDone contains {dep} not in dependsOn",
            )

    return task_id, depends_on


def validate_dependency_endpoints(
    edges: Mapping[str, Sequence[str]],
    catalog_ids: set[str],
) -> None:
    for task_id, deps in edges.items():
        for dep in deps:
            if dep in catalog_ids:
                continue
            # Missing from this catalog graph — never inventable.
            emit_failure(
                "UNKNOWN_DEPENDENCY",
                f"{task_id} depends on unknown task {dep}"
                if dep not in KNOWN_TASK_IDS
                else f"{task_id} depends on {dep} which is not present in catalog",
            )


def validate_catalog_document(catalog: Any) -> list[dict[str, Any]]:
    tasks = as_task_list(catalog)
    seen: dict[str, int] = {}
    edges: dict[str, list[str]] = {}
    catalog_ids: set[str] = set()
    validated: list[dict[str, Any]] = []

    for index, task in enumerate(tasks):
        task_id, depends_on = validate_task_local(task, index=index, seen=seen)
        edges[task_id] = list(depends_on)
        catalog_ids.add(task_id)
        validated.append(dict(task))

    validate_dependency_endpoints(edges, catalog_ids)

    cycle = detect_cycle(edges)
    if cycle is not None:
        emit_failure(
            "DEPENDENCY_CYCLE",
            f"dependency cycle detected: {' -> '.join(cycle)}",
        )

    return validated


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_validate(args: argparse.Namespace) -> int:
    schema_path = enforce_canonical_schema(
        resolve_path(args.schema),
        require=bool(args.require_canonical_schema),
    )
    catalog_path = enforce_canonical_catalog(
        resolve_path(args.catalog),
        require=bool(args.require_canonical_catalog),
    )

    if not schema_path.is_file():
        emit_failure("MISSING_REQUIRED_FIELD", f"schema not found: {schema_path}")
    schema = load_json(schema_path)
    if not isinstance(schema, dict):
        emit_failure("ILLEGAL_STATE", "schema root must be an object")

    if not catalog_path.is_file():
        emit_failure("MISSING_REQUIRED_FIELD", f"catalog not found: {catalog_path}")
    catalog = load_json(catalog_path)
    tasks = validate_catalog_document(catalog)
    return emit_ok(
        "validate",
        catalog=str(catalog_path),
        schema=str(schema_path),
        taskCount=len(tasks),
    )


def cmd_assert_ready(args: argparse.Namespace) -> int:
    task_id = args.task
    if not task_id:
        emit_failure("UNKNOWN_TASK", "missing --task")
    if task_id not in KNOWN_TASK_IDS:
        emit_failure("UNKNOWN_TASK", f"unknown task id: {task_id}")

    catalog_path = enforce_canonical_catalog(
        resolve_path(args.catalog),
        require=bool(args.require_canonical_catalog),
    )
    schema_path = enforce_canonical_schema(
        resolve_path(args.schema),
        require=bool(args.require_canonical_schema),
    )
    if catalog_path.is_file():
        validate_catalog_document(load_json(catalog_path))

    # All non-INFRA tasks require WP-INFRA EffectiveGate.
    if task_id != "WP-INFRA":
        gate = parse_bool_gate(
            args.infra_effective_gate,
            field="--infra-effective-gate",
        )
        if gate is None:
            emit_failure(
                "EFFECTIVE_GATE_REQUIRED",
                "missing --infra-effective-gate for non-WP-INFRA task",
            )
        if gate is False:
            emit_failure(
                "EFFECTIVE_GATE_REQUIRED",
                f"{task_id} cannot start while WP-INFRA EffectiveGate=false",
            )

    return emit_ok(
        "assert-ready",
        taskId=task_id,
        schema=str(schema_path),
        catalog=str(catalog_path),
    )


COMMANDS = {
    "validate": cmd_validate,
    "assert-ready": cmd_assert_ready,
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="generate-wallpaper-task-catalog.py",
        add_help=False,
    )
    parser.add_argument("command", nargs="?", default="")
    parser.add_argument("--catalog")
    parser.add_argument("--schema")
    parser.add_argument("--task")
    parser.add_argument("--infra-effective-gate")
    parser.add_argument("--require-canonical-schema", action="store_true")
    parser.add_argument("--require-canonical-catalog", action="store_true")
    return parser


def main(argv: Sequence[str]) -> int:
    if not argv:
        emit_failure("UNKNOWN_TASK", "missing command")
    if argv[0].startswith("-"):
        emit_failure("UNKNOWN_TASK", "unknown flag")

    args, _unknown = build_parser().parse_known_args(list(argv))
    command = args.command
    handler = COMMANDS.get(command)
    if handler is None:
        emit_failure("UNKNOWN_TASK", f"unknown command: {command}")
    return handler(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — never silently swallow
        emit_failure("ILLEGAL_STATE", f"unhandled error: {exc}")
