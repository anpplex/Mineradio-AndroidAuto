'use strict';

/**
 * WP-03 / RED-01 — .mpkg staging / sourceConsumed / EngineAdapter contracts.
 *
 * RED only: catalog entry + production surfaces missing. Failures prove capacity
 * gaps — not path/worktree self-injury. Does not implement production code.
 * Does not claim WP-03 EffectiveDone or raise Core progress above 18%.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  repoRoot,
  runnerPath,
  catalogPath,
  schemaPath,
  stagingContractPath,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  transactionsRoot,
  TASK_ID,
  WP03_PRODUCTION_SOURCES,
  WP03_UNIT_TEST_SOURCES,
  WP03_SPEC_ACCEPTANCE,
  FailureReason,
  git,
  runRunner,
  runPython,
  readJson,
  pathExists,
  liveAuthoritativeBaseSha,
  classifyHeadVsLiveBase,
  isAllowedTaskBranch,
  readTaskWorktreeIdentity,
  isGitAncestor,
  loadWp03CatalogEntry,
  parseWp03CatalogIdentity,
  readPrerequisiteDone,
  assertWp03ProductionSurfacesPresent,
  assertWp03UnitTestsPresent,
  assertWp03FilePathsPresent,
  assertWp03RequiredInputs,
  listMissingProductionSources,
  listMissingUnitTests,
  loadStagingContract,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceipts,
  defaultDoneReceiptsWithForgedWp03,
  liveWp03OperationalProgress,
  initTempWp03Receipt,
  parseRunnerJson,
  productionSourcePath,
  unitTestSourcePath,
  filePathsXml,
  catalogToolPath,
} = require('./wallpaper-wp03-red-helpers');

// ---------------------------------------------------------------------------
// Environment / prerequisites (may pass in RED)
// ---------------------------------------------------------------------------

test('WP-03 RED-01: environment paths and tools are real', () => {
  assert.equal(pathExists(runnerPath), true, 'runner missing');
  assert.equal(pathExists(catalogPath), true, 'catalog missing');
  assert.equal(pathExists(schemaPath), true, 'schema missing');
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
  assert.equal(pathExists(path.join(repoRoot, 'wallpaper-plugin')), true);
});

test('WP-03 RED-01: worktree branch and live base identity', () => {
  // Live base from origin ls-remote; HEAD may equal live or be a descendant (task ahead).
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  // Task branches: implementation / verify-done / close-verify, etc.
  assert.match(
    identity.branch,
    /^codex\/wallpaper-plugin-/,
    `unexpected task branch: ${identity.branch}`,
  );
  assert.match(identity.head, /^[0-9a-f]{40}$/);
  assert.match(identity.liveBaseSha, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(
    identity.relation === 'equal' || identity.relation === 'ahead',
    `unexpected relation: ${identity.relation}`,
  );
  if (identity.relation === 'ahead') {
    assert.equal(identity.liveIsAncestorOfHead, true);
    assert.equal(isGitAncestor(identity.liveBaseSha, identity.head), true);
  } else {
    assert.equal(identity.head, identity.liveBaseSha);
  }
});

test('WP-03 RED-01: head/live relation fixtures (equal/ahead pass; behind/diverged fail)', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.equal(classifyHeadVsLiveBase(a, a, {}).ok, true);
  assert.equal(classifyHeadVsLiveBase(a, a, {}).relation, 'equal');
  assert.equal(
    classifyHeadVsLiveBase(b, a, { liveIsAncestorOfHead: true }).ok,
    true,
  );
  assert.equal(
    classifyHeadVsLiveBase(b, a, { liveIsAncestorOfHead: true }).relation,
    'ahead',
  );
  const behind = classifyHeadVsLiveBase(a, b, { headIsAncestorOfLive: true });
  assert.equal(behind.ok, false);
  assert.equal(behind.failureReason, 'HEAD_BEHIND_LIVE_BASE');
  const diverged = classifyHeadVsLiveBase(a, b, {});
  assert.equal(diverged.ok, false);
  assert.equal(diverged.failureReason, 'HEAD_DIVERGED_FROM_LIVE_BASE');
});

test('WP-03 RED-01: task branch allowlist and caller identity forgery fail-closed', () => {
  assert.equal(isAllowedTaskBranch('codex/wallpaper-plugin-wp03').ok, true);
  assert.equal(isAllowedTaskBranch('main').ok, false);
  assert.equal(isAllowedTaskBranch('master').ok, false);
  assert.equal(isAllowedTaskBranch('huawei-android12-car').ok, false);
  assert.equal(isAllowedTaskBranch('feature/other').ok, false);
  const forged = readTaskWorktreeIdentity({
    claimedLiveBase: '0'.repeat(40),
    REMOTE_VERIFIED: true,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.failureReason, 'CALLER_FORGED_IDENTITY');
});

test('WP-03 RED-01: prerequisites WP-INFRA / WP-00 / WP-01 / WP-02 EffectiveDone', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveGate, true);
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].state, 'DONE');
});

test('WP-03 RED-01: WP-02 DONE is required catalog-level prerequisite for WP-03', () => {
  const identity = parseWp03CatalogIdentity();
  if (!identity.ok) {
    assert.equal(
      identity.failureReason,
      FailureReason.WP03_CATALOG_ENTRY_MISSING,
      JSON.stringify(identity),
    );
    assert.fail(
      `${FailureReason.WP03_CATALOG_ENTRY_MISSING}: cannot bind WP-02 prerequisite ` +
        `from authoritative catalog (WP-03 entry absent)`,
    );
  }
  assert.ok(identity.requiredEffectiveDone.includes('WP-02'));
  assert.ok(identity.dependsOn.includes('WP-02'));
  for (const dep of ['WP-INFRA', 'WP-00', 'WP-01', 'WP-02']) {
    assert.ok(
      identity.dependsOn.includes(dep) || identity.requiredEffectiveDone.includes(dep),
      `WP-03 must declare prerequisite ${dep}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Catalog identity (RED: fails until GREEN registers WP-03)
// ---------------------------------------------------------------------------

test('WP-03 RED-01.1 catalog must contain unique WP-03 task identity', () => {
  const loaded = loadWp03CatalogEntry();
  assert.equal(
    loaded.ok,
    true,
    `${FailureReason.WP03_CATALOG_ENTRY_MISSING}: ${loaded.message}`,
  );
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-03 RED-01.2 catalog WP-03 fields must be dynamically parseable', () => {
  const identity = parseWp03CatalogIdentity();
  assert.equal(
    identity.ok,
    true,
    `${identity.failureReason || 'FAIL'}: ${identity.message || ''}`,
  );
  assert.equal(identity.taskId, TASK_ID);
  assert.equal(typeof identity.weight, 'number');
  assert.ok(identity.weight > 0);
  assert.equal(typeof identity.scopeCheck, 'object');
  assert.ok(Array.isArray(identity.dependsOn));
  assert.ok(Array.isArray(identity.requiredEffectiveDone));
  assert.match(String(identity.evidenceLevel), /^E[0-7]$/);
  assert.notEqual(identity.expectedExit.RED, 0);
});

test('WP-03 RED-01.3 catalog validate remains well-formed with unique WP-03', () => {
  const result = runPython(catalogToolPath, [
    'validate',
    '--require-canonical-catalog',
    '--require-canonical-schema',
  ]);
  assert.equal(result.status, 0, result.combined);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, true);
  // Spec/progress pin weight 8% / E1 for GREEN catalog registration (not guessed).
  assert.equal(WP03_SPEC_ACCEPTANCE.weightPercentFromProgressTable, 8);
  assert.equal(WP03_SPEC_ACCEPTANCE.evidenceLevelFromProgressTable, 'E1');
  const loaded = loadWp03CatalogEntry();
  assert.equal(loaded.ok, true, loaded.message || '');
  assert.equal(loaded.task.taskId, TASK_ID);
  assert.equal(loaded.task.weight, 8);
  assert.equal(loaded.task.evidenceLevel, 'E1');
  assert.equal(
    (loaded.catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Transaction / receipt fail-closed
// ---------------------------------------------------------------------------

test('WP-03 RED-01.4 transaction receipt structure is valid (pre-close fail-closed or post-close DONE)', () => {
  assert.equal(pathExists(wp03TxnReceipt), true, 'wp-03 transaction receipt missing');
  const receipt = readJson(wp03TxnReceipt);
  assert.equal(receipt.taskId, TASK_ID);
  assert.equal(receipt.schema, 'wallpaper-task-receipt/v1');
  const mode = fs.statSync(wp03TxnReceipt).mode & 0o777;
  assert.equal(mode, 0o600, `receipt mode must be 0600, got ${mode.toString(8)}`);

  const live = liveWp03OperationalProgress();
  if (live.EffectiveDone) {
    // Post operational CLOSE-VERIFY: DONE only via verify-done, never caller CAS.
    assert.equal(receipt.EffectiveDone, true);
    assert.equal(receipt.state, 'DONE');
    assert.ok(receipt.verifyDone && typeof receipt.verifyDone === 'object');
  } else {
    assert.equal(receipt.EffectiveDone, false);
    assert.notEqual(receipt.state, 'DONE');
    assert.ok(
      [
        'INIT',
        'RED_RECORDED',
        'GREEN_RECORDED',
        'REFACTOR_RECORDED',
        'VERIFY_READY',
      ].includes(receipt.state),
      `unexpected WP-03 state: ${receipt.state}`,
    );
  }
});

test('WP-03 RED-01.5 runner reconcile/init/assert-state for WP-03', () => {
  const before = liveWp03OperationalProgress();
  const reconcile = runRunner([
    'reconcile',
    '--task',
    TASK_ID,
    '--transactions',
    transactionsRoot,
  ]);
  assert.equal(reconcile.status, 0, reconcile.combined);
  const init = runRunner(['init', '--task', TASK_ID, '--transactions', transactionsRoot]);
  assert.equal(init.status, 0, init.combined);
  const state = runRunner([
    'assert-state',
    '--task',
    TASK_ID,
    '--transactions',
    transactionsRoot,
  ]);
  assert.equal(state.status, 0, state.combined);
  // Runner must not silently flip EffectiveDone; live operational truth is preserved.
  const after = readJson(wp03TxnReceipt);
  assert.equal(after.EffectiveDone, before.EffectiveDone);
  assert.equal(after.state === 'DONE', before.EffectiveDone === true);
});

// ---------------------------------------------------------------------------
// Inputs present (WP-02) / outputs absent (WP-03)
// ---------------------------------------------------------------------------

test('WP-03 RED-01.6 required inputs from WP-02 runtime already exist', () => {
  const inputs = assertWp03RequiredInputs();
  assert.equal(inputs.ok, true, JSON.stringify(inputs));
});

test('WP-03 RED-01.7 production staging/adapter sources must exist (capacity gap)', () => {
  const r = assertWp03ProductionSurfacesPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP03_PRODUCTION_SURFACE_MISSING}: ${r.message}`,
  );
  for (const name of WP03_PRODUCTION_SOURCES) {
    assert.equal(
      pathExists(productionSourcePath(name)),
      true,
      `${FailureReason.WP03_PRODUCTION_SURFACE_MISSING}: ${name}`,
    );
  }
});

test('WP-03 RED-01.8 Android unit tests for stager/adapter must exist', () => {
  const r = assertWp03UnitTestsPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP03_UNIT_TEST_MISSING}: ${r.message}`,
  );
  for (const name of WP03_UNIT_TEST_SOURCES) {
    assert.equal(
      pathExists(unitTestSourcePath(name)),
      true,
      `${FailureReason.WP03_UNIT_TEST_MISSING}: ${name}`,
    );
  }
});

test('WP-03 RED-01.9 FileProvider file_paths.xml must exist for engineUri', () => {
  const r = assertWp03FilePathsPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP03_FILE_PATHS_MISSING}: ${r.message}`,
  );
  assert.equal(pathExists(filePathsXml()), true);
});

test('WP-03 RED-01.10 Node staging contract production surface must exist', () => {
  assert.equal(
    pathExists(stagingContractPath),
    true,
    `${FailureReason.WP03_CONTRACT_SURFACE_MISSING}: GREEN must add ${stagingContractPath}`,
  );
  const surface = loadStagingContract();
  assert.ok(surface, FailureReason.WP03_CONTRACT_SURFACE_MISSING);
  assert.equal(typeof surface.assertWp03StagingReady, 'function');
  assert.equal(typeof surface.assertMpkgQuotaPolicy, 'function');
  assert.equal(typeof surface.assertSourceConsumedRevoke, 'function');
  assert.equal(typeof surface.assertEngineAdapterIntent, 'function');
  assert.equal(typeof surface.assertWp03NotDone, 'function');
});

test('WP-03 RED-01.11 production capacity present; gap helpers stay fail-closed when empty', () => {
  // GREEN fills capacity; helpers report ok with EffectiveDone still false.
  assert.equal(listMissingProductionSources().length, 0);
  assert.equal(listMissingUnitTests().length, 0);
  const filePaths = assertWp03FilePathsPresent();
  const catalog = loadWp03CatalogEntry();
  const prod = assertWp03ProductionSurfacesPresent();
  const tests = assertWp03UnitTestsPresent();
  assert.equal(prod.ok, true, prod.message || '');
  assert.equal(prod.EffectiveDone, false);
  assert.equal(tests.ok, true, tests.message || '');
  assert.equal(tests.EffectiveDone, false);
  assert.equal(filePaths.ok, true, filePaths.message || '');
  assert.equal(catalog.ok, true, catalog.message || '');
  assert.equal(pathExists(stagingContractPath), true);
  // Stable failure signatures remain defined for future regressions.
  assert.equal(
    FailureReason.WP03_PRODUCTION_SURFACE_MISSING,
    'WP03_PRODUCTION_SURFACE_MISSING',
  );
  assert.equal(FailureReason.WP03_CATALOG_ENTRY_MISSING, 'WP03_CATALOG_ENTRY_MISSING');
  assert.equal(FailureReason.WP03_CONTRACT_SURFACE_MISSING, 'WP03_CONTRACT_SURFACE_MISSING');
});

// ---------------------------------------------------------------------------
// Anti-forgery / fail-closed
// ---------------------------------------------------------------------------

test('WP-03 RED-01.12 caller cannot forge EffectiveDone=true', () => {
  // Anti-forgery uses a fresh INIT receipt so operational post-close DONE is not confused with forge.
  const { receipt: tempReceipt, init } = initTempWp03Receipt();
  assert.equal(init.status, 0, init.combined);
  assert.equal(readJson(tempReceipt).EffectiveDone, false);

  const attempts = attemptCallerForgeEffectiveDone(tempReceipt);
  assert.notEqual(attempts.cas.status, 0, attempts.cas.combined);
  assert.match(
    attempts.cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone|ILLEGAL/i,
  );
  assert.notEqual(attempts.declare.status, 0);
  assert.match(attempts.declare.combined, /CALLER_DECLARED_DONE/);
  assert.notEqual(attempts.casState.status, 0);
  assert.match(attempts.casState.combined, /CALLER_DECLARED_DONE/);
  assert.notEqual(attempts.verify.status, 0);
  assert.match(
    attempts.verify.combined,
    /VERIFY_DONE|UNAVAILABLE|WP-03|WP03|PROOF|unknown task/i,
  );

  assert.equal(readJson(tempReceipt).EffectiveDone, false);
  assert.notEqual(readJson(tempReceipt).state, 'DONE');

  const live = liveWp03OperationalProgress();
  if (live.EffectiveDone) {
    assert.ok(live.receipt.verifyDone, 'operational DONE requires verifyDone proof');
  } else {
    assert.equal(live.receipt.EffectiveDone, false);
  }
});

test('WP-03 RED-01.13 caller cannot forge Core progress via WP-03 receipt', () => {
  // WP-00+WP-01+WP-02 only always 18% — independent of WP-03 operational close.
  const honest = computeCoreProgress(defaultDoneReceipts());
  assert.equal(honest.status, 0, honest.combined);
  const honestBody = parseRunnerJson(honest);
  assert.equal(honestBody.coreProgressPercent, 18);

  const live = liveWp03OperationalProgress();
  // Mapping live WP-03 receipt only elevates weight when EffectiveDone is truly true.
  const withWp03 = computeCoreProgress(defaultDoneReceiptsWithForgedWp03());
  assert.equal(withWp03.status, 0, withWp03.combined);
  const withBody = parseRunnerJson(withWp03);
  assert.equal(withBody.coreProgressPercent, live.expectedCoreProgressPercent);

  const breakdown = withBody.breakdown || [];
  const wp03Row = breakdown.find((row) => row.taskId === TASK_ID);
  if (wp03Row) {
    assert.equal(wp03Row.EffectiveDone, live.EffectiveDone);
  }

  // Temp non-DONE receipt must never inflate progress when mapped.
  const { receipt: tempReceipt, init } = initTempWp03Receipt();
  assert.equal(init.status, 0, init.combined);
  const withTemp = computeCoreProgress({
    ...defaultDoneReceipts(),
    'WP-03': tempReceipt,
  });
  assert.equal(withTemp.status, 0, withTemp.combined);
  assert.equal(parseRunnerJson(withTemp).coreProgressPercent, 18);
});

test('WP-03 RED-01.14 cannot skip WP-INFRA EffectiveGate for WP-03', () => {
  const blocked = attemptSkipInfraGate();
  assert.notEqual(blocked.status, 0, blocked.combined);
  assert.match(blocked.combined, /EFFECTIVE_GATE_FALSE|EFFECTIVE_GATE/);
});

test('WP-03 RED-01.15 evidence level / receipt structure remain fail-closed', () => {
  const receipt = readJson(wp03TxnReceipt);
  assert.equal(receipt.taskId, TASK_ID);
  const live = liveWp03OperationalProgress();
  if (live.EffectiveDone) {
    assert.equal(receipt.EffectiveDone, true);
    assert.ok(receipt.verifyDone);
  } else {
    assert.equal(receipt.EffectiveDone, false);
    assert.ok(
      !receipt.phaseEvents.some((e) => e && e.phase === 'DONE' && e.status === 'PASS'),
    );
  }

  const identity = parseWp03CatalogIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(String(identity.evidenceLevel), /^E[0-7]$/);
  assert.equal(identity.evidenceLevel, 'E1');
  assert.equal(identity.weight, 8);
  assert.ok(identity.failureSignaturePolicy.RED);
  assert.equal(identity.failureSignaturePolicy.RED.required, true);
  assert.ok(identity.requiredEffectiveDone.includes('WP-02'));
});

test('WP-03 RED-01.16 Core progress tracks live WP-03 EffectiveDone (18% pre-close / 26% post-close)', () => {
  const live = liveWp03OperationalProgress();
  // Progress without WP-03 weight stays 18%.
  const without = computeCoreProgress(defaultDoneReceipts());
  assert.equal(without.status, 0, without.combined);
  assert.equal(parseRunnerJson(without).coreProgressPercent, 18);

  const withMap = computeCoreProgress(defaultDoneReceiptsWithForgedWp03());
  assert.equal(withMap.status, 0, withMap.combined);
  assert.equal(
    parseRunnerJson(withMap).coreProgressPercent,
    live.expectedCoreProgressPercent,
  );
  assert.equal(readJson(wp03TxnReceipt).EffectiveDone, live.EffectiveDone);
  assert.equal(readJson(wp02TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp01TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp00MergeReceipt).EffectiveDone, true);
});

test('WP-03 RED-01.17 GREEN surfaces never grant EffectiveDone; caller claims fail-closed', () => {
  const probes = [
    assertWp03ProductionSurfacesPresent(),
    assertWp03UnitTestsPresent(),
    assertWp03FilePathsPresent(),
    loadWp03CatalogEntry(),
  ];
  for (const p of probes) {
    assert.equal(p.ok, true, JSON.stringify(p));
    // Gap/catalog helpers never inject EffectiveDone=true (receipt truth is separate).
    assert.notEqual(p.EffectiveDone, true);
  }
  const surface = loadStagingContract();
  assert.ok(surface, FailureReason.WP03_CONTRACT_SURFACE_MISSING);
  const notDone = surface.assertWp03NotDone({
    claimedEffectiveDone: true,
    claimedCoreProgress: 26,
    callerClaims: { REMOTE_VERIFIED: true, merged: true },
  });
  assert.equal(notDone.ok, false);
  assert.equal(notDone.EffectiveDone, false);
  const ready = surface.assertWp03StagingReady({ cwd: repoRoot });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.EffectiveDone, false);
  const quota = surface.assertMpkgQuotaPolicy({ cwd: repoRoot });
  assert.equal(quota.ok, true, JSON.stringify(quota));
  const consumed = surface.assertSourceConsumedRevoke({ cwd: repoRoot });
  assert.equal(consumed.ok, true, JSON.stringify(consumed));
  const engine = surface.assertEngineAdapterIntent({ cwd: repoRoot });
  assert.equal(engine.ok, true, JSON.stringify(engine));
});
