'use strict';

/**
 * WP-00 / RED-01 — baseline, worktree identity, and WP-INFRA EffectiveGate contracts.
 *
 * Calls (or requires) production surface `android-car/scripts/wp00-baseline-contract.js`
 * which is not yet implemented under GREEN-01. Failures must prove the contract
 * gap — not bad paths or missing fixtures.
 *
 * Does not implement WP-00 features, does not touch WallpaperEngine main,
 * does not claim EffectiveDone / progress weight.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  repoRoot,
  contractPath,
  runnerPath,
  catalogPath,
  schemaPath,
  finalInfraReceipt,
  wp00TxnFile,
  FORBIDDEN_BRANCHES,
  FORBIDDEN_PSEUDO_BASE_TIPS,
  WALLPAPER_ENGINE_MAIN,
  PLUGIN_SANDBOX_WT,
  git,
  runPython,
  readJson,
  requireBaselineContract,
  loadBaselineContract,
  getWp00TaskContext,
  getAuthoritativeBaseSha,
  getApprovedTaskBranch,
  getHeadSha,
} = require('./wallpaper-wp00-baseline-helpers');

function assertContractMissingOrFails(fn, label) {
  const surface = loadBaselineContract();
  if (!surface) {
    assert.fail(
      `${label}: WP-00 baseline contract not implemented at ${contractPath}`,
    );
  }
  return fn(surface);
}

// ---------------------------------------------------------------------------
// Framework / real environment sanity (may pass before GREEN)
// ---------------------------------------------------------------------------

test('WP-00 RED-01: environment paths and tools are real', () => {
  assert.equal(fs.existsSync(runnerPath), true, 'runner missing');
  assert.equal(fs.existsSync(catalogPath), true, 'catalog missing');
  assert.equal(fs.existsSync(schemaPath), true, 'schema missing');
  assert.equal(fs.existsSync(finalInfraReceipt), true, 'WP-INFRA final receipt missing');
  assert.equal(fs.existsSync(WALLPAPER_ENGINE_MAIN), true, 'WallpaperEngine main missing');
  assert.equal(fs.existsSync(path.join(WALLPAPER_ENGINE_MAIN, '.git')), true);
});

test('WP-00 RED-01: current Mineradio worktree is a valid task worktree', () => {
  const ctx = getWp00TaskContext(repoRoot);
  assert.equal(ctx.ok, true, JSON.stringify(ctx));
  const top = git(['rev-parse', '--show-toplevel']);
  assert.equal(top.status, 0, top.combined);
  assert.equal(path.resolve(top.stdout), path.resolve(repoRoot));
  const branch = git(['branch', '--show-current']);
  assert.equal(branch.stdout, ctx.taskBranch);
  assert.equal(branch.stdout, getApprovedTaskBranch());
  const head = git(['rev-parse', 'HEAD']);
  assert.equal(head.stdout, ctx.headSha);
  assert.equal(head.stdout, getHeadSha());
  assert.match(getAuthoritativeBaseSha(), /^[0-9a-f]{40}$/);
  const detached = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.notEqual(detached.stdout, 'HEAD', 'must not be detached HEAD');
});

test('WP-00 RED-01: WP-INFRA final receipt still EffectiveGate=true', () => {
  const d = readJson(finalInfraReceipt);
  assert.equal(d.EffectiveGate, true);
  assert.equal(d.EffectiveDone, true);
  assert.equal(d.state, 'DONE');
  assert.equal(typeof d.runnerSha256, 'string');
  assert.match(d.runnerSha256, /^[0-9a-f]{64}$/);
  assert.match(d.catalogSha256, /^[0-9a-f]{64}$/);
  assert.match(d.schemaSha256, /^[0-9a-f]{64}$/);
  assert.equal(d.catalogTestReceipt && d.catalogTestReceipt.pass, true);
  assert.equal(d.schemaTestReceipt && d.schemaTestReceipt.pass, true);
});

// ---------------------------------------------------------------------------
// Contract surface (RED: must fail until GREEN implements)
// ---------------------------------------------------------------------------

test('WP-00 RED-01.0 baseline contract production surface must exist', () => {
  assert.equal(
    fs.existsSync(contractPath),
    true,
    `GREEN-01 must add production surface: ${contractPath}`,
  );
});

test('WP-00 RED-01.1 contract must assert Mineradio task branch identity', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertMineradioWorktreeIdentity, 'function');
    const taskBranch = getApprovedTaskBranch();
    const head = getHeadSha();
    const r = c.assertMineradioWorktreeIdentity({
      cwd: repoRoot,
      expectedBranch: taskBranch,
      expectedHead: head,
      forbiddenBranches: FORBIDDEN_BRANCHES,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.branch, taskBranch);
    assert.equal(r.head, head);
    assert.equal(r.detached, false);
  }, 'RED-01.1');
});

test('WP-00 RED-01.2 contract must reject forbidden branches (main/master/base)', () => {
  assertContractMissingOrFails((c) => {
    const head = getHeadSha();
    for (const bad of FORBIDDEN_BRANCHES) {
      const r = c.assertMineradioWorktreeIdentity({
        cwd: repoRoot,
        expectedBranch: bad,
        expectedHead: head,
        forbiddenBranches: FORBIDDEN_BRANCHES,
      });
      assert.equal(r.ok, false, `must reject expectedBranch=${bad}`);
      assert.match(String(r.failureReason || r.message || ''), /BRANCH|FORBIDDEN|IDENTITY/i);
    }
  }, 'RED-01.2');
});

test('WP-00 RED-01.3 contract must reject HEAD != expectedHead assertion', () => {
  assertContractMissingOrFails((c) => {
    const r = c.assertMineradioWorktreeIdentity({
      cwd: repoRoot,
      expectedBranch: getApprovedTaskBranch(),
      expectedHead: '0000000000000000000000000000000000000000',
      forbiddenBranches: FORBIDDEN_BRANCHES,
    });
    assert.equal(r.ok, false);
    assert.match(String(r.failureReason || r.message || ''), /HEAD|BASE|MISMATCH|SHA/i);
  }, 'RED-01.3');
});

test('WP-00 RED-01.4 contract must prove WallpaperEngine main is read-only for WP-00', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertWallpaperEngineMainReadonly, 'function');
    const r = c.assertWallpaperEngineMainReadonly({
      mainPath: WALLPAPER_ENGINE_MAIN,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    // Contract must not have written into main.
    assert.equal(fs.existsSync(WALLPAPER_ENGINE_MAIN), true);
  }, 'RED-01.4');
});

test('WP-00 RED-01.5 contract must require independent Plugin sandbox worktree path', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertPluginSandboxIdentity, 'function');
    // RED: plugin sandbox is not established yet — must fail-closed, not forge DONE.
    const r = c.assertPluginSandboxIdentity({
      sandboxPath: PLUGIN_SANDBOX_WT,
      expectedBranch: 'codex/mineradio-plugin-sandbox',
      expectedHead: 'f16fee74c15c58307656548bc6082891790de5d0',
    });
    assert.equal(r.ok, false, 'plugin sandbox must not yet be ready in RED-01');
    assert.match(
      String(r.failureReason || r.message || ''),
      /NOT_FOUND|MISSING|WORKTREE|SANDBOX|NOT_ESTABLISHED/i,
    );
    assert.notEqual(r.EffectiveDone, true);
  }, 'RED-01.5');
});

test('WP-00 RED-01.6 contract must bind unique WP-00 transaction file', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertWp00TransactionIdentity, 'function');
    const r = c.assertWp00TransactionIdentity({
      transactionFile: wp00TxnFile,
      taskId: 'WP-00',
    });
    // RED: transaction not initialized yet → fail-closed.
    assert.equal(r.ok, false);
    assert.match(String(r.failureReason || r.message || ''), /MISSING|TRANSACTION|NOT_FOUND|INIT/i);
  }, 'RED-01.6');
});

test('WP-00 RED-01.7 contract must read WP-INFRA final receipt and require EffectiveGate=true', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertWpInfraGateFromFinalReceipt, 'function');
    const r = c.assertWpInfraGateFromFinalReceipt({
      receiptPath: finalInfraReceipt,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.EffectiveGate, true);
    assert.equal(r.EffectiveDone, true);
    assert.match(r.runnerSha256, /^[0-9a-f]{64}$/);
    assert.match(r.catalogSha256, /^[0-9a-f]{64}$/);
    assert.match(r.schemaSha256, /^[0-9a-f]{64}$/);
  }, 'RED-01.7');
});

test('WP-00 RED-01.8 contract must reject missing or false WP-INFRA EffectiveGate', () => {
  assertContractMissingOrFails((c) => {
    const r = c.assertWpInfraGateFromFinalReceipt({
      receiptPath: path.join(repoRoot, 'android-car', 'no-such-receipt.json'),
    });
    assert.equal(r.ok, false);
    assert.match(String(r.failureReason || r.message || ''), /MISSING|RECEIPT|GATE|NOT_FOUND/i);
  }, 'RED-01.8');
});

test('WP-00 RED-01.9 contract must not accept unmerged infra branch tip as authoritative base', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertAuthoritativeBase, 'function');
    const liveBase = getAuthoritativeBaseSha();
    const r = c.assertAuthoritativeBase({
      cwd: repoRoot,
      expectedBaseSha: liveBase,
      forbiddenHeads: [...FORBIDDEN_PSEUDO_BASE_TIPS],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.baseSha, liveBase);
    assert.notEqual(r.baseSha, '57cbe4ac1481a6bd79f6c3eca4f6ae91d37bcd08');
    const forged = c.assertAuthoritativeBase({
      cwd: repoRoot,
      expectedBaseSha: '57cbe4ac1481a6bd79f6c3eca4f6ae91d37bcd08',
      forbiddenHeads: [...FORBIDDEN_PSEUDO_BASE_TIPS],
    });
    assert.equal(forged.ok, false, 'must reject infra tip as claimed base');
  }, 'RED-01.9');
});

test('WP-00 RED-01.10 contract must refuse forged WP-00 EffectiveDone / progress weight', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertWp00NotDone, 'function');
    const r = c.assertWp00NotDone({
      transactionFile: wp00TxnFile,
      claimedEffectiveDone: true,
      claimedCoreProgress: 4,
    });
    assert.equal(r.ok, false);
    assert.equal(r.EffectiveDone, false);
    assert.equal(r.coreProgress, 0);
    assert.match(String(r.failureReason || r.message || ''), /DONE|PROGRESS|FORGED|NOT_READY|RED/i);
  }, 'RED-01.10');
});

test('WP-00 RED-01.11 production assert-ready for WP-00 still needs explicit gate token', () => {
  // Runner already exists: WP-00 cannot start with gate false.
  const blocked = runPython([
    'assert-ready',
    '--task',
    'WP-00',
    '--infra-effective-gate',
    'false',
  ]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.combined, /EFFECTIVE_GATE_FALSE/);

  // from-receipt requires contract/GREEN path to wire final receipt — RED expects
  // baseline contract to orchestrate this, not ad-hoc caller true.
  const forged = runPython([
    'assert-ready',
    '--task',
    'WP-00',
    '--infra-effective-gate',
    'true',
  ]);
  // GREEN-01 contract must still gate WP-00 start; bare true without receipt binding
  // is insufficient for WP-00 baseline closure (may currently exit 0 — contract fails).
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.assertWp00ReadyToStart, 'function');
    const r = c.assertWp00ReadyToStart({
      finalInfraReceipt,
      cwd: repoRoot,
      expectedBranch: getApprovedTaskBranch(),
      expectedHead: getHeadSha(),
      runnerAssertReadyResult: {
        status: forged.status,
        combined: forged.combined,
      },
    });
    // RED: baseline readiness contract not satisfied (plugin sandbox / txn missing).
    assert.equal(r.ok, false);
    assert.equal(r.EffectiveDone, false);
  }, 'RED-01.11');
});

test('WP-00 RED-01.12 RED stage must not increase core progress', () => {
  assertContractMissingOrFails((c) => {
    assert.equal(typeof c.computeCoreProgress, 'function');
    const r = c.computeCoreProgress({
      wpInfraDone: true,
      wp00EffectiveDone: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.coreProgress, 0);
    assert.equal(r.highestEvidence, 'E0');
  }, 'RED-01.12');
});
