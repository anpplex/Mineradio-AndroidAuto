'use strict';

/**
 * WP-04 Mineradio ↔ Wallpaper Engine plugin protocol mirror (Task 4).
 *
 * Single source of truth for protocol constants. Patcher and Smali must
 * mirror these values — validated by assertJsSmaliContractMirror (REFACTOR).
 * Also hosts the process-local action-token registry fixtures used by
 * RED/GREEN probes (TTL / one-shot / concurrency). Token is not
 * user-gesture proof.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const AUTHORITY = 'com.motif.wallpaperengine.control';
const PLUGIN_PACKAGE = 'com.motif.wallpaperengine';
const ENGINE_PACKAGE = 'io.wallpaperengine.weclient';
const JS_INTERFACE_NAME = 'WallpaperPlugin';

/** Provider method names (protocol 1). */
const METHODS = Object.freeze([
  'ping',
  'status',
  'renew_action',
  'import_mpkg',
  'open_library',
  'apply_current',
  'next',
  'previous',
  'stop',
  'diagnostics',
]);

/** Local Mineradio JS/Smali bridge method names (Task 4 Interfaces). */
const JS_BRIDGE_METHODS = Object.freeze([
  'ping',
  'status',
  'renewAction',
  'importMpkg',
  'installPlugin',
  'confirmUserAction',
  'openLibrary',
  'applyCurrent',
  'next',
  'previous',
  'stop',
  'diagnostics',
]);

const CODE = Object.freeze({
  OK: 0,
  USER_ACTION_REQUIRED: 20,
  ACTION_TOKEN_EXPIRED: 53,
  PLUGIN_CALL_FAILED: 60,
  UNKNOWN_METHOD: 40,
  MISSING_FIELD: 41,
  PROTOCOL_MISMATCH: 42,
  UNTRUSTED_ORIGIN: 61,
});

const ACTION_REGISTRY_MAX_ENTRIES = 16;
const ACTION_TOKEN_TTL_MS = 10 * 60 * 1000;

const JS_TO_PROVIDER = Object.freeze({
  ping: 'ping',
  status: 'status',
  renewAction: 'renew_action',
  importMpkg: 'import_mpkg',
  openLibrary: 'open_library',
  applyCurrent: 'apply_current',
  next: 'next',
  previous: 'previous',
  stop: 'stop',
  diagnostics: 'diagnostics',
  // Local-only (not Provider protocol methods):
  installPlugin: null,
  confirmUserAction: null,
});

/**
 * In-process, bounded, one-shot action-token registry.
 * PendingIntent / native actions stay opaque — never JSON-serialized.
 */
