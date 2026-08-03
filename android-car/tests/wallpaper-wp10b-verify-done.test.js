'use strict';

/**
 * WP-10B VERIFY-DONE — production path exists and fail-closes without E4 proofs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(
  repoRoot,
  'android-car',
  'scripts',
  'wallpaper-plugin-tasks.json',
);

function runRunner(argv) {
  return spawnSync('python3', [runnerPath, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('WP-10B VERIFY-DONE: production evaluate_wp10b_verify_done path exists', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /def evaluate_wp10b_verify_done/);
  assert.match(src, /WP10B_E4_|task_id == "WP-10B"/);
});

test('WP-10B VERIFY-DONE: catalog WP-10B weight 8 E4', () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === 'WP-10B');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].weight, 8);
  assert.equal(matches[0].evidenceLevel, 'E4');
});

test('WP-10B VERIFY-DONE: bare verify-done fails closed without proofs', () => {
  const receipt = path.join(os.tmpdir(), `wp10b-vd-${process.pid}-${Date.now()}.json`);
  const init = runRunner(['receipt-init', '--task', 'WP-10B', '--receipt', receipt]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const bare = runRunner(['verify-done', '--task', 'WP-10B', '--receipt', receipt]);
  assert.notEqual(bare.status, 0);
  const combined = `${bare.stdout || ''}${bare.stderr || ''}`;
  assert.match(
    combined,
    /WP10B_VERIFY_DONE_PROOF_MISSING|WP10B_E4_|WP10B_CATALOG|WP10B_REQUIRED|PROOF_MISSING|missing proofs/i,
  );
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.notEqual(data.EffectiveDone, true);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }
});

test('WP-10B VERIFY-DONE: shell / black-screen e4 reasons named', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /WP10B_E4_/);
  const ver = fs.readFileSync(
    path.join(repoRoot, 'android-car', 'scripts', 'verify-wallpaper-plugin.js'),
    'utf8',
  );
  assert.match(ver, /blackScreen|verifyE4Evidence/);
});
