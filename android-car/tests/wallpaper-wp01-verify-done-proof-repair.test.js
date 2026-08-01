'use strict';

/**
 * WP-01 / VERIFY-DONE-PROOF-REPAIR — RED/GREEN contract tests.
 *
 * Pins that production verify-done must use a dynamic import+repair proof chain:
 * - no hard-coded PR #5 / merge tip equality
 * - each proof merge SHA is an ancestor of live base (not tip equality)
 * - live base tip from independent origin ls-remote
 * - PR/head/base/merge state from independent GitHub API readback
 * - caller cannot forge remote facts
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..', '..');
const runner = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.py');
const catalogPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-plugin-tasks.json');
const schemaPath = path.join(repoRoot, 'android-car', 'scripts', 'wallpaper-task.schema.json');

const IMPORT_HEAD = '363cc82849d57b6f9f43706840a0c286afbef144';
const REPAIR_HEAD = 'd81ca0e4070f95c2961e87e7f3e1663897ce3327';
const IMPORT_MERGE = '37bfcae9c812b691b68fa8a91ebd0c08b2ec6e30';
const FAKE_SHA = 'a'.repeat(40);
const FAKE_HEX64 = 'b'.repeat(64);

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

function parseJsonLoose(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function tempReceipt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp01-proof-repair-'));
  return path.join(dir, 'wp-01.json');
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function liveBaseFromLsRemote() {
  const r = git(['ls-remote', '--refs', 'origin', 'refs/heads/huawei-android12-car']);
  assert.equal(r.status, 0, `ls-remote failed: ${r.stderr}`);
  const sha = (r.stdout.split(/\s+/)[0] || '').toLowerCase();
  assert.match(sha, /^[0-9a-f]{40}$/);
  return sha;
}

function suiteProofs() {
  return {
    pluginContractTest: { pass: true, sha256: FAKE_HEX64 },
    monorepoImportTest: { pass: true, sha256: FAKE_HEX64 },
    fullNodeTest: { pass: true, sha256: FAKE_HEX64 },
    catalogSha256: sha256File(catalogPath),
    schemaSha256: sha256File(schemaPath),
  };
}

function identityProofChain(importPr, repairPr) {
  return {
    proofChain: {
      import: { prNumber: importPr },
      repair: { prNumber: repairPr },
    },
    ...suiteProofs(),
  };
}

// ---------------------------------------------------------------------------
// Source / catalog freeze (no PR#5 hard pin, no tip-equality requirement)
// ---------------------------------------------------------------------------

test('PROOF-REPAIR RED-0.1 production source must not hardcode prNumber==5 or merge==tip', () => {
  const src = fs.readFileSync(runner, 'utf8');
  assert.doesNotMatch(
    src,
    /prNumber must be 5|pr_number\s*!=\s*5|pr_number\s*==\s*5/,
    'must not hardcode prNumber == 5',
  );
  assert.doesNotMatch(
    src,
    /merge must equal live base tip|merge_sha\s*!=\s*live_base|mergeSha.*!= live base tip/,
    'must not require mergeSha == live base tip',
  );
  assert.match(
    src,
    /merge-base|--is-ancestor|git_is_ancestor/,
    'must use ancestry checks for proof merge SHAs',
  );
  assert.match(src, /proof.?chain|proof_chain|proofChain|importProof|repairProof/i);
});

test('PROOF-REPAIR RED-0.2 catalog must not pin prNumber 5 or fixed mergeSha', () => {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const wp01 = (catalog.tasks || []).find((t) => t.taskId === 'WP-01');
  assert.ok(wp01, 'WP-01 must exist');
  const proofs = wp01.proofs || {};
  assert.equal(
    proofs.prNumber,
    undefined,
    'catalog must not hardcode proofs.prNumber',
  );
  assert.equal(
    proofs.mergeSha,
    undefined,
    'catalog must not hardcode proofs.mergeSha',
  );
  const chain = proofs.proofChain;
  assert.ok(chain && typeof chain === 'object', 'catalog must register structured proofChain');
  assert.ok(chain.import, 'proofChain.import required');
  assert.ok(chain.repair, 'proofChain.repair required');
  assert.equal(chain.import.prNumber, undefined, 'import proof must not pin prNumber');
  assert.equal(chain.repair.prNumber, undefined, 'repair proof must not pin prNumber');
  assert.equal(chain.import.mergeSha, undefined, 'import proof must not pin mergeSha');
  assert.equal(chain.repair.mergeSha, undefined, 'repair proof must not pin mergeSha');
  assert.match(String(chain.import.taskCommit || ''), /^[0-9a-f]{40}$/);
  assert.match(String(chain.repair.taskCommit || ''), /^[0-9a-f]{40}$/);
  assert.equal(chain.import.taskCommit, IMPORT_HEAD);
  assert.equal(chain.repair.taskCommit, REPAIR_HEAD);
  assert.equal(chain.import.baseRef, 'huawei-android12-car');
  assert.equal(chain.repair.baseRef, 'huawei-android12-car');
});

// ---------------------------------------------------------------------------
// Old pin model fails under PR #6 + live base
// ---------------------------------------------------------------------------

test('PROOF-REPAIR RED-1 old single-PR#5 + catalog merge pin fails under live base after PR#6', () => {
  const liveBase = liveBaseFromLsRemote();
  // After PR#6, live tip is repair merge, not import merge.
  assert.notEqual(
    liveBase,
    IMPORT_MERGE,
    'precondition: live base tip advanced past import merge',
  );

  const receipt = tempReceipt();
  const init = runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]);
  assert.equal(init.status, 0, init.combined);

  // Legacy caller proof shape that worked only when PR#5 merge == tip.
  const legacyProofs = {
    importCommit: IMPORT_HEAD,
    prNumber: 5,
    mergeSha: IMPORT_MERGE,
    authoritativeBaseSha: liveBase,
    ...suiteProofs(),
  };
  const result = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
    '--proofs-json',
    JSON.stringify(legacyProofs),
  ]);
  assert.notEqual(result.status, 0, 'legacy pin model must fail under PR#6 tip');
  assert.match(
    result.combined,
    /WP01_VERIFY_DONE_CATALOG_MERGE_PIN|WP01_VERIFY_DONE_PROOF_MISSING|proof.?chain|PROOF_CHAIN/i,
    `expected catalog-merge-pin / proof-chain failure, got:\n${result.combined}`,
  );
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(data.EffectiveDone, false);
});

// ---------------------------------------------------------------------------
// Correct proof chain allows ancestry (not tip equality)
// ---------------------------------------------------------------------------

test('PROOF-REPAIR GREEN-2 proof chain accepts import+repair merges as live-base ancestors', () => {
  const liveBase = liveBaseFromLsRemote();
  const importAnc = git(['merge-base', '--is-ancestor', IMPORT_MERGE, liveBase]);
  assert.equal(importAnc.status, 0, 'import merge must be ancestor of live base');
  // repair merge equals current tip after #6, still an ancestor of itself
  const repairMergeProbe = git([
    'log',
    '-1',
    '--merges',
    '--grep=Merge pull request #6',
    '--format=%H',
    liveBase,
  ]);
  const repairMerge = (repairMergeProbe.stdout || liveBase).toLowerCase();
  assert.match(repairMerge, /^[0-9a-f]{40}$/);
  const repairAnc = git(['merge-base', '--is-ancestor', repairMerge, liveBase]);
  assert.equal(repairAnc.status, 0, 'repair merge must be ancestor of live base');

  // Tip equality is not required for import merge.
  assert.notEqual(IMPORT_MERGE, liveBase);

  const receipt = tempReceipt();
  assert.equal(
    runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]).status,
    0,
  );

  const proofs = identityProofChain(5, 6);
  const result = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
    '--proofs-json',
    JSON.stringify(proofs),
  ]);
  assert.equal(
    result.status,
    0,
    `proof chain verify-done must pass\n${result.combined}`,
  );
  const payload = parseJsonLoose(result.stdout) || parseJsonLoose(result.combined);
  assert.ok(payload && payload.ok === true, result.combined);
  assert.equal(payload.EffectiveDone, true);

  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(data.EffectiveDone, true);
  assert.equal(data.state, 'DONE');
  const vd = data.verifyDone || {};
  assert.equal(vd.authoritativeBaseSha, liveBase);
  assert.notEqual(vd.importProof?.mergeSha, undefined);
  assert.notEqual(vd.repairProof?.mergeSha, undefined);
  // Must not require either merge == tip (import never equals tip after #6)
  assert.notEqual(vd.importProof.mergeSha, liveBase);
  // Ancestry recorded
  assert.equal(vd.importProof.mergeIsAncestorOfLiveBase, true);
  assert.equal(vd.repairProof.mergeIsAncestorOfLiveBase, true);
});

// ---------------------------------------------------------------------------
// Reject forgeries / incomplete proofs
// ---------------------------------------------------------------------------

test('PROOF-REPAIR RED-3.1 reject unmerged / wrong-repo / wrong-head / wrong-base identity', () => {
  const receipt = tempReceipt();
  assert.equal(
    runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]).status,
    0,
  );

  // Nonexistent PR number → API readback failure / not merged
  const badPr = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
    '--proofs-json',
    JSON.stringify(identityProofChain(999999, 6)),
  ]);
  assert.notEqual(badPr.status, 0);
  assert.match(
    badPr.combined,
    /PR_READBACK|WP01_VERIFY_DONE|NOT_MERGED|PROOF|gh pr view|Could not resolve/i,
  );
});

test('PROOF-REPAIR RED-3.2 reject head SHA mismatch against catalog taskCommit', () => {
  // Swap roles: use repair PR for import role → head SHA won't match import taskCommit
  const receipt = tempReceipt();
  assert.equal(
    runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]).status,
    0,
  );
  const swapped = identityProofChain(6, 5);
  const result = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
    '--proofs-json',
    JSON.stringify(swapped),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.combined,
    /HEAD_SHA|head\.sha|headSha|taskCommit|WP01_VERIFY_DONE|PROOF/i,
  );
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).EffectiveDone, false);
});

test('PROOF-REPAIR RED-3.3 reject caller-forged remote facts (merged / EffectiveDone / REMOTE_VERIFIED)', () => {
  const receipt = tempReceipt();
  assert.equal(
    runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]).status,
    0,
  );

  for (const forged of [
    { merged: true },
    { EffectiveDone: true },
    { REMOTE_VERIFIED: true },
    { remoteVerified: true },
    { mergeSha: FAKE_SHA },
  ]) {
    const proofs = {
      ...identityProofChain(5, 6),
      ...forged,
    };
    const result = runRunner([
      'verify-done',
      '--task',
      'WP-01',
      '--receipt',
      receipt,
      '--proofs-json',
      JSON.stringify(proofs),
    ]);
    assert.notEqual(
      result.status,
      0,
      `must reject caller forgery keys ${JSON.stringify(forged)}\n${result.combined}`,
    );
    assert.match(
      result.combined,
      /CALLER_FORGERY|FORGED|WP01_VERIFY_DONE|PROOF|remote fact|untrusted/i,
      result.combined,
    );
    assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).EffectiveDone, false);
  }
});

test('PROOF-REPAIR RED-3.4 reject incomplete or duplicate proof chain roles', () => {
  const receipt = tempReceipt();
  assert.equal(
    runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]).status,
    0,
  );

  const missingRepair = {
    proofChain: { import: { prNumber: 5 } },
    ...suiteProofs(),
  };
  const r1 = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
    '--proofs-json',
    JSON.stringify(missingRepair),
  ]);
  assert.notEqual(r1.status, 0);
  assert.match(r1.combined, /PROOF|proofChain|repair|incomplete|missing/i);

  const dup = {
    proofChain: {
      import: { prNumber: 5 },
      repair: { prNumber: 5 },
    },
    ...suiteProofs(),
  };
  const r2 = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
    '--proofs-json',
    JSON.stringify(dup),
  ]);
  assert.notEqual(r2.status, 0);
  assert.match(r2.combined, /duplicate|PROOF|same PR|WP01_VERIFY_DONE/i);
});

test('PROOF-REPAIR RED-3.5 reject catalogSha256 / schemaSha256 mismatch', () => {
  const receipt = tempReceipt();
  assert.equal(
    runRunner(['receipt-init', '--task', 'WP-01', '--receipt', receipt]).status,
    0,
  );
  const proofs = {
    ...identityProofChain(5, 6),
    catalogSha256: FAKE_HEX64,
  };
  const result = runRunner([
    'verify-done',
    '--task',
    'WP-01',
    '--receipt',
    receipt,
    '--proofs-json',
    JSON.stringify(proofs),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.combined, /catalogSha256|CATALOG_SHA|PROOF/i);
});

test('PROOF-REPAIR RED-3.6 live base tip must come from independent ls-remote path', () => {
  const src = fs.readFileSync(runner, 'utf8');
  // live base for verify-done must use ls-remote, not only local rev-parse cache
  assert.match(
    src,
    /probe_base_ref_sha|ls-remote.*huawei-android12-car/,
  );
  const live = liveBaseFromLsRemote();
  assert.match(live, /^[0-9a-f]{40}$/);
});
