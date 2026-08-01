'use strict';

/**
 * WP-INFRA / RED-02 contract tests for task catalog + schema fail-closed behavior.
 *
 * Against the RED stub these tests must fail because validation is missing —
 * not because of path, dependency, or environment errors.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CatalogFailureReason,
  REQUIRED_TASK_FIELDS,
  LEGAL_EVIDENCE_LEVELS,
  catalogToolPath,
  defaultSchemaPath,
  ensureCatalogToolPresent,
  makeCatalogSandbox,
  writeJson,
  minimalTask,
  minimalCatalog,
  validateCatalog,
  assertTaskReady,
  assertFailClosed,
  runCatalogTool,
} = require('./wallpaper-task-catalog-helpers');

test('WP-INFRA RED-02: catalog tool and schema stubs are invokable (framework path)', () => {
  ensureCatalogToolPresent();
  assert.equal(fs.existsSync(catalogToolPath), true);
  assert.equal(fs.existsSync(defaultSchemaPath), true);
  const result = runCatalogTool(['--help-or-unknown']);
  assert.equal(typeof result.status, 'number');
});

test('RED-02.1 rejects tasks missing required fields', () => {
  const { root } = makeCatalogSandbox();
  const incomplete = {
    taskId: 'WP-00',
    // missing dependsOn, requiredEffectiveDone, phaseCommands, expectedExit,
    // failureSignaturePolicy, scopeCheck
  };
  const catalogPath = path.join(root, 'catalog-missing-fields.json');
  writeJson(catalogPath, minimalCatalog([incomplete]));

  for (const field of REQUIRED_TASK_FIELDS) {
    if (field === 'taskId') continue;
    assert.equal(
      Object.prototype.hasOwnProperty.call(incomplete, field),
      false,
      `fixture must omit ${field}`,
    );
  }

  const result = validateCatalog(catalogPath);
  assertFailClosed(result, CatalogFailureReason.MISSING_REQUIRED_FIELD, 'missing required fields');
});

test('RED-02.2 rejects unknown WP task ids in catalog', () => {
  const { root } = makeCatalogSandbox();
  const catalogPath = path.join(root, 'catalog-unknown-id.json');
  writeJson(
    catalogPath,
    minimalCatalog([minimalTask('WP-NOT-IN-PLAN')]),
  );

  const result = validateCatalog(catalogPath);
  assertFailClosed(result, CatalogFailureReason.UNKNOWN_TASK, 'unknown WP id');
});

test('RED-02.3 rejects duplicate WP task ids', () => {
  const { root } = makeCatalogSandbox();
  const catalogPath = path.join(root, 'catalog-duplicate-id.json');
  writeJson(
    catalogPath,
    minimalCatalog([
      minimalTask('WP-00'),
      minimalTask('WP-00', { dependsOn: ['WP-INFRA'] }),
    ]),
  );

  const result = validateCatalog(catalogPath);
  assertFailClosed(result, CatalogFailureReason.DUPLICATE_TASK_ID, 'duplicate WP id');
});

test('RED-02.4 rejects illegal or missing dependencies', () => {
  const { root } = makeCatalogSandbox();

  const unknownDepPath = path.join(root, 'catalog-unknown-dep.json');
  writeJson(
    unknownDepPath,
    minimalCatalog([
      minimalTask('WP-00', {
        dependsOn: ['WP-DOES-NOT-EXIST'],
        requiredEffectiveDone: ['WP-DOES-NOT-EXIST'],
      }),
    ]),
  );
  const unknownDep = validateCatalog(unknownDepPath);
  assertFailClosed(unknownDep, CatalogFailureReason.UNKNOWN_DEPENDENCY, 'unknown dependency');

  // requiredEffectiveDone must be subset of dependsOn; orphan required edge is illegal.
  const missingDepPath = path.join(root, 'catalog-missing-dep.json');
  writeJson(
    missingDepPath,
    minimalCatalog([
      minimalTask('WP-INFRA'),
      minimalTask('WP-00', {
        dependsOn: ['WP-INFRA'],
        // requiredEffectiveDone references a dep not listed in dependsOn
        requiredEffectiveDone: ['WP-INFRA', 'WP-01'],
      }),
    ]),
  );
  const missingDep = validateCatalog(missingDepPath);
  assertFailClosed(missingDep, CatalogFailureReason.MISSING_DEPENDENCY, 'missing dependency edge');
});

test('RED-02.5 rejects dependency cycles', () => {
  const { root } = makeCatalogSandbox();
  const catalogPath = path.join(root, 'catalog-cycle.json');
  writeJson(
    catalogPath,
    minimalCatalog([
      minimalTask('WP-01', {
        dependsOn: ['WP-02'],
        requiredEffectiveDone: ['WP-02'],
      }),
      minimalTask('WP-02', {
        dependsOn: ['WP-01'],
        requiredEffectiveDone: ['WP-01'],
      }),
    ]),
  );

  const result = validateCatalog(catalogPath);
  assertFailClosed(result, CatalogFailureReason.DEPENDENCY_CYCLE, 'dependency cycle');
});

test('RED-02.6 rejects illegal state, illegal transitions, and caller-declared DONE', () => {
  const { root } = makeCatalogSandbox();

  const illegalStatePath = path.join(root, 'catalog-illegal-state.json');
  writeJson(
    illegalStatePath,
    minimalCatalog([
      minimalTask('WP-00', {
        // Catalog must not embed runtime terminal state as caller truth.
        state: 'DONE',
        EffectiveDone: true,
      }),
    ]),
  );
  const illegalState = validateCatalog(illegalStatePath);
  assertFailClosed(illegalState, CatalogFailureReason.ILLEGAL_STATE, 'illegal embedded state');

  const callerDonePath = path.join(root, 'catalog-caller-done.json');
  writeJson(
    callerDonePath,
    minimalCatalog([
      minimalTask('WP-00', {
        allowCallerDeclareDone: true,
        proposedDone: true,
      }),
    ]),
  );
  const callerDone = validateCatalog(callerDonePath);
  // Either CALLER_DECLARED_DONE or ILLEGAL_STATE is acceptable as fail-closed token
  // for this surface; contract pins CALLER_DECLARED_DONE.
  assertFailClosed(callerDone, CatalogFailureReason.CALLER_DECLARED_DONE, 'caller declare DONE');

  // Illegal phase transition policy: GREEN expectedExit non-zero is forbidden.
  const illegalTransitionPath = path.join(root, 'catalog-illegal-transition.json');
  writeJson(
    illegalTransitionPath,
    minimalCatalog([
      minimalTask('WP-00', {
        expectedExit: { RED: 1, GREEN: 1, REFACTOR: 0, VERIFY: 0 },
      }),
    ]),
  );
  const illegalTransition = validateCatalog(illegalTransitionPath);
  assertFailClosed(illegalTransition, CatalogFailureReason.ILLEGAL_STATE, 'illegal GREEN exit policy');
});

test('RED-02.7 rejects illegal Evidence Level values', () => {
  const { root } = makeCatalogSandbox();
  const catalogPath = path.join(root, 'catalog-bad-evidence.json');
  writeJson(
    catalogPath,
    minimalCatalog([
      minimalTask('WP-10A', {
        evidenceLevel: 'E9',
        deviceEvidence: true,
      }),
    ]),
  );

  assert.equal(LEGAL_EVIDENCE_LEVELS.includes('E9'), false);
  const result = validateCatalog(catalogPath);
  assertFailClosed(result, CatalogFailureReason.ILLEGAL_EVIDENCE_LEVEL, 'illegal evidence level');
});

test('RED-02.8 blocks WP-00 start when WP-INFRA EffectiveGate is false', () => {
  const { root } = makeCatalogSandbox();
  const catalogPath = path.join(root, 'catalog-wp00-gate.json');
  writeJson(
    catalogPath,
    minimalCatalog([
      minimalTask('WP-INFRA', {
        weight: 0,
        requiredEffectiveGate: true,
      }),
      minimalTask('WP-00', {
        dependsOn: ['WP-INFRA'],
        requiredEffectiveDone: ['WP-INFRA'],
      }),
    ]),
  );

  const result = assertTaskReady('WP-00', {
    infraEffectiveGate: false,
    catalogPath,
    schemaPath: defaultSchemaPath,
  });
  assertFailClosed(
    result,
    CatalogFailureReason.EFFECTIVE_GATE_REQUIRED,
    'WP-00 without WP-INFRA EffectiveGate',
  );
});

test('RED-02.9 rejects caller catalog/schema override or injection', () => {
  const { root } = makeCatalogSandbox();
  const catalogPath = path.join(root, 'catalog-base.json');
  writeJson(catalogPath, minimalCatalog([minimalTask('WP-INFRA')]));

  const injectedCatalog = path.join(root, 'injected-catalog.json');
  writeJson(injectedCatalog, minimalCatalog([minimalTask('WP-NOT-IN-PLAN')]));

  const injectedSchema = path.join(root, 'injected-schema.json');
  writeJson(injectedSchema, {
    schemaVersion: 'attacker/v0',
    type: 'object',
  });

  // CLI override of canonical schema with attacker schema must be rejected
  // when validating the repo catalog surface without explicit allow-override.
  const schemaInject = runCatalogTool([
    'validate',
    '--catalog',
    catalogPath,
    '--schema',
    injectedSchema,
    '--require-canonical-schema',
  ]);
  assertFailClosed(
    schemaInject,
    CatalogFailureReason.SCHEMA_INJECTION_REJECTED,
    'schema injection',
  );

  // Environment-injected catalog path must not silently replace canonical catalog.
  const catalogInject = runCatalogTool(
    ['validate', '--require-canonical-catalog'],
    {
      keepAmbientOverrides: true,
      env: {
        WALLPAPER_TASK_CATALOG: injectedCatalog,
        CATALOG_PATH: injectedCatalog,
      },
    },
  );
  assertFailClosed(
    catalogInject,
    CatalogFailureReason.CATALOG_INJECTION_REJECTED,
    'catalog env injection',
  );
});

test('RED-02.10 emits machine-readable failure reasons and never silently swallows errors', () => {
  const { root } = makeCatalogSandbox();
  const catalogPath = path.join(root, 'catalog-silent.json');
  writeJson(
    catalogPath,
    minimalCatalog([minimalTask('WP-TOTALLY-INVALID')]),
  );

  const result = validateCatalog(catalogPath);

  assert.notEqual(result.status, 0, 'silent success is forbidden');
  assert.ok(
    result.stdout.length + result.stderr.length > 0,
    'failure output must not be empty',
  );
  assert.match(
    result.combined,
    /"failureReason"\s*:\s*"[A-Z0-9_]+"|failureReason\s*[=:]\s*[A-Z0-9_]+|UNKNOWN_TASK|MISSING_REQUIRED_FIELD|BLOCKED_[A-Z0-9_]+/,
    `expected machine-readable failure, got:\n${result.combined}`,
  );
});
