'use strict';

/**
 * WP-01 / CONTEXT-CATALOG-REPAIR — RED contract tests.
 *
 * Pins missing mainline closures:
 * - runner task-branch allowlist (not only wallpaper-plugin-infra)
 * - catalog WP-01 entry (weight 6)
 * - production verify-done fail-closed path
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..', '..');
const runner = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');
const schemaPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.schema.json');
const catalogTool = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'generate-wallpaper-task-catalog.py',
);
const contextPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task-context.js');

function git(args, cwd = repoRoot) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function runRunner(args, options = {}) {
  const r = spawnSync('python3', [runner, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    combined: `${r.stdout || ''}\n${r.stderr || ''}`,
  };
}

function runCatalog(args) {
  const r = spawnSync('python3', [catalogTool, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    status: r.status === null ? 1 : r.status,
    combined: `${r.stdout || ''}\n${r.stderr || ''}`,
  };
}

function headSha() {
  return git(['rev-parse', 'HEAD']).stdout;
}

function branchName() {
  return git(['branch', '--show-current']).stdout;
}

function tempReceipt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp01-repair-'));
  return path.join(dir, 'wp-01.json');
}

// ---------------------------------------------------------------------------
// Framework sanity
// ---------------------------------------------------------------------------

test('REPAIR RED: worktree is live wallpaper-plugin-* task branch on base tip', () => {
  const b = branchName();
  assert.match(b, /^codex\/wallpaper-plugin-/);
  assert.notEqual(b, 'main');
  assert.notEqual(b, 'master');
  assert.notEqual(b, 'huawei-android12-car');
  const head = headSha();
  assert.match(head, /^[0-9a-f]{40}$/);
  const base = git(['rev-parse', 'origin/huawei-android12-car']).stdout;
  assert.match(base, /^[0-9a-f]{40}$/);
  // Repair commits may advance HEAD beyond base tip; base remains live origin fact.
  assert.equal(fs.existsSync(runner), true);
  assert.equal(fs.existsSync(contextPath), true);
  assert.equal(fs.existsSync(catalogPath), true);
});

// ---------------------------------------------------------------------------
// A. task branch context / exact-push binding
// ---------------------------------------------------------------------------

test('REPAIR RED-A.1 exact-push dry-run must accept live codex/wallpaper-plugin-* (or codex/wp01-*) branch', () => {
  // Desired: runner binds current live branch, not only wallpaper-plugin-infra.
  const head = headSha();
  const branch = branchName();
  const ref = `refs/heads/${branch}`;
  const receipt = tempReceipt();
  // minimal bootstrap receipt file for command parse path
  const payload = JSON.stringify({
      schema: 'wallpaper-infra-bootstrap/v1',
      taskId: 'WP-INFRA',
      state: 'INIT',
      revision: 1,
      EffectiveDone: false,
      EffectiveGate: false,
    }) + '\n';
  fs.writeFileSync(receipt, payload, { mode: 0o600 });
  fs.chmodSync(receipt, 0o600);
  const result = runRunner([
    'bootstrap-exact-push',
    '--receipt',
    receipt,
    '--ref',
    ref,
    '--expected-sha',
    head,
    '--remote',
    'origin',
    '--dry-run',
  ]);
  assert.equal(
    result.status,
    0,
    `CONTEXT_HARDCODED: dry-run must accept live branch ${branch}\n${result.combined}`,
  );
  assert.match(result.combined, /dry-run|exact-push/i);
  assert.doesNotMatch(result.combined, /must be on codex\/wallpaper-plugin-infra/);
});

test('REPAIR RED-A.2 exact-push dry-run must reject main/master/base as ref', () => {
  const head = headSha();
  const receipt = tempReceipt();
  fs.writeFileSync(
    receipt,
    JSON.stringify({
      schema: 'wallpaper-infra-bootstrap/v1',
      taskId: 'WP-INFRA',
      state: 'INIT',
      revision: 1,
      EffectiveDone: false,
    }) + '\n',
    { mode: 0o600 },
  );
  fs.chmodSync(receipt, 0o600);
  for (const bad of ['main', 'master', 'huawei-android12-car']) {
    const result = runRunner([
      'bootstrap-exact-push',
      '--receipt',
      receipt,
      '--ref',
      `refs/heads/${bad}`,
      '--expected-sha',
      head,
      '--remote',
      'origin',
      '--dry-run',
    ]);
    assert.notEqual(result.status, 0, `must reject ${bad}`);
    assert.match(result.combined, /BRANCH_NOT_ALLOWED|REF_NOT_ALLOWED/i);
  }
});

// ---------------------------------------------------------------------------
// B. catalog WP-01
// ---------------------------------------------------------------------------

test('REPAIR RED-B.1 authoritative catalog must include unique WP-01 with weight 6', () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const wp01 = (catalog.tasks || []).filter((t) => t.taskId === 'WP-01');
  assert.equal(
    wp01.length,
    1,
    'CATALOG_WP01_MISSING: catalog must contain exactly one WP-01 entry',
  );
  assert.equal(wp01[0].weight, 6, 'WP-01 weight must be 6');
  assert.equal(wp01[0].path || wp01[0].scopeCheck?.path, 'wallpaper-plugin/');
  const product = wp01[0].product || wp01[0].scopeCheck?.product;
  assert.equal(product, 'Wallpaper Engine');
});

test('REPAIR RED-B.2 catalog validate must pass for authoritative catalog including WP-01', () => {
  const result = runCatalog(['validate', '--catalog', catalogPath, '--schema', schemaPath]);
  assert.equal(result.status, 0, `catalog validate failed\n${result.combined}`);
});

// ---------------------------------------------------------------------------
// C. production verify-done
// ---------------------------------------------------------------------------

test('REPAIR RED-C.1 verify-done command must exist as production surface', () => {
  const result = runRunner(['verify-done', '--task', 'WP-01']);
  // Missing receipt / proofs => fail closed is OK; UNKNOWN command is not.
  assert.doesNotMatch(
    result.combined,
    /unknown command|UNKNOWN_TASK.*verify-done|unknown command or task surface: verify-done/i,
    'WP01_VERIFY_DONE_UNAVAILABLE: verify-done must be a registered command',
  );
});

test('REPAIR RED-C.2 verify-done must fail-closed without proofs (EffectiveDone stays false)', () => {
  const receipt = tempReceipt();
  const init = runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]);
  assert.equal(init.status, 0, `receipt-init failed\n${init.combined}`);
  const result = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
  ]);
  assert.notEqual(result.status, 0, 'verify-done must fail without proofs');
  assert.match(
    result.combined,
    /VERIFY_DONE|MISSING|PROOF|GATE|REQUIRED|FAIL|WP01/i,
  );
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(data.EffectiveDone, false);
});

test('REPAIR RED-C.3 caller cannot CAS EffectiveDone=true', () => {
  const receipt = tempReceipt();
  const init = runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]);
  assert.equal(init.status, 0, `receipt-init failed\n${init.combined}`);
  const result = runRunner([
    'receipt-cas',
    '--receipt',
    receipt,
    '--expected-revision',
    '1',
    '--expected-state',
    'INIT',
    '--state',
    'DONE',
    '--set-json',
    JSON.stringify({ EffectiveDone: true }),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.combined,
    /ONLY_VERIFY_DONE|CALLER|EffectiveDone|ILLEGAL/i,
  );
});
