'use strict';

/**
 * WP-12 dual-origin readback — fail-closed unit outline.
 *
 * Uses a temp ledger + real worktrees when present. Never force-pushes.
 * Never forges BOOTSTRAP_PUSHED without dual proofs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '../..');
const bootstrapPy = path.join(repoRoot, 'android-car/scripts/wp12-bootstrap.py');

const DEFAULT_PLUGIN_WT =
  '/Users/anpple/Codex/WallpaperEngine/.worktrees/mineradio-plugin-embedded-runtime';
const DEFAULT_MINERADIO_WT =
  '/Users/anpple/Codex/Mineradio/.worktrees/wallpaper-plugin-experimental';

function runBootstrap(args, env = {}) {
  const result = spawnSync('python3', [bootstrapPy, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: repoRoot,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  let json = null;
  for (const stream of [stdout, stderr]) {
    const line = stream
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{'));
    if (line) {
      try {
        json = JSON.parse(line);
        break;
      } catch {
        // keep scanning
      }
    }
  }
  return {
    status: result.status,
    stdout,
    stderr,
    json,
    combined: `${stdout}\n${stderr}`,
  };
}

function tempLedger(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp12-bootstrap-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const base = {
    schema: 'wp12-bootstrap/v1',
    taskId: 'WP-12-BOOTSTRAP',
    BOOTSTRAP_STATE: 'BASESHA_FROZEN_LOCAL',
    BOOTSTRAP_PUSHED: false,
    EffectiveDone: false,
    revision: 1,
    transactionId: 'test-txn',
    runUuid: 'test-run',
    createdAt: '2026-08-07T00:00:00Z',
    updatedAt: '2026-08-07T00:00:00Z',
    plugin: { worktree: DEFAULT_PLUGIN_WT },
    mineradio: { worktree: DEFAULT_MINERADIO_WT },
    tooling: { pluginBootstrapFilesComplete: false },
    pluginOriginReadback: null,
    mineradioOriginReadback: null,
    pluginToolCheck: null,
    mineradioToolCheck: null,
    notes: ['unit test ledger'],
    blockers: [],
    ...overrides,
  };
  fs.writeFileSync(ledgerPath, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
  return { dir, ledgerPath };
}

test('wp12-bootstrap.py exists and is executable surface', () => {
  assert.equal(fs.existsSync(bootstrapPy), true);
});

test('claim-bootstrap-pushed refuses --claim-pushed forge flag', () => {
  const { ledgerPath } = tempLedger();
  const r = runBootstrap(['claim-bootstrap-pushed', '--ledger', ledgerPath, '--claim-pushed']);
  assert.notEqual(r.status, 0);
  assert.equal(r.json && r.json.failureReason, 'FORGED_BOOTSTRAP_PUSHED');
});

test('claim-bootstrap-pushed refuses incomplete dual proofs', () => {
  const { ledgerPath } = tempLedger();
  const r = runBootstrap(['claim-bootstrap-pushed', '--ledger', ledgerPath]);
  assert.notEqual(r.status, 0);
  assert.equal(r.json && r.json.failureReason, 'BOOTSTRAP_PUSHED_UNPROVEN');
});

test('init-local refuses env BOOTSTRAP_PUSHED forge', () => {
  const { ledgerPath } = tempLedger();
  // init-local also needs real receipts/worktrees; forge path should fail first.
  const r = runBootstrap(['init-local', '--ledger', ledgerPath], {
    BOOTSTRAP_PUSHED: 'true',
  });
  assert.notEqual(r.status, 0);
  assert.equal(r.json && r.json.failureReason, 'FORGED_BOOTSTRAP_PUSHED');
});

test('status reports dualProofs incomplete when ledger has no readbacks', () => {
  const { ledgerPath } = tempLedger();
  const r = runBootstrap(['status', '--ledger', ledgerPath]);
  assert.equal(r.status, 0);
  assert.equal(r.json && r.json.ok, true);
  assert.equal(r.json.BOOTSTRAP_PUSHED, false);
  assert.equal(r.json.dualProofs && r.json.dualProofs.complete, false);
});

test('record-origin-readback refuses expected mismatch (live origin)', (t) => {
  if (!fs.existsSync(DEFAULT_PLUGIN_WT)) {
    t.skip('plugin worktree not present');
    return;
  }
  const { ledgerPath } = tempLedger();
  const r = runBootstrap([
    'record-origin-readback',
    '--role',
    'plugin',
    '--ref',
    'refs/heads/main',
    '--expected-sha',
    '0000000000000000000000000000000000000001',
    '--plugin-worktree',
    DEFAULT_PLUGIN_WT,
    '--ledger',
    ledgerPath,
  ]);
  assert.notEqual(r.status, 0);
  assert.equal(r.json && r.json.failureReason, 'ORIGIN_SHA_MISMATCH');
});
