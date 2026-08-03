'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');

function runRunner(argv) {
  return spawnSync('python3', [runnerPath, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('WP-10C VERIFY-DONE: evaluate path exists', () => {
  const src = fs.readFileSync(runnerPath, 'utf8');
  assert.match(src, /def evaluate_wp10c_verify_done/);
  assert.match(src, /task_id == "WP-10C"/);
});

test('WP-10C VERIFY-DONE: catalog weight 6 E5', () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const m = (catalog.tasks || []).filter((t) => t && t.taskId === 'WP-10C');
  assert.equal(m.length, 1);
  assert.equal(m[0].weight, 6);
  assert.equal(m[0].evidenceLevel, 'E5');
});

test('WP-10C VERIFY-DONE: bare verify-done fails closed', () => {
  const receipt = path.join(os.tmpdir(), `wp10c-vd-${process.pid}-${Date.now()}.json`);
  assert.equal(runRunner(['receipt-init', '--task', 'WP-10C', '--receipt', receipt]).status, 0);
  const bare = runRunner(['verify-done', '--task', 'WP-10C', '--receipt', receipt]);
  assert.notEqual(bare.status, 0);
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.notEqual(data.EffectiveDone, true);
  try {
    fs.unlinkSync(receipt);
  } catch {
    /* ignore */
  }
});