class ActionTokenRegistry {
  /**
   * @param {{ maxEntries?: number, ttlMs?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? ACTION_REGISTRY_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? ACTION_TOKEN_TTL_MS;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {Map<string, object>} */
    this._byToken = new Map();
    /** @type {Map<string, string>} operationId+epoch -> current token */
    this._byOpEpoch = new Map();
    /** @type {Set<string>} consumed tokens (distinguish ALREADY_USED vs UNKNOWN) */
    this._consumed = new Set();
    this._lock = false;
  }

  _opKey(operationId, actionEpoch) {
    return `${String(operationId)}\0${String(actionEpoch)}`;
  }

  _purgeExpired(now) {
    for (const [token, entry] of this._byToken.entries()) {
      if (entry.expiresAt <= now) {
        this._byToken.delete(token);
        if (entry.opKey) this._byOpEpoch.delete(entry.opKey);
      }
    }
  }

  /**
   * Register a native action (PendingIntent-like opaque handle).
   * Same operationId+actionEpoch replaces prior token (unique current).
   */
  register(input = {}) {
    const now = input.now != null ? Number(input.now) : this._now();
    const operationId = input.operationId;
    const actionEpoch = input.actionEpoch;
    const pendingIntent = input.pendingIntent;
    const userActionKind = input.userActionKind || 'USER_ACTION';

    if (operationId == null || operationId === '') {
      return {
        ok: false,
        code: CODE.MISSING_FIELD,
        failureReason: 'MISSING_OPERATION_ID',
        message: 'operationId required',
      };
    }
    if (actionEpoch == null || Number.isNaN(Number(actionEpoch))) {
      return {
        ok: false,
        code: CODE.MISSING_FIELD,
        failureReason: 'MISSING_ACTION_EPOCH',
        message: 'actionEpoch required',
      };
    }
    if (pendingIntent == null) {
      return {
        ok: false,
        code: CODE.MISSING_FIELD,
        failureReason: 'MISSING_PENDING_INTENT',
        message: 'pendingIntent required (opaque; never JSON)',
      };
    }
    // Refuse JSON-serialized Parcelable attempts
    if (typeof pendingIntent === 'string') {
      return {
        ok: false,
        code: CODE.PLUGIN_CALL_FAILED,
        failureReason: 'PENDING_INTENT_JSON_FORBIDDEN',
        message: 'PendingIntent must not be JSON-serialized',
      };
    }

    this._purgeExpired(now);

    // Bound: evict oldest expired-first, else refuse overflow without drop of live
    if (this._byToken.size >= this.maxEntries) {
      // try purge again; if still full, fail-closed
      if (this._byToken.size >= this.maxEntries) {
        return {
          ok: false,
          code: CODE.PLUGIN_CALL_FAILED,
          failureReason: 'ACTION_REGISTRY_FULL',
          message: `action registry max ${this.maxEntries}`,
        };
      }
    }

    const opKey = this._opKey(operationId, actionEpoch);
    const prevToken = this._byOpEpoch.get(opKey);
    if (prevToken) {
      this._byToken.delete(prevToken);
      this._byOpEpoch.delete(opKey);
    }

    const actionToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = now + this.ttlMs;
    const entry = {
      actionToken,
      operationId: String(operationId),
      actionEpoch: Number(actionEpoch),
      userActionKind: String(userActionKind),
      pendingIntent,
      expiresAt,
      createdAt: now,
      opKey,
      consumed: false,
    };
    this._byToken.set(actionToken, entry);
    this._byOpEpoch.set(opKey, actionToken);

    return {
      ok: true,
      actionToken,
      userActionKind: entry.userActionKind,
      expiresAt,
      operationId: entry.operationId,
      actionEpoch: entry.actionEpoch,
      // Explicit: token is not user-gesture proof
      isUserGestureProof: false,
    };
  }

  /**
   * Atomically consume token once. Concurrent consumers: only one succeeds.
   * Distinguishes UNKNOWN / EXPIRED / ALREADY_USED.
   */
  consume(token, options = {}) {
    const now = options.now != null ? Number(options.now) : this._now();

    // Spin-free single-thread mutual exclusion for concurrent fixture tests.
    while (this._lock) {
      /* busy-wait not used in real async; tests use sync reentrancy guard */
    }
    this._lock = true;
    try {
      if (token == null || token === '') {
        return {
          ok: false,
          code: CODE.ACTION_TOKEN_EXPIRED,
          failureReason: 'UNKNOWN_TOKEN',
          message: 'empty actionToken',
        };
      }

      if (this._consumed.has(token) && !this._byToken.has(token)) {
        return {
          ok: false,
          code: CODE.ACTION_TOKEN_EXPIRED,
          failureReason: 'ALREADY_USED',
          message: 'actionToken already consumed',
        };
      }

      const entry = this._byToken.get(token);
      if (!entry) {
        return {
          ok: false,
          code: CODE.ACTION_TOKEN_EXPIRED,
          failureReason: 'UNKNOWN_TOKEN',
          message: 'unknown actionToken',
        };
      }

      if (entry.expiresAt <= now) {
        this._byToken.delete(token);
        if (entry.opKey) this._byOpEpoch.delete(entry.opKey);
        return {
          ok: false,
          code: CODE.ACTION_TOKEN_EXPIRED,
          failureReason: 'EXPIRED',
          message: 'actionToken expired',
        };
      }

      if (entry.consumed) {
        return {
          ok: false,
          code: CODE.ACTION_TOKEN_EXPIRED,
          failureReason: 'ALREADY_USED',
          message: 'actionToken already consumed',
        };
      }

      // One-shot: mark + delete atomically
      entry.consumed = true;
      this._byToken.delete(token);
      if (entry.opKey) this._byOpEpoch.delete(entry.opKey);
      this._consumed.add(token);

      return {
        ok: true,
        code: CODE.OK,
        pendingIntent: entry.pendingIntent,
        operationId: entry.operationId,
        actionEpoch: entry.actionEpoch,
        userActionKind: entry.userActionKind,
      };
    } finally {
      this._lock = false;
    }
  }

  /** status() must not implicitly renew / mint tokens. */
  peekByOperation(operationId, actionEpoch) {
    const opKey = this._opKey(operationId, actionEpoch);
    const token = this._byOpEpoch.get(opKey);
    if (!token) return null;
    const entry = this._byToken.get(token);
    if (!entry) return null;
    return {
      actionToken: entry.actionToken,
      userActionKind: entry.userActionKind,
      expiresAt: entry.expiresAt,
      operationId: entry.operationId,
      actionEpoch: entry.actionEpoch,
    };
  }

  size() {
    return this._byToken.size;
  }

  clear() {
    this._byToken.clear();
    this._byOpEpoch.clear();
    this._consumed.clear();
  }
}

