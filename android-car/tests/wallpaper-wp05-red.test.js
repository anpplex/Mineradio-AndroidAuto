'use strict';

/**
 * WP-05 / RED-01 — Mineradio FileProvider / URI two-hop / grant-revoke / 24h cleanup.
 *
 * RED only: catalog entry + production capacity gaps. Failures prove capacity
 * missing — not path/worktree self-injury. Does not implement production code.
 * Does not claim WP-05 EffectiveDone or raise Core progress above 36%.
 *
 * Spec anchors (read-only):
 *   PROGRESS: weight 8% E1; Provider/URI lifecycle RED fixtures
 *   DEVELOPMENT Task 5: paths XML / stager Smali / manifest FileProvider /
 *                       importMpkg(contentUri) / file-provider unit test
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
  wp05TxnReceipt,
  transactionsRoot,
  TASK_ID,
  EXPECTED_CURRENT_CORE_PROGRESS,
  EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  EXPECTED_PROGRESS_WHEN_DONE,
  WP05_PRODUCTION_CREATE_REL_PATHS,
  WP05_UNIT_TEST_REL_PATHS,
  WP05_SPEC_ACCEPTANCE,
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
  loadWp05CatalogEntry,
  parseWp05CatalogIdentity,
  readPrerequisiteDone,
  liveWp05OperationalProgress,
  assertWp05ProductionSurfacesPresent,
  assertWp05PathsXmlCapacity,
  assertWp05StagerSmaliPresent,
  assertWp05ManifestProviderCapacity,
  assertWp05PatcherPathsWire,
  assertWp05ImportMpkgCapacity,
  assertWp05UnitTestsPresent,
  assertWp05RequiredInputs,
  assertWp05FullProductionCapacity,
  listMissingProductionCreates,
  listMissingUnitTests,
  attemptCallerForgeEffectiveDone,
  attemptSkipInfraGate,
  computeCoreProgress,
  defaultDoneReceiptsThroughWp04,
  defaultDoneReceiptsWithWp05,
  parseRunnerJson,
  initTempWp05Receipt,
  ensureOperationalWp05Receipt,
  absFromRepo,
  fileProviderUnitTestPath,
} = require('./wallpaper-wp05-red-helpers');

// ---------------------------------------------------------------------------
// Environment / prerequisites (must PASS in RED — no self-injury)
// ---------------------------------------------------------------------------

test('WP-05 RED-01: environment paths and tools are real', () => {
  assert.equal(pathExists(runnerPath), true, 'runner missing');
  assert.equal(pathExists(catalogPath), true, 'catalog missing');
  assert.equal(pathExists(schemaPath), true, 'schema missing');
  assert.equal(pathExists(finalInfraReceipt), true);
  assert.equal(pathExists(wp00MergeReceipt), true);
  assert.equal(pathExists(wp01TxnReceipt), true);
  assert.equal(pathExists(wp02TxnReceipt), true);
  assert.equal(pathExists(wp03TxnReceipt), true);
  assert.equal(pathExists(wp04TxnReceipt), true);
  assert.equal(pathExists(path.join(repoRoot, 'wallpaper-plugin')), true);
  assert.equal(pathExists(catalogToolPath), true);
});

test('WP-05 RED-01: worktree branch and live base identity', () => {
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

test('WP-05 RED-01: head/live relation fixtures (equal/ahead pass; behind/diverged fail)', () => {
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

test('WP-05 RED-01: task branch allowlist and caller identity forgery fail-closed', () => {
  assert.equal(isAllowedTaskBranch('codex/wallpaper-plugin-wp05').ok, true);
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

test('WP-05 RED-01: prerequisites WP-INFRA / WP-00…WP-04 EffectiveDone', () => {
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
  assert.equal(prereq['WP-04'].EffectiveDone, true);
  assert.equal(prereq['WP-04'].state, 'DONE');
});

test('WP-05 RED-01: WP-04 DONE is required catalog-level prerequisite for WP-05', () => {
  const identity = parseWp05CatalogIdentity();
  if (!identity.ok) {
    assert.equal(
      identity.failureReason,
      FailureReason.WP05_CATALOG_ENTRY_MISSING,
      JSON.stringify(identity),
    );
    assert.ok(WP05_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-04'));
    assert.ok(WP05_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-INFRA'));
    assert.ok(WP05_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-00'));
    assert.ok(WP05_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-01'));
    assert.ok(WP05_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-02'));
    assert.ok(WP05_SPEC_ACCEPTANCE.requiredEffectiveDone.includes('WP-03'));
    assert.fail(
      `${FailureReason.WP05_CATALOG_ENTRY_MISSING}: cannot bind WP-04 prerequisite ` +
        `from authoritative catalog (WP-05 entry absent)`,
    );
  }
  assert.ok(identity.requiredEffectiveDone.includes('WP-04'));
  assert.ok(identity.dependsOn.includes('WP-04'));
  for (const dep of WP05_SPEC_ACCEPTANCE.requiredEffectiveDone) {
    assert.ok(
      identity.dependsOn.includes(dep) || identity.requiredEffectiveDone.includes(dep),
      `WP-05 must declare prerequisite ${dep}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Catalog identity (RED: fails until GREEN registers WP-05)
// ---------------------------------------------------------------------------

test('WP-05 RED-01.1 catalog must contain unique WP-05 task identity', () => {
  const loaded = loadWp05CatalogEntry();
  assert.equal(
    loaded.ok,
    true,
    `${FailureReason.WP05_CATALOG_ENTRY_MISSING}: ${loaded.message}`,
  );
  assert.equal(loaded.task.taskId, TASK_ID);
});

test('WP-05 RED-01.2 catalog WP-05 fields must be dynamically parseable', () => {
  const identity = parseWp05CatalogIdentity();
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

test('WP-05 RED-01.3 catalog validate + progress-table weight/E1 pin for GREEN registration', () => {
  const result = runPython(catalogToolPath, [
    'validate',
    '--require-canonical-catalog',
    '--require-canonical-schema',
  ]);
  assert.equal(result.status, 0, result.combined);
  const body = parseRunnerJson(result);
  assert.equal(body && body.ok, true);
  // Spec/progress pin weight 8% / E1 for GREEN catalog registration (not guessed).
  assert.equal(
    WP05_SPEC_ACCEPTANCE.weightPercentFromProgressTable,
    EXPECTED_WEIGHT_FROM_PROGRESS_TABLE,
  );
  assert.equal(WP05_SPEC_ACCEPTANCE.evidenceLevelFromProgressTable, 'E1');
  const loaded = loadWp05CatalogEntry();
  assert.equal(
    loaded.ok,
    true,
    `${FailureReason.WP05_CATALOG_ENTRY_MISSING}: ${loaded.message || ''}`,
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

test('WP-05 RED-01.4 transaction receipt initializes fail-closed (not DONE)', () => {
  const ensured = ensureOperationalWp05Receipt();
  assert.equal(pathExists(wp05TxnReceipt), true, 'wp-05 transaction receipt missing');
  if (ensured.init) {
    assert.equal(ensured.init.status, 0, ensured.init.combined);
  }
  const receipt = readJson(wp05TxnReceipt);
  assert.equal(receipt.taskId, TASK_ID);
  assert.equal(receipt.schema, 'wallpaper-task-receipt/v1');
  const mode = fs.statSync(wp05TxnReceipt).mode & 0o777;
  assert.equal(mode, 0o600, `receipt mode must be 0600, got ${mode.toString(8)}`);

  const live = liveWp05OperationalProgress();
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
      `unexpected WP-05 state: ${receipt.state}`,
    );
  }
});

test('WP-05 RED-01.5 runner reconcile/init/assert-state for WP-05', () => {
  ensureOperationalWp05Receipt();
  const before = liveWp05OperationalProgress();
  assert.equal(before.exists, true, FailureReason.WP05_RECEIPT_MISSING);
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
  const after = readJson(wp05TxnReceipt);
  assert.equal(after.EffectiveDone, before.EffectiveDone);
  assert.equal(after.state === 'DONE', before.EffectiveDone === true);
});

// ---------------------------------------------------------------------------
// Inputs present (WP-01…04) / outputs absent (WP-05 capacity)
// ---------------------------------------------------------------------------

test('WP-05 RED-01.6 required WP-01…WP-04 inputs already exist', () => {
  const inputs = assertWp05RequiredInputs();
  assert.equal(inputs.ok, true, JSON.stringify(inputs));
});

test('WP-05 RED-01.7 production Create surfaces must exist (capacity gap)', () => {
  const r = assertWp05ProductionSurfacesPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_PRODUCTION_SURFACE_MISSING}: ${r.message}`,
  );
  for (const rel of WP05_PRODUCTION_CREATE_REL_PATHS) {
    assert.equal(
      pathExists(absFromRepo(rel)),
      true,
      `${FailureReason.WP05_PRODUCTION_SURFACE_MISSING}: ${rel}`,
    );
  }
});

test('WP-05 RED-01.8 wallpaper_plugin_paths.xml cache-path capacity', () => {
  const r = assertWp05PathsXmlCapacity();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_PATHS_XML_MISSING}: ${r.message}`,
  );
});

test('WP-05 RED-01.9 CarWallpaperMpkgStager.smali production surface', () => {
  const r = assertWp05StagerSmaliPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_STAGER_SMALI_MISSING}: ${r.message}`,
  );
});

test('WP-05 RED-01.10 Manifest FileProvider authority wiring capacity', () => {
  const r = assertWp05ManifestProviderCapacity();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_MANIFEST_PROVIDER_MISSING}: ${r.message}`,
  );
  assert.equal(
    WP05_SPEC_ACCEPTANCE.fileProviderAuthority,
    'com.mineradio.app.wallpaperplugin.files',
  );
});

test('WP-05 RED-01.11 patcher must wire paths XML into decoded APK res/xml', () => {
  const r = assertWp05PatcherPathsWire();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_PATCHER_PATHS_WIRE_MISSING}: ${r.message}`,
  );
});

test('WP-05 RED-01.12 importMpkg content:// stager capacity (not WP-04 stub)', () => {
  const r = assertWp05ImportMpkgCapacity();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_IMPORT_MPKG_CAPACITY_MISSING}: ${r.message}`,
  );
  assert.equal(WP05_SPEC_ACCEPTANCE.contentSchemeOnly, 'content://');
  assert.equal(WP05_SPEC_ACCEPTANCE.forbidAbsolutePaths, true);
  assert.equal(WP05_SPEC_ACCEPTANCE.cleanupWindowHours, 24);
  assert.equal(WP05_SPEC_ACCEPTANCE.grantPluginPackage, 'com.motif.wallpaperengine');
});

test('WP-05 RED-01.13 wallpaper-plugin-file-provider unit test must exist', () => {
  const r = assertWp05UnitTestsPresent();
  assert.equal(
    r.ok,
    true,
    `${FailureReason.WP05_UNIT_TEST_MISSING}: ${r.message}`,
  );
  for (const rel of WP05_UNIT_TEST_REL_PATHS) {
    assert.equal(
      pathExists(absFromRepo(rel)),
      true,
      `${FailureReason.WP05_UNIT_TEST_MISSING}: ${rel}`,
    );
  }
  assert.equal(pathExists(fileProviderUnitTestPath()), true);
});

test('WP-05 RED-01.14 full production capacity aggregate (stable gap signatures)', () => {
  const r = assertWp05FullProductionCapacity();
  assert.equal(
    FailureReason.WP05_PRODUCTION_SURFACE_MISSING,
    'WP05_PRODUCTION_SURFACE_MISSING',
  );
  assert.equal(FailureReason.WP05_CATALOG_ENTRY_MISSING, 'WP05_CATALOG_ENTRY_MISSING');
  assert.equal(FailureReason.WP05_PATHS_XML_MISSING, 'WP05_PATHS_XML_MISSING');
  assert.equal(FailureReason.WP05_STAGER_SMALI_MISSING, 'WP05_STAGER_SMALI_MISSING');
  assert.equal(
    FailureReason.WP05_MANIFEST_PROVIDER_MISSING,
    'WP05_MANIFEST_PROVIDER_MISSING',
  );
  assert.equal(
    FailureReason.WP05_PATCHER_PATHS_WIRE_MISSING,
    'WP05_PATCHER_PATHS_WIRE_MISSING',
  );
  assert.equal(
    FailureReason.WP05_IMPORT_MPKG_CAPACITY_MISSING,
    'WP05_IMPORT_MPKG_CAPACITY_MISSING',
  );
  assert.equal(
    r.ok,
    true,
    `${r.failureReason || FailureReason.WP05_PRODUCTION_SURFACE_MISSING}: ${r.message}`,
  );
  assert.notEqual(r.EffectiveDone, true);
});

// ---------------------------------------------------------------------------
// Anti-forgery / fail-closed
// ---------------------------------------------------------------------------

test('WP-05 RED-01.15 caller cannot forge EffectiveDone=true', () => {
  const { receipt, init } = initTempWp05Receipt();
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
    /VERIFY_DONE|UNAVAILABLE|WP-05|WP05|PROOF|unknown task|not implemented/i,
  );

  assert.equal(readJson(receipt).EffectiveDone, false);
  assert.notEqual(readJson(receipt).state, 'DONE');
  if (pathExists(wp05TxnReceipt)) {
    assert.equal(readJson(wp05TxnReceipt).EffectiveDone, false);
  }
});

test('WP-05 RED-01.16 caller cannot forge Core progress via WP-05 receipt', () => {
  const honest = computeCoreProgress(defaultDoneReceiptsThroughWp04());
  assert.equal(honest.status, 0, honest.combined);
  const honestBody = parseRunnerJson(honest);
  assert.equal(honestBody.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  // Mapping live WP-05 receipt only elevates weight when EffectiveDone is truly true.
  const withWp05 = computeCoreProgress(defaultDoneReceiptsWithWp05());
  assert.equal(withWp05.status, 0, withWp05.combined);
  const withBody = parseRunnerJson(withWp05);
  assert.equal(withBody.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);

  const breakdown = withBody.breakdown || [];
  const wp05Row = breakdown.find((row) => row.taskId === TASK_ID);
  if (wp05Row) {
    assert.equal(wp05Row.EffectiveDone, false);
  }
  if (pathExists(wp05TxnReceipt)) {
    assert.equal(readJson(wp05TxnReceipt).EffectiveDone, false);
  }
});

test('WP-05 RED-01.17 cannot skip WP-INFRA EffectiveGate for WP-05', () => {
  const blocked = attemptSkipInfraGate();
  assert.notEqual(blocked.status, 0, blocked.combined);
  assert.match(blocked.combined, /EFFECTIVE_GATE_FALSE|EFFECTIVE_GATE/);
});

test('WP-05 RED-01.18 evidence / receipt structure remain fail-closed; progress stays 36%', () => {
  ensureOperationalWp05Receipt();
  assert.equal(pathExists(wp05TxnReceipt), true, FailureReason.WP05_RECEIPT_MISSING);
  const receipt = readJson(wp05TxnReceipt);
  assert.equal(receipt.EffectiveDone, false);
  assert.equal(receipt.taskId, TASK_ID);
  assert.ok(Array.isArray(receipt.phaseEvents));
  assert.ok(
    !receipt.phaseEvents.some((e) => e && e.phase === 'DONE' && e.status === 'PASS'),
  );

  // Spec pins (progress table) even when catalog entry is still missing.
  assert.equal(WP05_SPEC_ACCEPTANCE.weightPercentFromProgressTable, 8);
  assert.equal(WP05_SPEC_ACCEPTANCE.evidenceLevelFromProgressTable, 'E1');
  assert.equal(EXPECTED_PROGRESS_WHEN_DONE, 44);

  const progress = computeCoreProgress(defaultDoneReceiptsThroughWp04());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  assert.equal(readJson(wp04TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp03TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp02TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp01TxnReceipt).EffectiveDone, true);
  assert.equal(readJson(wp00MergeReceipt).EffectiveDone, true);
  assert.equal(readJson(wp05TxnReceipt).EffectiveDone, false);
});

test('WP-05 RED-01.19 GREEN surfaces never grant EffectiveDone; progress stays 36%', () => {
  // In RED, capacity probes may fail — that is the RED contract.
  // When they fail, still assert EffectiveDone stays false and progress stays 36%.
  const probes = [
    assertWp05ProductionSurfacesPresent(),
    assertWp05PathsXmlCapacity(),
    assertWp05StagerSmaliPresent(),
    assertWp05ManifestProviderCapacity(),
    assertWp05PatcherPathsWire(),
    assertWp05ImportMpkgCapacity(),
    assertWp05UnitTestsPresent(),
    loadWp05CatalogEntry(),
  ];
  for (const p of probes) {
    // Capacity helpers never inject EffectiveDone=true.
    assert.notEqual(p.EffectiveDone, true, JSON.stringify(p));
  }
  ensureOperationalWp05Receipt();
  assert.equal(readJson(wp05TxnReceipt).EffectiveDone, false);
  assert.notEqual(readJson(wp05TxnReceipt).state, 'DONE');

  const progress = computeCoreProgress(defaultDoneReceiptsWithWp05());
  assert.equal(progress.status, 0, progress.combined);
  const body = parseRunnerJson(progress);
  assert.equal(body.coreProgressPercent, EXPECTED_CURRENT_CORE_PROGRESS);
  const wp05Row = (body.breakdown || []).find((row) => row.taskId === TASK_ID);
  if (wp05Row) {
    assert.equal(wp05Row.EffectiveDone, false);
  }

  // Stable gap inventory for GREEN targeting (not self-injury).
  assert.ok(Array.isArray(listMissingProductionCreates()));
  assert.ok(Array.isArray(listMissingUnitTests()));
});

test('WP-05 RED-01.20 WP-06 must not be started', () => {
  const catalog = readJson(catalogPath);
  const wp06 = (catalog.tasks || []).filter((t) => t && t.taskId === 'WP-06');
  // Catalog may or may not list WP-06; operational EffectiveDone must not be true.
  for (const t of wp06) {
    assert.notEqual(t.EffectiveDone, true);
  }
  const wp06Txn = path.join(transactionsRoot, 'wp-06.json');
  if (pathExists(wp06Txn)) {
    assert.notEqual(readJson(wp06Txn).EffectiveDone, true);
    assert.notEqual(readJson(wp06Txn).state, 'DONE');
  }
  // WP-05 itself not DONE.
  if (pathExists(wp05TxnReceipt)) {
    assert.equal(readJson(wp05TxnReceipt).EffectiveDone, false);
  }
});
