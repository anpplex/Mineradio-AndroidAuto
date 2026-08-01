'use strict';

/**
 * Helpers for WP-INFRA catalog/schema fail-closed contract tests (RED-02).
 * Fixtures live under isolated temp dirs — never historical verification trees.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const catalogToolPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'generate-wallpaper-task-catalog.py',
);
const defaultSchemaPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-task.schema.json',
);
const defaultCatalogPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-plugin-tasks.json',
);

/** Machine-readable failure tokens expected from catalog/schema validation. */
const CatalogFailureReason = Object.freeze({
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  UNKNOWN_TASK: 'UNKNOWN_TASK',
  DUPLICATE_TASK_ID: 'DUPLICATE_TASK_ID',
  UNKNOWN_DEPENDENCY: 'UNKNOWN_DEPENDENCY',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  ILLEGAL_STATE: 'ILLEGAL_STATE',
  CALLER_DECLARED_DONE: 'CALLER_DECLARED_DONE',
  ILLEGAL_EVIDENCE_LEVEL: 'ILLEGAL_EVIDENCE_LEVEL',
  EFFECTIVE_GATE_REQUIRED: 'EFFECTIVE_GATE_REQUIRED',
  CATALOG_INJECTION_REJECTED: 'CATALOG_INJECTION_REJECTED',
  SCHEMA_INJECTION_REJECTED: 'SCHEMA_INJECTION_REJECTED',
});

/** Required task fields from WALLPAPER-PLUGIN-DEVELOPMENT §4.1.1. */
const REQUIRED_TASK_FIELDS = Object.freeze([
  'taskId',
  'dependsOn',
  'requiredEffectiveDone',
  'phaseCommands',
  'expectedExit',
  'failureSignaturePolicy',
  'scopeCheck',
]);

const KNOWN_TASK_IDS = Object.freeze([
  'WP-INFRA',
  'WP-00',
  'WP-01',
  'WP-02',
  'WP-03',
  'WP-04',
  'WP-05',
  'WP-06',
  'WP-07',
  'WP-08',
  'WP-09',
  'WP-10A',
  'WP-10B',
  'WP-10C',
  'WP-11A',
  'WP-11B',
  'WP-11C',
  'WP-12A',
  'WP-12B',
  'WP-12C',
  'WP-12D',
  'WP-12E',
]);

const LEGAL_EVIDENCE_LEVELS = Object.freeze([
  'E0',
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'E7',
]);

function ensureCatalogToolPresent() {
  if (!fs.existsSync(catalogToolPath)) {
    throw new Error(`catalog tool missing (test framework path error): ${catalogToolPath}`);
  }
  if (!fs.existsSync(defaultSchemaPath)) {
    throw new Error(`schema missing (test framework path error): ${defaultSchemaPath}`);
  }
}

function makeCatalogSandbox(prefix = 'wp-infra-catalog-red-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root };
}

function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

/**
 * Minimal phaseCommands shape used by invalid fixtures that still need the key present.
 */
function minimalPhaseCommands(taskId) {
  return {
    RED: { commandId: `${taskId}-RED`, argv: ['true'] },
    GREEN: { commandId: `${taskId}-GREEN`, argv: ['true'] },
    REFACTOR: { commandId: `${taskId}-REFACTOR`, argv: ['true'] },
    VERIFY: { commandId: `${taskId}-VERIFY`, argv: ['true'] },
  };
}

function minimalTask(taskId, overrides = {}) {
  return {
    taskId,
    dependsOn: [],
    requiredEffectiveDone: [],
    phaseCommands: minimalPhaseCommands(taskId),
    expectedExit: { RED: 1, GREEN: 0, REFACTOR: 0, VERIFY: 0 },
    failureSignaturePolicy: { RED: { required: true, match: 'stderr' } },
    scopeCheck: {
      repo: 'mineradio',
      exactFiles: [],
    },
    evidenceLevel: 'E0',
    ...overrides,
  };
}

function minimalCatalog(tasks) {
  return {
    schemaVersion: 'wallpaper-task-catalog/v1',
    tasks,
  };
}

function runCatalogTool(args, options = {}) {
  ensureCatalogToolPresent();
  const env = { ...process.env, ...(options.env || {}) };
  if (!options.keepAmbientOverrides) {
    delete env.WALLPAPER_TASK_CATALOG;
    delete env.WALLPAPER_TASK_SCHEMA;
    delete env.CATALOG_PATH;
    delete env.SCHEMA_PATH;
  }
  const result = spawnSync('python3', [catalogToolPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env,
    timeout: options.timeout || 15_000,
  });
  if (result.error) {
    const err = result.error;
    err.message = `catalog tool spawn failed (environment/path): ${err.message}`;
    throw err;
  }
  return {
    status: result.status === null ? 1 : result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    combined: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

/**
 * Validate a catalog document against the schema using the catalog tool.
 * Production CLI (GREEN-02): validate --catalog <path> --schema <path>
 */
function validateCatalog(catalogPath, schemaPath = defaultSchemaPath, extraArgs = []) {
  return runCatalogTool([
    'validate',
    '--catalog',
    catalogPath,
    '--schema',
    schemaPath,
    ...extraArgs,
  ]);
}

/**
 * Assert WP-00 may start only when WP-INFRA EffectiveGate is true.
 * Production CLI: assert-ready --task WP-00 --infra-effective-gate <bool>
 */
function assertTaskReady(taskId, options = {}) {
  const args = ['assert-ready', '--task', taskId];
  if (Object.prototype.hasOwnProperty.call(options, 'infraEffectiveGate')) {
    args.push('--infra-effective-gate', String(options.infraEffectiveGate));
  }
  if (options.catalogPath) {
    args.push('--catalog', options.catalogPath);
  }
  if (options.schemaPath) {
    args.push('--schema', options.schemaPath);
  }
  return runCatalogTool(args, { env: options.env, keepAmbientOverrides: options.keepAmbientOverrides });
}

function assertFailClosed(result, expectedReason, label = '') {
  const prefix = label ? `${label}: ` : '';
  if (result.status === 0) {
    throw new Error(
      `${prefix}expected fail-closed non-zero exit\n` +
        `status=${result.status}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  const text = result.combined;
  const jsonMatch = text.match(/"failureReason"\s*:\s*"([A-Z0-9_]+)"/);
  const lineMatch = text.match(
    /(?:^|\n)\s*(?:failureReason|FAILURE_REASON|errorCode)\s*[=:]\s*([A-Z0-9_]+)/i,
  );
  const tokenMatch = text.includes(expectedReason) ? expectedReason : null;
  const observed = (jsonMatch && jsonMatch[1]) || (lineMatch && lineMatch[1]) || tokenMatch;
  if (!observed) {
    throw new Error(
      `${prefix}missing machine-readable failure reason ${expectedReason}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  if (observed !== expectedReason) {
    throw new Error(
      `${prefix}failure reason mismatch: expected ${expectedReason}, got ${observed}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }
}

module.exports = {
  CatalogFailureReason,
  REQUIRED_TASK_FIELDS,
  KNOWN_TASK_IDS,
  LEGAL_EVIDENCE_LEVELS,
  repoRoot,
  catalogToolPath,
  defaultSchemaPath,
  defaultCatalogPath,
  ensureCatalogToolPresent,
  makeCatalogSandbox,
  writeJson,
  minimalPhaseCommands,
  minimalTask,
  minimalCatalog,
  runCatalogTool,
  validateCatalog,
  assertTaskReady,
  assertFailClosed,
};