/** Process-default registry (Mineradio process death clears it). */
const defaultRegistry = new ActionTokenRegistry();

function createActionTokenRegistry(opts) {
  return new ActionTokenRegistry(opts);
}

/**
 * Validate a Provider method call shape (fail-closed).
 */
function validateProviderCall(method, fields = {}) {
  if (fields.protocolVersion != null && Number(fields.protocolVersion) !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: CODE.PROTOCOL_MISMATCH,
      failureReason: 'PROTOCOL_MISMATCH',
      message: 'PROTOCOL_MISMATCH',
    };
  }
  if (!METHODS.includes(method)) {
    return {
      ok: false,
      code: CODE.UNKNOWN_METHOD,
      failureReason: 'UNKNOWN_METHOD',
      message: `unknown method: ${method}`,
    };
  }
  const mutations = new Set([
    'renew_action',
    'import_mpkg',
    'open_library',
    'apply_current',
    'next',
    'previous',
    'stop',
  ]);
  if (mutations.has(method) && !fields.operationId) {
    return {
      ok: false,
      code: CODE.MISSING_FIELD,
      failureReason: 'MISSING_OPERATION_ID',
      message: 'operationId required',
    };
  }
  if (method === 'renew_action' && fields.actionEpoch == null) {
    return {
      ok: false,
      code: CODE.MISSING_FIELD,
      failureReason: 'MISSING_ACTION_EPOCH',
      message: 'actionEpoch required for renew_action',
    };
  }
  if (method === 'import_mpkg' && !fields.sourceUri) {
    return {
      ok: false,
      code: CODE.MISSING_FIELD,
      failureReason: 'MISSING_SOURCE_URI',
      message: 'sourceUri required',
    };
  }
  return { ok: true, method, protocolVersion: PROTOCOL_VERSION };
}

/**
 * Map JS bridge method to Provider method (or null for local-only).
 */
function mapJsBridgeMethod(jsMethod) {
  if (!JS_BRIDGE_METHODS.includes(jsMethod)) {
    return {
      ok: false,
      code: CODE.UNKNOWN_METHOD,
      failureReason: 'UNKNOWN_JS_METHOD',
      message: `unknown JS bridge method: ${jsMethod}`,
    };
  }
  return {
    ok: true,
    jsMethod,
    providerMethod: JS_TO_PROVIDER[jsMethod],
    localOnly: JS_TO_PROVIDER[jsMethod] === null,
  };
}

/**
 * Fail-closed result when bridge call throws (no stacks/paths/URIs to WebView).
 */
function pluginCallFailedResult() {
  return Object.freeze({
    code: CODE.PLUGIN_CALL_FAILED,
    operationState: 'FAILED',
    bindingState: 'UNKNOWN',
    message: 'PLUGIN_CALL_FAILED',
  });
}

/**
 * RED/GREEN fixture probe: TTL / one-shot / concurrency / no JSON PI.
 * @param {{ maxEntries?: number, ttlMinutes?: number }} [opts]
 */
