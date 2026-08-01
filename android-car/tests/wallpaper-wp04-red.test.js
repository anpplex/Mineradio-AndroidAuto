'use strict';

/**
 * WP-04 / RED-01 — Mineradio Smali bridge / action-token registry /
 * trusted local WebView contracts.
 *
 * RED only: catalog entry + production surfaces missing. Failures prove
 * capacity gaps — not path/worktree self-injury. Does not implement production
 * code. Does not claim WP-04 EffectiveDone or raise Core progress above 26%.
 *
 * Spec anchors (read-only):
 *   PROGRESS: weight 10% E1; token TTL/one-shot/concurrency RED fixtures
 *   DEVELOPMENT Task 4: contract.js / patcher / Smali bridge / bridge test /
 *                       build-car-apk.sh wire
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
  catalogToolPath,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  wp03TxnReceipt,
  wp04TxnReceipt,
  transactionsRoot,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP04_PRODUCTION_REL_PATHS,
  WP04_UNIT_TEST_REL_PATHS,
  WP04_SPEC_ACCEPTANCE,
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
  loadWp04CatalogEntry,
  parseWp04CatalogIdentity,
  readPrerequisiteDone,
  liveWp04OperationalProgress,
  assertWp04ProductionSurfacesPresent,
  assertWp04UnitTestsPresent,
  assertWp04ContractPresent,
  assertWp04PatcherPresent,
  assertWp04SmaliBridgePresent,
  assertWp04BuildWirePresent,
  assertWp04RequiredInputs,
  listMissingProductionSources,
  listMissingUnitTests,
  loadPluginContract,
  assertActionTokenRegistryFixtures,
  assertTrustedBridgePolicyFixtures,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp03,
  defaultDoneReceiptsWithWp04,
  parseRunnerJson,
  initTempWp04Receipt,
  ensureOperationalWp04Receipt,
  absFromRepo,
  contractPath,
  patcherPath,
  smaliBridgePath,
  bridgeUnitTestPath,
  buildCarApkPath,
} = require('./wallpaper-wp04-red-helpers');

// ---------------------------------------------------------------------------
// Environment / prerequisites (must PASS in RED — no self-injury)
// ---------------------------------------------------------------------------

test('WP-04 RED-01: environment paths and tools are real', () => {
  assert.equal(pathExists(runnerPath), true, 'runner missing');
  assert.equal(pathExists(catalogPath), true, 'catalog missing');
  assert.equal(pathExists(schemaPath), true, 'schema missing');
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
  assert.equal(pathExists(wp03TxnReceipt), true);
  assert.equal(pathExists(path.join(repoRoot, 'wallpaper-plugin')), true);
  assert.equal(pathExists(buildCarApkPath()), true, 'build-car-apk.sh must exist');
});

test('WP-04 RED-01: worktree branch and live base identity', () => {
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
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

test('WP-04 RED-01: head/live relation fixtures (equal/ahead pass; behind/diverged fail)', () => {
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

test('WP-04 RED-01: task branch allowlist and caller identity forgery fail-closed', () => {
  assert.equal(isAllowedTaskBranch('codex/wallpaper-plugin-wp04').ok, true);
  assert.equal(isAllowedTaskBranch('main').ok, false);
  assert.equal(isAllowedTaskBranch('master').ok, false);
  assert.equal(isAllowedTaskBranch('huawei-android12-car').ok, false);
  assert.equal(isAllowedTaskBranch('feature/other').ok, false);
  const forged = readTaskWorktreeIdentity({
    claimedLiveBase: '0'.repeat(40),
    REMOTE_VERIFIED: true,
    merged: true,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.failureReason, FailureReason.CALLER_FORGED_IDENTITY);
});

test('WP-04 RED-01: prerequisites WP-INFRA / WP-00 / WP-01 / WP-02 / WP-03 EffectiveDone', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveGate, true);
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].EffectiveDone, true);
  assert.equal(prereq['WP-02'].state, 'DONE');
  assert.equal(prereq['WP-03'].EffectiveDone, true);
  assert.equal(prereq['WP-03'].state, 'DONE');
});

test('WP-04 RED-01: WP-03 DONE is required catalog-level prerequisite for WP-04', () => {
  // Spec / progress order: WP-04 follows WP-03. Catalog may still lack WP-04 in RED.
  const identity = parseWp04CatalogIdentity();
  if (!identity.ok) {
    assert.equal(
      identity.failureReason,
      FailureReason.WP04_CATALOG_ENTRY_MISSING,
      JSON.stringify(identity),
    );
    // Spec-level requiredEffectiveDone still pins WP-03 from frozen progress table.
    assert.ok(WP04_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-03'));
    assert.ok(WP04_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-INFRA'));
    assert.ok(WP04_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-00'));
    assert.ok(WP04_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-01'));
    assert.ok(WP04_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-02'));
    assert.fail(
      `${FailureReason.WP04_CATALOG_ENTRY_MISSING}: cannot bind WP-03 prerequisite ` +
        `from authoritative catalog (WP-04 entry absent)`,
    );
  }
  assert.ok(identity.requiredEffectiveDone.includes('WP-03'));
  assert.ok(identity.dependsOn.includes('WP-03'));
  for (const dep of WP04_SPEC_ACCEPTANCE.requiredEffectiveDone) {
    assert.ok(
      identity.dependsOn.includes(dep) || identity.requiredEffectiveDone.includes(dep),
      `WP-04 must declare prerequisite ${dep}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Catalog identity (RED: fails until GREEN registers WP-04)
// ---------------------------------------------------------------------------

test('WP-04 RED-01.1 catalog must contain unique WP-04 task identity', () => {
  const loaded = loadWp04CatalogEntry();
  assert.equal(
    loaded.ok,
    true,
    `${FailureReason.WP04_CATALOG_ENTRY_MISSING}: ${loaded.message}`,
  );
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-04 RED-01.2 catalog WP-04 fields must be dynamically parseable', () => {
  const identity = parseWp04CatalogIdentity();
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

test('WP-04 RED-01.3 catalog validate + progress-table weight/E1 pin for GREEN registration', () => {
  const result = runPython(catalogToolPath, [
    'validate',
    '--require-canonical-catalog',
    '--require-canonical-schema',
  ]);
  assert.equal(result.status, 0, result.combined);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, true);
  // Spec/progress pin weight 10% / E1 for GREEN catalog registration (not guessed).
  assert.equal(
    WP04_SPEC_ACCEPTANCE.weightPercentFromProgressTable,
    EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  );
  assert.equal(WP04_SPEC_ACCEPTANCE.evidenceLevelFromProgressTable, 'E1');
  const loaded = loadWp04CatalogEntry();
  assert.equal(
    loaded.ok,
    true,
    `${FailureReason.WP04_CATALOG_ENTRY_MISSING}: ${loaded.message || ''}`,
  );
  assert.equal(loaded.task.taskId, TASK_ID);
  assert.equal(loaded.task.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  assert.equal(loaded.task.evidenceLevel, 'E1');
  assert.equal(
    (loaded.catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Transaction / receipt fail-closed
// ---------------------------------------------------------------------------

test('WP-04 RED-01.4 transaction receipt initializes fail-closed (not DONE)', () => {
  const ensured = ensureOperationalWp04Receipt();
  assert.equal(pathExists(wp04TxnReceipt), true, 'wp-04 transaction receipt missing');
  if (ensured.init) {
    assert.equal(ensured.init.status, 0, ensured.init.combined);
  }
  const receipt = readJson(wp04TxnReceipt);
  assert.equal(receipt.taskId, TASK_ID);
  assert.equal(receipt.schema, 'wallpaper-task-receipt/v1');
  const mode = fs.statSync(wp04TxnReceipt).mode & 0o777;
  assert.equal(mode, 0o600, `receipt mode must be 0600, got ${mode.toString(8)}`);

  const live = liveWp04OperationalProgress();
  if (live.EffectiveDone) {
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
      `unexpected WP-04 state: ${receipt.state}`,
    );
  }
});

test('WP-04 RED-01.5 runner reconcile/init/assert-state for WP-04', () => {
  ensureOperationalWp04Receipt();
  const before = liveWp04OperationalProgress();
  assert.equal(before.exists, true, FailureReason.WP04_RECEIPT_MISSING);
  const reconcile = runRunner([
    'reconcile',
    '--task',
    TASK_ID,
    '--transactions',
    transactionsRoot,
  ]);
  assert.equal(reconcile.status, 0, reconcile.combined);
  // cmd_init is a no-op fence; must not flip EffectiveDone or mutate receipt.
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
  const after = readJson(wp04TxnReceipt);
  assert.equal(after.EffectiveDone, before.EffectiveDone);
  assert.equal(after.state === 'DONE', before.EffectiveDone === true);
});

// ---------------------------------------------------------------------------
// Inputs present (WP-01/02/03) / outputs absent (WP-04)
// ---------------------------------------------------------------------------

test('WP-04 RED-01.6 required plugin protocol inputs already exist', () => {
  const inputs = assertWp04RequiredInputs();
  assert.equal(inputs.ok, true, JSON.stringify(inputs));
  // PluginContract authority/package constants exist post WP-01/WP-02.
  assert.equal(
    pathExists(
      path.join(
        repoRoot,
        'wallpaper-plugin',
        'app',
        'src',
        'main',
        'java',
        'com',
        'motif',
        'wallpaperengine',
        'plugin',
        'PluginContract.kt',
      ),
    ),
    true,
  );
});

test('WP-04 RED-01.7 production bridge surfaces must exist (capacity gap)', () => {
  const r = assertWp04ProductionSurfacesPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP04_PRODUCTION_SURFACE_MISSING}: ${r.message}`,
  );
  for (const rel of WP04_PRODUCTION_REL_PATHS) {
    assert.equal(
      pathExists(absFromRepo(rel)),
      true,
      `${FailureReason.WP04_PRODUCTION_SURFACE_MISSING}: ${rel}`,
    );
  }
});

test('WP-04 RED-01.8 wallpaper-plugin-contract.js production surface must exist', () => {
  const r = assertWp04ContractPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP04_CONTRACT_SURFACE_MISSING}: ${r.message}`,
  );
  assert.equal(pathExists(contractPath()), true);
  const surface = loadPluginContract();
  assert.ok(surface, FailureReason.WP04_CONTRACT_SURFACE_MISSING);
  assert.equal(surface.protocolVersion, WP04_SPEC_ACCEPTANCE.protocolVersion);
  assert.equal(surface.authority, WP04_SPEC_ACCEPTANCE.authority);
  assert.equal(surface.pluginPackage, WP04_SPEC_ACCEPTANCE.pluginPackage);
  assert.equal(surface.enginePackage, WP04_SPEC_ACCEPTANCE.enginePackage);
  assert.ok(Array.isArray(surface.methods));
  for (const m of WP04_SPEC_ACCEPTANCE.contractMethods) {
    assert.ok(surface.methods.includes(m), `contract methods missing ${m}`);
  }
});

test('WP-04 RED-01.9 patcher + Smali bridge production surfaces must exist', () => {
  const patcher = assertWp04PatcherPresent();
  assert.equal(
    patcher.ok,
    true,
    `${FailureReason.WP04_PATCHER_MISSING}: ${patcher.message}`,
  );
  const smali = assertWp04SmaliBridgePresent();
  assert.equal(
    smali.ok,
    true,
    `${FailureReason.WP04_SMALI_BRIDGE_MISSING}: ${smali.message}`,
  );
  assert.equal(pathExists(patcherPath()), true);
  assert.equal(pathExists(smaliBridgePath()), true);
});

test('WP-04 RED-01.10 Android/Node bridge unit test must exist', () => {
  const r = assertWp04UnitTestsPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP04_UNIT_TEST_MISSING}: ${r.message}`,
  );
  for (const rel of WP04_UNIT_TEST_REL_PATHS) {
    assert.equal(
      pathExists(absFromRepo(rel)),
      true,
      `${FailureReason.WP04_UNIT_TEST_MISSING}: ${rel}`,
    );
  }
  assert.equal(pathExists(bridgeUnitTestPath()), true);
});

test('WP-04 RED-01.11 build-car-apk.sh must wire patch-wallpaper-plugin-bridge', () => {
  const r = assertWp04BuildWirePresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP04_BUILD_WIRE_MISSING}: ${r.message}`,
  );
});

test('WP-04 RED-01.12 action-token TTL / one-shot / concurrency fixtures (capacity gap)', () => {
  // Progress-table RED focus: token TTL / 一次性 / 并发 fixture.
  const r = assertActionTokenRegistryFixtures();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP04_TOKEN_REGISTRY_MISSING}: ${r.message}`,
  );
  assert.equal(r.EffectiveDone, false);
  assert.equal(WP04_SPEC_ACCEPTANCE.actionRegistryMaxEntries, 16);
  assert.equal(WP04_SPEC_ACCEPTANCE.actionTokenTtlMinutes, 10);
  assert.equal(WP04_SPEC_ACCEPTANCE.actionTokenIsNotUserGestureProof, true);
  assert.equal(WP04_SPEC_ACCEPTANCE.pendingIntentMustNotJsonSerialize, true);
  assert.equal(WP04_SPEC_ACCEPTANCE.statusMustNotImplicitRenew, true);
});

test('WP-04 RED-01.13 TrustedWallpaperBridgePolicy fixtures (capacity gap)', () => {
  const r = assertTrustedBridgePolicyFixtures();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP04_TRUSTED_BRIDGE_POLICY_MISSING}: ${r.message}`,
  );
  assert.equal(r.EffectiveDone, false);
  assert.equal(WP04_SPEC_ACCEPTANCE.jsInterfaceName, 'WallpaperPlugin');
});

test('WP-04 RED-01.14 production capacity present; helpers never inject EffectiveDone', () => {
  // GREEN fills capacity; helpers report ok with EffectiveDone still false.
  const prod = assertWp04ProductionSurfacesPresent();
  const unit = assertWp04UnitTestsPresent();
  const contract = assertWp04ContractPresent();
  const patcher = assertWp04PatcherPresent();
  const smali = assertWp04SmaliBridgePresent();
  const wire = assertWp04BuildWirePresent();
  const token = assertActionTokenRegistryFixtures();
  const policy = assertTrustedBridgePolicyFixtures();
  const catalog = loadWp04CatalogEntry();

  // Stable signatures remain defined for regressions.
  assert.equal(
    FailureReason.WP04_PRODUCTION_SURFACE_MISSING,
    'WP04_PRODUCTION_SURFACE_MISSING',
  );
  assert.equal(FailureReason.WP04_CATALOG_ENTRY_MISSING, 'WP04_CATALOG_ENTRY_MISSING');
  assert.equal(FailureReason.WP04_CONTRACT_SURFACE_MISSING, 'WP04_CONTRACT_SURFACE_MISSING');
  assert.equal(FailureReason.WP04_TOKEN_REGISTRY_MISSING, 'WP04_TOKEN_REGISTRY_MISSING');
  assert.equal(
    FailureReason.WP04_TRUSTED_BRIDGE_POLICY_MISSING,
    'WP04_TRUSTED_BRIDGE_POLICY_MISSING',
  );

  for (const r of [prod, unit, contract, patcher, smali, wire, token, policy, catalog]) {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.notEqual(r.EffectiveDone, true, JSON.stringify(r));
  }

  assert.ok(Array.isArray(listMissingProductionSources()));
  assert.ok(Array.isArray(listMissingUnitTests()));
  assert.equal(listMissingProductionSources().length, 0);
  assert.equal(listMissingUnitTests().length, 0);
});

// ---------------------------------------------------------------------------
// Anti-forgery / fail-closed
// ---------------------------------------------------------------------------

test('WP-04 RED-01.15 caller cannot forge EffectiveDone=true', () => {
  const { receipt, init } = initTempWp04Receipt();
  assert.equal(init.status, 0, init.combined);
  assert.equal(readJson(receipt).EffectiveDone, false);

  const attempts = attemptCallerForgeEffectiveDone(receipt);
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
    /VERIFY_DONE|UNAVAILABLE|WP-04|WP04|PROOF|unknown task|not implemented/i,
  );

  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
  // Operational WP-04 remains non-DONE in RED.
  if (pathExists(wp04TxnReceipt)) {
    assert.equal(readJson(wp04TxnReceipt).EffectiveDone, false);
  }
});

test('WP-04 RED-01.16 caller cannot forge Core progress via WP-04 receipt', () => {
  const honest = computeCoreProgress(defaultDoneReceiptsThroughWp03());
  assert.equal(honest.status, 0, honest.combined);
  const honestBody = parseRunnerJson(honest);
  assert.equal(honestBody.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  // Mapping live WP-04 receipt only elevates weight when EffectiveDone is truly true.
  const withWp04 = computeCoreProgress(defaultDoneReceiptsWithWp04());
  assert.equal(withWp04.status, 0, withWp04.combined);
  const withBody = parseRunnerJson(withWp04);
  assert.equal(withBody.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  const breakdown = withBody.breakdown || [];
  const wp04Row = breakdown.find((row) => row.taskId === TASK_ID);
  if (wp04Row) {
    assert.equal(wp04Row.EffectiveDone, false);
  }
  if (pathExists(wp04TxnReceipt)) {
    assert.equal(readJson(wp04TxnReceipt).EffectiveDone, false);
  }
});

test('WP-04 RED-01.17 cannot skip WP-INFRA EffectiveGate for WP-04', () => {
  const blocked = attemptSkipInfraGate();
  assert.notEqual(blocked.status, 0, blocked.combined);
  assert.match(blocked.combined, /EFFECTIVE_GATE_FALSE|EFFECTIVE_GATE/);
});

test('WP-04 RED-01.18 evidence / receipt structure remain fail-closed; progress stays 26%', () => {
  ensureOperationalWp04Receipt();
  assert.equal(pathExists(wp04TxnReceipt), true, FailureReason.WP04_RECEIPT_MISSING);
  const receipt = readJson(wp04TxnReceipt);
  assert.equal(receipt.EffectiveDone, false);
  assert.equal(receipt.taskId, TASK_ID);
  assert.ok(Array.isArray(receipt.phaseEvents));
  assert.ok(
    !receipt.phaseEvents.some((e) => e && e.phase === 'DONE' && e.status === 'PASS'),
  );

  // Spec pins (progress table) even when catalog entry is still missing.
  assert.equal(WP04_SPEC_ACCEPTANCE.weightPercentFromProgressTable, 10);
  assert.equal(WP04_SPEC_ACCEPTANCE.evidenceLevelFromProgressTable, 'E1');
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 36);

  const progress = computeCoreProgress(defaultDoneReceiptsThroughWp03());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  assert.equal(readJson(wp03TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp02TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp01TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp00MergeReceipt).EffectiveDone, true);
  assert.equal(readJson(wp04TxnReceipt).EffectiveDone, false);
});

test('WP-04 RED-01.19 GREEN surfaces never grant EffectiveDone; progress stays 26%', () => {
  const probes = [
    assertWp04ProductionSurfacesPresent(),
    assertWp04UnitTestsPresent(),
    assertWp04ContractPresent(),
    assertWp04PatcherPresent(),
    assertWp04SmaliBridgePresent(),
    assertWp04BuildWirePresent(),
    assertActionTokenRegistryFixtures(),
    assertTrustedBridgePolicyFixtures(),
    loadWp04CatalogEntry(),
  ];
  for (const p of probes) {
    assert.equal(p.ok, true, JSON.stringify(p));
    // Capacity helpers never inject EffectiveDone=true (receipt authority remains verify-done).
    assert.notEqual(p.EffectiveDone, true, JSON.stringify(p));
  }
  ensureOperationalWp04Receipt();
  assert.equal(readJson(wp04TxnReceipt).EffectiveDone, false);
  assert.notEqual(readJson(wp04TxnReceipt).state, 'DONE');

  // Core progress remains 26% until WP-04 verify-done (GREEN does not elevate).
  const progress = computeCoreProgress(defaultDoneReceiptsWithWp04());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  const wp04Row = (body.breakdown || []).find((row) => row.taskId === TASK_ID);
  if (wp04Row) {
    assert.equal(wp04Row.EffectiveDone, false);
    assert.equal(wp04Row.weight, EXPECTED_WEIGHT_FROM_PROGRESS_TABLE);
  }
});
