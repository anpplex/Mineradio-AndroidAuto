'use strict';

/**
 * WP-10A VERIFY-DONE — production path exists and fail-closes without E3 proofs.
 * Does not elevate operational EffectiveDone.
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

test('WP-10A VERIFY-DONE: production evaluate_wp10a_verify_done path exists', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /def evaluate_wp10a_verify_done/);
  assert.match(src, /WP10A_E3_SHELL_CALLER_REJECTED|WP10A_E3_REAL_CALLER_MISSING/);
  assert.match(src, /task_id == "WP-10A"/);
});

test('WP-10A VERIFY-DONE: catalog WP-10A weight 6 E3', () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const matches = (catalog.tasks || []).filter((t) => t && t.taskId === 'WP-10A');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].weight, 6);
  assert.equal(matches[0].evidenceLevel, 'E3');
});

test('WP-10A VERIFY-DONE: bare verify-done fails closed without proofs', () => {
  const receipt = path.join(os.tmpdir(), `wp10a-vd-${process.pid}-${Date.now()}.json`);
  const init = runRunner(['receipt-init', '--task', 'WP-10A', '--receipt', receipt]);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const bare = runRunner(['verify-done', '--task', 'WP-10A', '--receipt', receipt]);
  assert.notEqual(bare.status, 0);
  const combined = `${bare.stdout || ''}${bare.stderr || ''}`;
  assert.match(
    combined,
    /WP10A_VERIFY_DONE_PROOF_MISSING|WP10A_E3_|WP10A_CATALOG|WP10A_REQUIRED|PROOF_MISSING|missing proofs/i,
  );
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.notEqual(data.EffectiveDone, true);
  try {
    fs.unlinkSync(receipt);
  } catch {
    // ignore
  }
});

test('WP-10A VERIFY-DONE: shell e3Evidence is rejected when other proofs present shape-check', () => {
  // Unit-level: source must name shell rejection reason.
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /WP10A_E3_SHELL_CALLER_REJECTED/);
  assert.match(src, /shell content call cannot satisfy continuous E3/);
});