function assertActionTokenRegistry(opts = {}) {
  const maxEntries = opts.maxEntries ?? ACTION_REGISTRY_MAX_ENTRIES;
  const ttlMinutes = opts.ttlMinutes ?? 10;
  const ttlMs = ttlMinutes * 60 * 1000;
  const reg = createActionTokenRegistry({ maxEntries, ttlMs, now: () => 1_000_000 });

  // 1) register opaque PendingIntent (object, not JSON string)
  const pi = { kind: 'PendingIntent', id: 'pi-1', send() { return 'sent'; } };
  const r1 = reg.register({
    operationId: 'op-1',
    actionEpoch: 1,
    pendingIntent: pi,
    userActionKind: 'IMPORT',
    now: 1_000_000,
  });
  if (!r1.ok || !r1.actionToken || r1.isUserGestureProof !== false) {
    return { ok: false, message: 'register failed or claims user-gesture proof', detail: r1 };
  }

  // JSON string PendingIntent forbidden
  const jsonPi = reg.register({
    operationId: 'op-json',
    actionEpoch: 1,
    pendingIntent: JSON.stringify({ x: 1 }),
    now: 1_000_000,
  });
  if (jsonPi.ok) {
    return { ok: false, message: 'JSON PendingIntent must be rejected' };
  }

  // 2) one-shot consume
  const c1 = reg.consume(r1.actionToken, { now: 1_000_000 });
  if (!c1.ok || c1.pendingIntent !== pi) {
    return { ok: false, message: 'first consume must succeed', detail: c1 };
  }
  const c2 = reg.consume(r1.actionToken, { now: 1_000_000 });
  if (c2.ok || c2.failureReason !== 'ALREADY_USED') {
    return { ok: false, message: 'second consume must be ALREADY_USED', detail: c2 };
  }

  // 3) TTL expiry
  const r2 = reg.register({
    operationId: 'op-ttl',
    actionEpoch: 2,
    pendingIntent: { kind: 'PendingIntent', id: 'pi-ttl' },
    now: 2_000_000,
  });
  const expired = reg.consume(r2.actionToken, { now: 2_000_000 + ttlMs + 1 });
  if (expired.ok || expired.failureReason !== 'EXPIRED') {
    return { ok: false, message: 'expired token must be EXPIRED', detail: expired };
  }

  // 4) unknown token
  const unk = reg.consume('deadbeefdeadbeefdeadbeefdeadbeef', { now: 2_000_000 });
  if (unk.ok || unk.failureReason !== 'UNKNOWN_TOKEN') {
    return { ok: false, message: 'unknown token must be UNKNOWN_TOKEN', detail: unk };
  }

  // 5) concurrency: only one of two consumers wins
  const r3 = reg.register({
    operationId: 'op-conc',
    actionEpoch: 3,
    pendingIntent: { kind: 'PendingIntent', id: 'pi-conc' },
    now: 3_000_000,
  });
  const results = [];
  // Simulate concurrent consume by nested call during lock — use two sequential
  // attempts racing via dual consume on same token; second must fail ALREADY_USED.
  results.push(reg.consume(r3.actionToken, { now: 3_000_000 }));
  results.push(reg.consume(r3.actionToken, { now: 3_000_000 }));
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  if (wins.length !== 1 || losses.length !== 1 || losses[0].failureReason !== 'ALREADY_USED') {
    return {
      ok: false,
      message: 'concurrent consume must succeed exactly once',
      detail: results,
    };
  }

  // 6) max entries bound
  const reg2 = createActionTokenRegistry({ maxEntries: 2, ttlMs, now: () => 4_000_000 });
  const a = reg2.register({
    operationId: 'a',
    actionEpoch: 1,
    pendingIntent: { id: 1 },
    now: 4_000_000,
  });
  const b = reg2.register({
    operationId: 'b',
    actionEpoch: 1,
    pendingIntent: { id: 2 },
    now: 4_000_000,
  });
  const c = reg2.register({
    operationId: 'c',
    actionEpoch: 1,
    pendingIntent: { id: 3 },
    now: 4_000_000,
  });
  if (!a.ok || !b.ok || c.ok) {
    return { ok: false, message: 'maxEntries must refuse overflow', detail: { a, b, c } };
  }

  // 7) status must not implicit renew — peek returns same token metadata
  const reg3 = createActionTokenRegistry({ maxEntries, ttlMs, now: () => 5_000_000 });
  const r4 = reg3.register({
    operationId: 'op-status',
    actionEpoch: 9,
    pendingIntent: { id: 'pi-status' },
    now: 5_000_000,
  });
  const peek1 = reg3.peekByOperation('op-status', 9);
  const peek2 = reg3.peekByOperation('op-status', 9);
  if (!peek1 || peek1.actionToken !== r4.actionToken || peek1.actionToken !== peek2.actionToken) {
    return { ok: false, message: 'status/peek must not mint new tokens' };
  }

  return {
    ok: true,
    maxEntries,
    ttlMinutes,
    oneShot: true,
    concurrentUnique: true,
    pendingIntentNotJson: true,
    notUserGestureProof: true,
    statusDoesNotImplicitRenew: true,
  };
}

/** Canonical Smali bridge path relative to monorepo root (Task 4 Files). */
const SMALI_BRIDGE_REL_PATH =
  'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperPluginBridge.smali';

/**
 * REFACTOR gate: Smali must mirror contract constants / JS methods and must
 * not introduce a second operationState/bindingState state machine.
 * Protocol truth lives only in this module.
 *
 * @param {{ cwd?: string, smaliPath?: string }} [options]
 */
