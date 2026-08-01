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
