'use strict';

/**
 * WP-02 / RED-01 — runtime Provider / ledger / claimLaunch contracts.
 *
 * RED only: proves catalog identity, prerequisites, transaction init,
 * missing production surfaces, and fail-closed anti-forgery guards.
 *
 * Does NOT implement production Kotlin/runtime classes.
 * Does NOT mark WP-02 EffectiveDone or raise Core progress.
 * Does NOT touch WallpaperEngine main worktree.
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
  runtimeContractPath,
  finalInfraReceipt,
  wp00MergeReceipt,
  wp01TxnReceipt,
  wp02TxnReceipt,
  transactionsRoot,
  TASK_ID,
  WP02_PRODUCTION_SOURCES,
  WP02_UNIT_TEST_SOURCES,
  WP02_MANIFEST_MARKERS,
  FailureReason,
  git,
  runRunner,
  runPython,
  readJson,
  pathExists,
  loadWp02CatalogEntry,
  parseWp02CatalogIdentity,
  readPrerequisiteDone,
  assertWp02ProductionSurfacesPresent,
  assertWp02UnitTestsPresent,
  assertWp02ManifestRuntime,
  assertWp02RequiredInputs,
  listMissingProductionSources,
  listMissingUnitTests,
  loadRuntimeContract,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceipts,
  defaultDoneReceiptsWithForgedWp02,
  parseRunnerJson,
  productionSourcePath,
  unitTestSourcePath,
  androidManifestPath,
  catalogToolPath,
  initTempWp02Receipt,
  liveWp02OperationalProgress,
  liveAuthoritativeBaseSha,
  classifyHeadVsLiveBase,
  isAllowedTaskBranch,
  readTaskWorktreeIdentity,
  isGitAncestor,
} = require('./wallpaper-wp02-red-helpers');

// ---------------------------------------------------------------------------
// Environment / prerequisites (may pass in RED)
// ---------------------------------------------------------------------------

test('WP-02 RED-01: environment paths and tools are real', () => {
  assert.equal(pathExists(runnerPath), true, 'runner missing');
  assert.equal(pathExists(catalogPath), true, 'catalog missing');
  assert.equal(pathExists(schemaPath), true, 'schema missing');
  assert.equal(pathExists(finalInfraReceipt), true, 'WP-INFRA final receipt missing');
  assert.equal(pathExists(wp00MergeReceipt), true, 'WP-00 merge receipt missing');
  assert.equal(pathExists(wp01TxnReceipt), true, 'WP-01 txn receipt missing');
  assert.equal(pathExists(path.join(repoRoot, 'wallpaper-plugin')), true);
});

test('WP-02 RED-01: worktree branch and live base identity', () => {
  // Live base from origin ls-remote; HEAD may equal live or be a descendant.
  const identity = readTaskWorktreeIdentity();
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(identity.branch, /^codex\/wallpaper-plugin-/);
  assert.match(identity.head, /^[0-9a-f]{40}$/);
  assert.equal(identity.liveBaseSha, liveAuthoritativeBaseSha());
  assert.ok(
    identity.relation === 'equal' || identity.relation === 'ahead',
    `unexpected relation: ${identity.relation}`,
  );
  if (identity.relation === 'ahead') {
    assert.equal(isGitAncestor(identity.liveBaseSha, identity.head), true);
  }
});

test('WP-02 RED-01: head/live relation and branch/forgery fixtures', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.equal(classifyHeadVsLiveBase(a, a, {}).relation, 'equal');
  assert.equal(classifyHeadVsLiveBase(b, a, { liveIsAncestorOfHead: true }).ok, true);
  assert.equal(
    classifyHeadVsLiveBase(a, b, { headIsAncestorOfLive: true }).failureReason,
    'HEAD_BEHIND_LIVE_BASE',
  );
  assert.equal(
    classifyHeadVsLiveBase(a, b, {}).failureReason,
    'HEAD_DIVERGED_FROM_LIVE_BASE',
  );
  assert.equal(isAllowedTaskBranch('codex/wallpaper-plugin-wp02').ok, true);
  assert.equal(isAllowedTaskBranch('main').ok, false);
  assert.equal(isAllowedTaskBranch('huawei-android12-car').ok, false);
  assert.equal(
    readTaskWorktreeIdentity({ claimedHead: a, merged: true }).failureReason,
    'CALLER_FORGED_IDENTITY',
  );
});

test('WP-02 RED-01: prerequisites WP-INFRA / WP-00 / WP-01 are EffectiveDone', () => {
  const prereq = readPrerequisiteDone();
  assert.equal(prereq.ok, true, JSON.stringify(prereq));
  assert.equal(prereq.WP_INFRA.EffectiveGate, true);
  assert.equal(prereq.WP_INFRA.EffectiveDone, true);
  assert.equal(prereq['WP-00'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].EffectiveDone, true);
  assert.equal(prereq['WP-01'].state, 'DONE');
});

test('WP-02 RED-01: WP-01 DONE is a required catalog-level prerequisite for WP-02', () => {
  // Dynamic: when catalog entry exists, requiredEffectiveDone must include WP-01.
  // RED: catalog entry is currently missing → stable production gap signature.
  const identity = parseWp02CatalogIdentity();
  if (!identity.ok) {
    assert.equal(
      identity.failureReason,
      FailureReason.WP02_CATALOG_ENTRY_MISSING,
      JSON.stringify(identity),
    );
    assert.fail(
      `${FailureReason.WP02_CATALOG_ENTRY_MISSING}: cannot bind WP-01 prerequisite ` +
        `from authoritative catalog (WP-02 entry absent)`,
    );
  }
  assert.ok(
    Array.isArray(identity.requiredEffectiveDone),
    'requiredEffectiveDone must be array',
  );
  assert.ok(
    identity.requiredEffectiveDone.includes('WP-01'),
    'WP-02.requiredEffectiveDone must include WP-01',
  );
  assert.ok(
    identity.dependsOn.includes('WP-01'),
    'WP-02.dependsOn must include WP-01',
  );
  for (const dep of ['WP-INFRA', 'WP-00', 'WP-01']) {
    assert.ok(
      identity.dependsOn.includes(dep) || identity.requiredEffectiveDone.includes(dep),
      `WP-02 must declare prerequisite ${dep}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Catalog identity (RED: must fail until GREEN adds WP-02 catalog entry)
// ---------------------------------------------------------------------------

test('WP-02 RED-01.1 catalog must contain unique WP-02 task identity', () => {
  const loaded = loadWp02CatalogEntry();
  assert.equal(
    loaded.ok,
    true,
    `${FailureReason.WP02_CATALOG_ENTRY_MISSING}: ${loaded.message}`,
  );
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-02 RED-01.2 catalog WP-02 fields must be dynamically parseable', () => {
  const identity = parseWp02CatalogIdentity();
  assert.equal(
    identity.ok,
    true,
    `${identity.failureReason || 'FAIL'}: ${identity.message || ''}`,
  );
  assert.equal(identity.taskId, TASK_ID);
  assert.equal(typeof identity.weight, 'number');
  assert.ok(identity.weight > 0, 'WP-02 weight must be positive');
  assert.equal(typeof identity.scopeCheck, 'object');
  assert.ok(identity.scopeCheck);
  assert.ok(Array.isArray(identity.dependsOn));
  assert.ok(Array.isArray(identity.requiredEffectiveDone));
  assert.equal(typeof identity.evidenceLevel, 'string');
  assert.match(String(identity.evidenceLevel), /^E[0-7]$/);
  assert.equal(typeof identity.phaseCommands, 'object');
  assert.equal(typeof identity.expectedExit, 'object');
  assert.equal(typeof identity.failureSignaturePolicy, 'object');
  // RED phase must remain non-zero exit in catalog policy
  assert.notEqual(identity.expectedExit.RED, 0);
});

test('WP-02 RED-01.3 catalog validate remains well-formed with unique WP-02', () => {
  // Authoritative catalog must validate; GREEN registers exactly one WP-02 entry.
  const result = runPython(catalogToolPath, [
    'validate',
    '--require-canonical-catalog',
    '--require-canonical-schema',
  ]);
  assert.equal(result.status, 0, result.combined);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, true);
  const loaded = loadWp02CatalogEntry();
  assert.equal(loaded.ok, true, loaded.message || '');
  assert.equal(loaded.task.taskId, TASK_ID);
  // Duplicate taskId must still be rejected by schema/catalog tool (uniqueness).
  assert.equal(
    (loaded.catalog.tasks || []).filter((t) => t && t.taskId === TASK_ID).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Transaction init / receipt structure (RED keeps EffectiveDone=false)
// ---------------------------------------------------------------------------

test('WP-02 RED-01.4 transaction receipt structure is valid (pre-close fail-closed or post-close DONE)', () => {
  assert.equal(pathExists(wp02TxnReceipt), true, 'wp-02 transaction receipt missing');
  const receipt = readJson(wp02TxnReceipt);
  assert.equal(receipt.taskId, TASK_ID);
  assert.equal(receipt.schema, 'wallpaper-task-receipt/v1');
  assert.equal(typeof receipt.revision, 'number');
  assert.ok(Array.isArray(receipt.attempts));
  assert.ok(Array.isArray(receipt.phaseEvents));
  // mode 0600
  const mode = fs.statSync(wp02TxnReceipt).mode & 0o777;
  assert.equal(mode, 0o600, `receipt mode must be 0600, got ${mode.toString(8)}`);

  const live = liveWp02OperationalProgress();
  if (live.EffectiveDone) {
    // Post operational CLOSE-VERIFY: DONE only via verify-done, never caller CAS.
    assert.equal(receipt.EffectiveDone, true);
    assert.equal(receipt.state, 'DONE');
    assert.ok(receipt.verifyDone && typeof receipt.verifyDone === 'object');
    assert.match(String(receipt.verifyDone.liveBaseSha || ''), /^[0-9a-f]{40}$/);
  } else {
    assert.equal(receipt.EffectiveDone, false);
    assert.notEqual(receipt.state, 'DONE');
    // Live phase advances RED → GREEN → REFACTOR → VERIFY_READY without DONE elevation.
    assert.ok(
      [
        'INIT',
        'RED_RECORDED',
        'GREEN_RECORDED',
        'REFACTOR_RECORDED',
        'VERIFY_READY',
      ].includes(receipt.state),
      `unexpected WP-02 state: ${receipt.state}`,
    );
  }
});

test('WP-02 RED-01.5 runner reconcile/init/assert-state for WP-02', () => {
  const before = liveWp02OperationalProgress();
  const reconcile = runRunner([
    'reconcile',
    '--task',
    TASK_ID,
    '--transactions',
    transactionsRoot,
  ]);
  assert.equal(reconcile.status, 0, reconcile.combined);
  const init = runRunner([
    'init',
    '--task',
    TASK_ID,
    '--transactions',
    transactionsRoot,
  ]);
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
  const after = readJson(wp02TxnReceipt);
  assert.equal(after.EffectiveDone, before.EffectiveDone);
  assert.equal(after.state === 'DONE', before.EffectiveDone);
});

// ---------------------------------------------------------------------------
// Required inputs present (WP-01 protocol) / outputs absent (WP-02 runtime)
// ---------------------------------------------------------------------------

test('WP-02 RED-01.6 required inputs PluginContract/PluginResult already exist', () => {
  const inputs = assertWp02RequiredInputs();
  assert.equal(inputs.ok, true, JSON.stringify(inputs));
});

test('WP-02 RED-01.7 production runtime sources must exist (capacity gap until GREEN)', () => {
  const r = assertWp02ProductionSurfacesPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP02_PRODUCTION_SURFACE_MISSING}: ${r.message}`,
  );
  for (const name of WP02_PRODUCTION_SOURCES) {
    assert.equal(
      pathExists(productionSourcePath(name)),
      true,
      `${FailureReason.WP02_PRODUCTION_SURFACE_MISSING}: ${name}`,
    );
  }
});

test('WP-02 RED-01.8 Android unit tests for caller/ledger/Provider must exist', () => {
  const r = assertWp02UnitTestsPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP02_UNIT_TEST_MISSING}: ${r.message}`,
  );
  for (const name of WP02_UNIT_TEST_SOURCES) {
    assert.equal(
      pathExists(unitTestSourcePath(name)),
      true,
      `${FailureReason.WP02_UNIT_TEST_MISSING}: ${name}`,
    );
  }
});

test('WP-02 RED-01.9 manifest must wire :we_runtime Provider/Service/Activity', () => {
  const r = assertWp02ManifestRuntime();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP02_MANIFEST_RUNTIME_MISSING}: ${r.message}`,
  );
  const text = fs.readFileSync(androidManifestPath(), 'utf8');
  for (const marker of WP02_MANIFEST_MARKERS) {
    assert.ok(text.includes(marker), `manifest missing ${marker}`);
  }
});

test('WP-02 RED-01.10 Node runtime contract production surface must exist', () => {
  assert.equal(
    pathExists(runtimeContractPath),
    true,
    `${FailureReason.WP02_CONTRACT_SURFACE_MISSING}: GREEN must add ${runtimeContractPath}`,
  );
  const surface = loadRuntimeContract();
  assert.ok(surface, FailureReason.WP02_CONTRACT_SURFACE_MISSING);
  assert.equal(typeof surface.assertWp02RuntimeReady, 'function');
  assert.equal(typeof surface.assertClaimLaunchAtomic, 'function');
  assert.equal(typeof surface.assertPendingIntentOneShot, 'function');
  assert.equal(typeof surface.assertCallerPolicy, 'function');
  assert.equal(typeof surface.assertWp02NotDone, 'function');
});

// ---------------------------------------------------------------------------
// Missing production: stable failure signatures (direct probes, must stay RED)
// ---------------------------------------------------------------------------

test('WP-02 RED-01.11 production capacity present; gap helpers stay fail-closed when empty', () => {
  // GREEN fills capacity; helpers must report ok with EffectiveDone still false.
  assert.equal(listMissingProductionSources().length, 0);
  assert.equal(listMissingUnitTests().length, 0);
  const manifest = assertWp02ManifestRuntime();
  const catalog = loadWp02CatalogEntry();
  const prod = assertWp02ProductionSurfacesPresent();
  const tests = assertWp02UnitTestsPresent();
  assert.equal(prod.ok, true, prod.message || '');
  assert.equal(prod.EffectiveDone, false);
  assert.equal(tests.ok, true, tests.message || '');
  assert.equal(tests.EffectiveDone, false);
  assert.equal(manifest.ok, true, manifest.message || '');
  assert.equal(manifest.EffectiveDone, false);
  assert.equal(catalog.ok, true, catalog.message || '');
  assert.equal(pathExists(runtimeContractPath), true);
  // Stable failure signatures remain defined for future regressions.
  assert.equal(
    FailureReason.WP02_PRODUCTION_SURFACE_MISSING,
    'WP02_PRODUCTION_SURFACE_MISSING',
  );
  assert.equal(FailureReason.WP02_CATALOG_ENTRY_MISSING, 'WP02_CATALOG_ENTRY_MISSING');
});

// ---------------------------------------------------------------------------
// Anti-forgery / fail-closed (must pass: runner already rejects)
// ---------------------------------------------------------------------------

test('WP-02 RED-01.12 caller cannot forge EffectiveDone=true', () => {
  // Anti-forgery uses a fresh INIT receipt so operational post-close DONE is not confused with forge.
  const { receipt: tempReceipt, init } = initTempWp02Receipt();
  assert.equal(init.status, 0, init.combined);
  assert.equal(readJson(tempReceipt).EffectiveDone, false);

  const attempts = attemptCallerForgeEffectiveDone(tempReceipt);
  assert.notEqual(attempts.cas.status, 0, attempts.cas.combined);
  assert.match(
    attempts.cas.combined,
    /ONLY_VERIFY_DONE_MAY_ENABLE_EFFECTIVE_DONE|CALLER|EffectiveDone|ILLEGAL/i,
  );

  assert.notEqual(attempts.declare.status, 0, attempts.declare.combined);
  assert.match(attempts.declare.combined, /CALLER_DECLARED_DONE/);

  assert.notEqual(attempts.casState.status, 0, attempts.casState.combined);
  assert.match(attempts.casState.combined, /CALLER_DECLARED_DONE|ILLEGAL|DONE|STATE/i);

  assert.notEqual(attempts.verify.status, 0, attempts.verify.combined);
  // Missing proofs / fail-closed — never silent elevation.
  assert.match(
    attempts.verify.combined,
    /WP01_VERIFY_DONE_UNAVAILABLE|VERIFY_DONE|WP02|UNAVAILABLE|PROOF|missing/i,
  );

  assert.equal(readJson(tempReceipt).EffectiveDone, false);
  assert.notEqual(readJson(tempReceipt).state, 'DONE');

  // Operational receipt truth is independent of caller forge attempts on temp.
  const live = liveWp02OperationalProgress();
  if (live.EffectiveDone) {
    assert.ok(live.receipt.verifyDone, 'operational DONE requires verifyDone proof');
  } else {
    assert.equal(live.receipt.EffectiveDone, false);
  }
});

test('WP-02 RED-01.13 caller cannot forge Core progress via WP-02 receipt', () => {
  // WP-00+WP-01 only (helpers default) always 10% — independent of WP-02 operational close.
  const honest = computeCoreProgress(defaultDoneReceipts());
  assert.equal(honest.status, 0, honest.combined);
  const honestBody = parseRunnerJson(honest);
  assert.equal(honestBody.coreProgressPercent, 10);

  const live = liveWp02OperationalProgress();
  // Mapping live WP-02 receipt only elevates weight when EffectiveDone is truly true.
  const withWp02 = computeCoreProgress(defaultDoneReceiptsWithForgedWp02());
  assert.equal(withWp02.status, 0, withWp02.combined);
  const withBody = parseRunnerJson(withWp02);
  assert.equal(withBody.coreProgressPercent, live.expectedCoreProgressPercent);

  const breakdown = withBody.breakdown || [];
  const wp02Row = breakdown.find((row) => row.taskId === TASK_ID);
  if (wp02Row) {
    assert.equal(wp02Row.EffectiveDone, live.EffectiveDone);
    assert.equal(wp02Row.weight, 8);
  }

  // Temp non-DONE receipt must never inflate progress when mapped.
  const { receipt: tempReceipt, init } = initTempWp02Receipt();
  assert.equal(init.status, 0, init.combined);
  const withTemp = computeCoreProgress({
    ...defaultDoneReceipts(),
    'WP-02': tempReceipt,
  });
  assert.equal(withTemp.status, 0, withTemp.combined);
  assert.equal(parseRunnerJson(withTemp).coreProgressPercent, 10);
});

test('WP-02 RED-01.14 cannot skip WP-INFRA EffectiveGate for WP-02', () => {
  const blocked = attemptSkipInfraGate();
  assert.notEqual(blocked.status, 0, blocked.combined);
  assert.match(blocked.combined, /EFFECTIVE_GATE_FALSE|EFFECTIVE_GATE/);
});

test('WP-02 RED-01.15 evidence level / receipt structure remain fail-closed', () => {
  const receipt = readJson(wp02TxnReceipt);
  assert.equal(receipt.taskId, TASK_ID);
  const live = liveWp02OperationalProgress();
  if (live.EffectiveDone) {
    // DONE phase may exist only after authoritative verify-done close.
    assert.equal(receipt.EffectiveDone, true);
    assert.ok(receipt.verifyDone);
  } else {
    assert.equal(receipt.EffectiveDone, false);
    // No caller may append DONE phase without verify-done
    assert.ok(
      !receipt.phaseEvents.some((e) => e && e.phase === 'DONE' && e.status === 'PASS'),
    );
  }

  const identity = parseWp02CatalogIdentity();
  if (identity.ok) {
    // When catalog exists, evidence level must be legal and RED policy required.
    assert.match(String(identity.evidenceLevel), /^E[0-7]$/);
    assert.ok(identity.failureSignaturePolicy.RED);
    assert.equal(identity.failureSignaturePolicy.RED.required, true);
  } else {
    assert.equal(identity.failureReason, FailureReason.WP02_CATALOG_ENTRY_MISSING);
    // Evidence-level binding cannot be forged without catalog — fail-closed.
    assert.fail(
      `${FailureReason.WP02_CATALOG_ENTRY_MISSING}: evidenceLevel not bindable without catalog entry`,
    );
  }
});

test('WP-02 RED-01.16 Core progress tracks live WP-02 EffectiveDone (10% pre-close / 18% post-close)', () => {
  const live = liveWp02OperationalProgress();
  // Progress without WP-02 weight stays 10%.
  const without = computeCoreProgress(defaultDoneReceipts());
  assert.equal(without.status, 0, without.combined);
  assert.equal(parseRunnerJson(without).coreProgressPercent, 10);

  const withMap = computeCoreProgress(defaultDoneReceiptsWithForgedWp02());
  assert.equal(withMap.status, 0, withMap.combined);
  assert.equal(
    parseRunnerJson(withMap).coreProgressPercent,
    live.expectedCoreProgressPercent,
  );
  assert.equal(readJson(wp02TxnReceipt).EffectiveDone, live.EffectiveDone);
  assert.equal(readJson(wp01TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp00MergeReceipt).EffectiveDone, true);
});

test('WP-02 RED-01.17 runtime surfaces never grant EffectiveDone; caller claims fail-closed', () => {
  const probes = [
    assertWp02ProductionSurfacesPresent(),
    assertWp02UnitTestsPresent(),
    assertWp02ManifestRuntime(),
    loadWp02CatalogEntry(),
  ];
  for (const p of probes) {
    assert.equal(p.ok, true, JSON.stringify(p));
    // Gap/catalog helpers never inject EffectiveDone=true (receipt truth is separate).
    assert.notEqual(p.EffectiveDone, true);
  }
  const surface = loadRuntimeContract();
  assert.ok(surface, FailureReason.WP02_CONTRACT_SURFACE_MISSING);
  const notDone = surface.assertWp02NotDone({
    claimedEffectiveDone: true,
    claimedCoreProgress: 18,
    callerClaims: { REMOTE_VERIFIED: true, merged: true },
  });
  assert.equal(notDone.ok, false);
  assert.equal(notDone.EffectiveDone, false);
  const ready = surface.assertWp02RuntimeReady({ cwd: repoRoot });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  // Contract facade does not elevate EffectiveDone — receipt authority remains runner/verify-done.
  assert.equal(ready.EffectiveDone, false);
});