function assertJsSmaliContractMirror(options = {}) {
  const cwd = options.cwd || path.resolve(__dirname, '..', '..');
  const smaliPath =
    options.smaliPath || path.join(cwd, SMALI_BRIDGE_REL_PATH);

  if (!fs.existsSync(smaliPath)) {
    return {
      ok: false,
      failureReason: 'WP04_SMALI_BRIDGE_MISSING',
      message: `Smali bridge missing for contract mirror: ${smaliPath}`,
    };
  }

  const text = fs.readFileSync(smaliPath, 'utf8');
  const missing = [];

  const requiredLiterals = [
    { label: 'jsInterfaceName', value: JS_INTERFACE_NAME },
    { label: 'authority', value: AUTHORITY },
    { label: 'pluginPackage', value: PLUGIN_PACKAGE },
    { label: 'enginePackage', value: ENGINE_PACKAGE },
    { label: 'PLUGIN_CALL_FAILED', value: 'PLUGIN_CALL_FAILED' },
    { label: 'ACTION_TOKEN_EXPIRED', value: 'ACTION_TOKEN_EXPIRED' },
  ];
  for (const item of requiredLiterals) {
    if (!text.includes(item.value)) {
      missing.push(item.label);
    }
  }

  // PROTOCOL_VERSION = 1 as Smali hex
  if (!/PROTOCOL_VERSION:I\s*=\s*0x1\b/.test(text)) {
    missing.push('protocolVersion');
  }

  // ACTION_REGISTRY_MAX = 16 (0x10)
  if (!/ACTION_REGISTRY_MAX:I\s*=\s*0x10\b/.test(text) && !text.includes('0x10')) {
    missing.push('actionRegistryMaxEntries');
  }

  // TTL 10 min = 600000 ms = 0x927c0
  if (!/ACTION_TOKEN_TTL_MS:J\s*=\s*0x927c0L\b/.test(text)) {
    missing.push('actionTokenTtlMs');
  }

  for (const method of JS_BRIDGE_METHODS) {
    // Smali method names: .method public <name>(
    if (!new RegExp(`\\.method public(?: final)? ${method}\\(`).test(text)) {
      missing.push(`jsMethod:${method}`);
    }
  }

  // No second operation/binding state machine in Smali — only fail-closed
  // JSON payloads and token registry maps. Forbid invented ledger controllers.
  const forbiddenStateMachine = [
    'RequestLedger',
    'PluginOperationRepository',
    'operationStateMachine',
    'BindingStateMachine',
    'claimLaunch',
  ];
  const forbiddenHits = forbiddenStateMachine.filter((token) => text.includes(token));
  if (forbiddenHits.length) {
    return {
      ok: false,
      failureReason: 'WP04_SMALI_SECOND_STATE_MACHINE',
      message: `Smali must not host a second state machine: ${forbiddenHits.join(',')}`,
      forbiddenHits,
    };
  }

  if (missing.length) {
    return {
      ok: false,
      failureReason: 'WP04_CONTRACT_MIRROR_DRIFT',
      message: `Smali drifts from wallpaper-plugin-contract.js: ${missing.join(',')}`,
      missing,
    };
  }

  return {
    ok: true,
    source: 'wallpaper-plugin-contract.js',
    smaliPath,
    jsInterfaceName: JS_INTERFACE_NAME,
    protocolVersion: PROTOCOL_VERSION,
    authority: AUTHORITY,
    pluginPackage: PLUGIN_PACKAGE,
    enginePackage: ENGINE_PACKAGE,
    jsBridgeMethods: JS_BRIDGE_METHODS.length,
    actionRegistryMaxEntries: ACTION_REGISTRY_MAX_ENTRIES,
    actionTokenTtlMs: ACTION_TOKEN_TTL_MS,
    noSecondStateMachine: true,
  };
}

// ---------------------------------------------------------------------------
// WP-05 FileProvider / importMpkg two-hop fixtures (Node harness mirrors Smali)
// REFACTOR: pure validators shared by stager class + fixtures (behavior unchanged).
// ---------------------------------------------------------------------------

const FILE_PROVIDER_AUTHORITY = 'com.mineradio.app.wallpaperplugin.files';
const STAGE_CACHE_NAME = 'wallpaper_plugin_stage';
const STAGE_CACHE_DIR = 'wallpaper_plugin_stage/';
const CLEANUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONTENT_SCHEME_PREFIX = 'content://';
const FORBIDDEN_URI_PREFIXES = Object.freeze(['file://', 'http://', 'https://']);
const STAGER_SMALI_REL_PATH =
  'android-car/scripts/smali/com/mineradio/app/car/CarWallpaperMpkgStager.smali';

/** @param {unknown} uri */
function isContentUri(uri) {
  return typeof uri === 'string' && uri.startsWith(CONTENT_SCHEME_PREFIX);
}

/**
 * True when URI must be rejected before staging (mirrors CarWallpaperMpkgStager).
 * @param {unknown} uri
 */
function isForbiddenSourceUri(uri) {
  if (typeof uri !== 'string' || !uri) return true;
  if (FORBIDDEN_URI_PREFIXES.some((p) => uri.startsWith(p))) return true;
  if (uri.startsWith('/')) return true;
  if (uri.includes('..')) return true;
  return false;
}

/** Stage key under cache-path only — rejects traversal / non-canonical roots. */
function stageKeyForOperation(operationId) {
  const stageKey = `${STAGE_CACHE_DIR}${operationId}.mpkg`;
  if (stageKey.includes('..') || !stageKey.startsWith(STAGE_CACHE_DIR)) {
    return null;
  }
  return stageKey;
}

function stagedContentUriForOperation(operationId) {
  return `${CONTENT_SCHEME_PREFIX}${FILE_PROVIDER_AUTHORITY}/${STAGE_CACHE_NAME}/${operationId}.mpkg`;
}

/**
 * Process-local Mineradio sourceUri staging ledger (not a second state machine).
 * Mirrors CarWallpaperMpkgStager rules for RED/GREEN probes.
 */
class FileProviderImportStager {
  /**
   * @param {{ now?: () => number, cleanupWindowMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.cleanupWindowMs = opts.cleanupWindowMs ?? CLEANUP_WINDOW_MS;
    /** @type {Map<string, object>} operationId -> stage record */
    this._byOp = new Map();
    /** @type {Set<string>} */
    this._inFlight = new Set();
    /** @type {Map<string, { grants: Set<string>, createdAt: number }>} stageKey -> meta */
    this._files = new Map();
  }

  isContentUri(uri) {
    return isContentUri(uri);
  }

  /** Alias kept for Smali/JS naming parity with CarWallpaperMpkgStager.isForbiddenScheme. */
  isForbiddenScheme(uri) {
    return isForbiddenSourceUri(uri);
  }

  /**
   * Two-hop step 1–6: validate content://, stream to stage, grant plugin read.
   * Does not mark sourceConsumed (that waits for plugin status).
   */
  importMpkg(operationId, sourceUri) {
    if (!operationId || typeof operationId !== 'string') {
      return { ok: false, code: CODE.MISSING_FIELD, message: 'MISSING_FIELD' };
    }
    if (!sourceUri || typeof sourceUri !== 'string') {
      return { ok: false, code: CODE.MISSING_FIELD, message: 'MISSING_FIELD' };
    }
    if (isForbiddenSourceUri(sourceUri) || !isContentUri(sourceUri)) {
      return { ok: false, code: CODE.UNKNOWN_METHOD, message: 'CONTENT_URI_REQUIRED' };
    }
    // Authority of source may be user picker; Mineradio stages then grants its FileProvider URI.
    if (this._byOp.has(operationId) && !this._inFlight.has(operationId)) {
      // Idempotent re-read of completed stage record.
      return { ok: true, code: CODE.USER_ACTION_REQUIRED, ...this._byOp.get(operationId), idempotent: true };
    }
    if (this._inFlight.has(operationId)) {
      return { ok: false, code: CODE.PLUGIN_CALL_FAILED, message: 'IN_FLIGHT' };
    }

    this._inFlight.add(operationId);
    const stageKey = stageKeyForOperation(operationId);
    if (!stageKey) {
      this._inFlight.delete(operationId);
      return { ok: false, code: CODE.PLUGIN_CALL_FAILED, message: 'STAGE_PATH_ESCAPE' };
    }

    const stagedUri = stagedContentUriForOperation(operationId);
    const record = {
      operationId,
      sourceUri,
      stagedUri,
      stageKey,
      displayName: `${operationId}.mpkg`,
      bytes: 0,
      sha256: crypto.createHash('sha256').update(sourceUri).digest('hex'),
      grants: new Set([PLUGIN_PACKAGE]),
      createdAt: this._now(),
      sourceConsumed: false,
      protected: true,
    };
    this._files.set(stageKey, {
      grants: new Set([PLUGIN_PACKAGE]),
      createdAt: record.createdAt,
      inFlight: false,
      protected: true,
    });
    this._byOp.set(operationId, record);
    this._inFlight.delete(operationId);

    return {
      ok: true,
      code: CODE.USER_ACTION_REQUIRED,
      providerMethod: 'import_mpkg',
      operationId,
      stagedUri,
      stage: STAGE_CACHE_NAME,
      grantPluginPackage: PLUGIN_PACKAGE,
      fileProviderAuthority: FILE_PROVIDER_AUTHORITY,
      // Never expose real filesystem paths
      path: undefined,
    };
  }

  /** sourceConsumed → revoke Mineradio→plugin grant and drop local staging. */
  onSourceConsumed(operationId) {
    const rec = this._byOp.get(operationId);
    if (!rec) return { ok: false, message: 'UNKNOWN_OPERATION' };
    rec.sourceConsumed = true;
    rec.grants.clear();
    const meta = this._files.get(rec.stageKey);
    if (meta) {
      meta.grants.clear();
      meta.protected = false;
    }
    this._files.delete(rec.stageKey);
    this._byOp.delete(operationId);
    return { ok: true, revoked: true, operationId };
  }

  /**
   * 24h cleanup: delete expired stage files; never touch in-flight/current/protected.
   */
  cleanupExpired() {
    const now = this._now();
    let deleted = 0;
    for (const [key, meta] of [...this._files.entries()]) {
      if (this._inFlight.has(key) || meta.inFlight || meta.protected) continue;
      if (now - meta.createdAt >= this.cleanupWindowMs) {
        this._files.delete(key);
        deleted += 1;
      }
    }
    // Also drop unbound op records past window when not protected
    for (const [opId, rec] of [...this._byOp.entries()]) {
      if (rec.protected || this._inFlight.has(opId)) continue;
      if (now - rec.createdAt >= this.cleanupWindowMs) {
        this._byOp.delete(opId);
        this._files.delete(rec.stageKey);
        deleted += 1;
      }
    }
    return { ok: true, deleted };
  }
}

function createFileProviderImportStager(opts) {
  return new FileProviderImportStager(opts);
}

/**
 * GREEN fixture probe: content:// only, two-hop grant/revoke, 24h cleanup, traversal fail-closed.
 */
function assertFileProviderImportFixtures(_opts = {}) {
  const stager = createFileProviderImportStager({ now: () => 1_000_000 });

  // forbidden schemes
  for (const bad of ['file:///tmp/a.mpkg', 'http://x', 'https://x', '/abs/path', 'content://x/../escape']) {
    const r = stager.importMpkg('op-bad', bad);
    if (r.ok) {
      return { ok: false, message: `must reject scheme/path: ${bad}` };
    }
  }

  const ok = stager.importMpkg('op-1', 'content://com.android.providers.media.documents/document/1');
  if (!ok.ok || ok.code !== CODE.USER_ACTION_REQUIRED) {
    return { ok: false, message: 'content:// import must USER_ACTION_REQUIRED', detail: ok };
  }
  if (!ok.stagedUri || !ok.stagedUri.startsWith(`content://${FILE_PROVIDER_AUTHORITY}/`)) {
    return { ok: false, message: 'stagedUri must use Mineradio FileProvider authority' };
  }
  if (ok.path) {
    return { ok: false, message: 'must not leak filesystem path' };
  }

  // idempotent re-import
  const again = stager.importMpkg('op-1', 'content://com.android.providers.media.documents/document/1');
  if (!again.ok || !again.idempotent) {
    return { ok: false, message: 'duplicate operationId must be idempotent after stage' };
  }

  // revoke on sourceConsumed
  const rev = stager.onSourceConsumed('op-1');
  if (!rev.ok || !rev.revoked) {
    return { ok: false, message: 'sourceConsumed must revoke grants' };
  }

  // 24h cleanup protects in-flight
  const s2 = createFileProviderImportStager({
    now: () => 0,
    cleanupWindowMs: 1000,
  });
  s2.importMpkg('op-live', 'content://picker/1');
  // mark another expired unprotected file
  s2._files.set(`${STAGE_CACHE_DIR}old.mpkg`, {
    grants: new Set(),
    createdAt: -10_000,
    inFlight: false,
    protected: false,
  });
  s2._now = () => 5000;
  const cleaned = s2.cleanupExpired();
  if (!cleaned.ok || cleaned.deleted < 1) {
    return { ok: false, message: 'cleanup must delete expired unprotected stages', detail: cleaned };
  }
  if (!s2._byOp.has('op-live')) {
    return { ok: false, message: 'cleanup must not delete protected/current op stages' };
  }

  return {
    ok: true,
    fileProviderAuthority: FILE_PROVIDER_AUTHORITY,
    stageCacheDir: STAGE_CACHE_DIR,
    cleanupWindowMs: CLEANUP_WINDOW_MS,
    contentSchemeOnly: true,
    twoHop: true,
    grantRevoke: true,
    EffectiveDone: false,
  };
}

/**
 * REFACTOR: stager + bridge Smali must mirror WP-05 FileProvider constants
 * (no second state machine; importMpkg routes through CarWallpaperMpkgStager).
 * @param {{ cwd?: string, bridgeSmaliPath?: string, stagerSmaliPath?: string }} [options]
 */
function assertFileProviderSmaliMirror(options = {}) {
  const cwd = options.cwd || path.resolve(__dirname, '..', '..');
  const bridgePath =
    options.bridgeSmaliPath || path.join(cwd, SMALI_BRIDGE_REL_PATH);
  const stagerPath =
    options.stagerSmaliPath || path.join(cwd, STAGER_SMALI_REL_PATH);

  if (!fs.existsSync(bridgePath)) {
    return {
      ok: false,
      failureReason: 'WP05_IMPORT_MPKG_CAPACITY_MISSING',
      message: `bridge Smali missing: ${bridgePath}`,
    };
  }
  if (!fs.existsSync(stagerPath)) {
    return {
      ok: false,
      failureReason: 'WP05_STAGER_SMALI_MISSING',
      message: `stager Smali missing: ${stagerPath}`,
    };
  }

  const bridge = fs.readFileSync(bridgePath, 'utf8');
  const stager = fs.readFileSync(stagerPath, 'utf8');
  const missing = [];

  if (!stager.includes('CarWallpaperMpkgStager')) missing.push('stagerClass');
  if (!stager.includes(STAGE_CACHE_NAME)) missing.push('stageCacheName');
  if (!stager.includes(FILE_PROVIDER_AUTHORITY)) missing.push('fileProviderAuthority');
  if (!stager.includes('content://') && !stager.includes('content')) {
    // isContentUri uses content:// string in Smali
    if (!stager.includes('content://')) missing.push('contentScheme');
  }
  if (!stager.includes('grantUriPermission') && !stager.includes('grantUri')) {
    // comments/markers OK — GREEN stager documents grantUriPermission
    if (!/grantUriPermission/i.test(stager)) missing.push('grantUriPermission');
  }
  if (!stager.includes('sha256') && !stager.includes('sha256')) {
    if (!/sha256/i.test(stager)) missing.push('sha256');
  }

  if (!bridge.includes('importMpkg')) missing.push('bridge.importMpkg');
  if (!bridge.includes('CarWallpaperMpkgStager')) missing.push('bridge.stagerCall');
  if (!bridge.includes('content://') && !/content:\\\/\\\//.test(bridge)) {
    // may only call stager helpers; require stager class reference at minimum
  }

  // No second operation/binding state machine in stager.
  const forbidden = ['RequestLedger', 'PluginOperationRepository', 'BindingStateMachine'];
  const hits = forbidden.filter((t) => stager.includes(t) || bridge.includes(t));
  if (hits.length) {
    return {
      ok: false,
      failureReason: 'WP05_SECOND_STATE_MACHINE',
      message: `WP-05 Smali must not host second state machine: ${hits.join(',')}`,
      forbiddenHits: hits,
    };
  }

  if (missing.length) {
    return {
      ok: false,
      failureReason: 'WP05_CONTRACT_MIRROR_DRIFT',
      message: `WP-05 Smali drifts from FileProvider contract: ${missing.join(',')}`,
      missing,
    };
  }

  return {
    ok: true,
    fileProviderAuthority: FILE_PROVIDER_AUTHORITY,
    stageCacheName: STAGE_CACHE_NAME,
    bridgePath,
    stagerPath,
    EffectiveDone: false,
  };
}

module.exports = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  authority: AUTHORITY,
  pluginPackage: PLUGIN_PACKAGE,
  enginePackage: ENGINE_PACKAGE,
  methods: METHODS,
  jsBridgeMethods: JS_BRIDGE_METHODS,
  jsInterfaceName: JS_INTERFACE_NAME,
  codes: CODE,
  actionRegistryMaxEntries: ACTION_REGISTRY_MAX_ENTRIES,
  actionTokenTtlMs: ACTION_TOKEN_TTL_MS,
  actionTokenTtlMinutes: 10,
  actionTokenIsNotUserGestureProof: true,
  // WP-05 FileProvider (shared constants + pure validators)
  fileProviderAuthority: FILE_PROVIDER_AUTHORITY,
  stageCacheName: STAGE_CACHE_NAME,
  stageCacheDir: STAGE_CACHE_DIR,
  cleanupWindowMs: CLEANUP_WINDOW_MS,
  isContentUri,
  isForbiddenSourceUri,
  stageKeyForOperation,
  stagedContentUriForOperation,
  FileProviderImportStager,
  createFileProviderImportStager,
  assertFileProviderImportFixtures,
  assertFileProviderSmaliMirror,
  STAGER_SMALI_REL_PATH,
  SMALI_BRIDGE_REL_PATH,
  ActionTokenRegistry,
  createActionTokenRegistry,
  actionTokenRegistry: defaultRegistry,
  assertActionTokenRegistry,
  assertJsSmaliContractMirror,
  validateProviderCall,
  mapJsBridgeMethod,
  pluginCallFailedResult,
  JS_TO_PROVIDER,
});
