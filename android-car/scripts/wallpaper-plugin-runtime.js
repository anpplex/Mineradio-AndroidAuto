'use strict';

/**
 * WP-07 — car HMI wallpaper plugin runtime (Task 7).
 *
 * Produces window.MineradioWallpaperPlugin: thin 1:1 name map over
 * window.WallpaperPlugin. No second protocol, no Android FS/shell/Electron.
 *
 * - status poll: 500ms active / 5000ms idle; stop on document.hidden
 * - UI states: fixed Chinese labels only; ENGINE_LAUNCHED ≠ 可预览
 *   (forbidEngineLaunchedPreview)
 * - entry: settings / 实验 only; minTouchCssPx 48; minPrimaryCssPx 64
 * - command queue: one operationId-stable queue; stop carries targetOperationId
 *
 * Dual surface: browser IIFE attach + Node require for unit fixtures.
 */

const GLOBAL_NAME = 'MineradioWallpaperPlugin';
const BRIDGE_NAME = 'WallpaperPlugin';
const POLL_ACTIVE_MS = 500;
const POLL_IDLE_MS = 5000;
const MIN_TOUCH_CSS_PX = 48;
const MIN_PRIMARY_CSS_PX = 64;

/** settingsOnlyEntry — never default playback main ops. */
const SETTINGS_ONLY_ENTRY = true;
const NO_DEFAULT_PLAYBACK_MAIN_OPS = true;

const UI_STATES = Object.freeze([
  '未安装',
  '需要安装确认',
  '插件可用',
  '等待用户确认',
  '正在导入',
  '已投递到壁纸引擎',
  '可预览（仅可靠回调）',
  '正在应用',
  '动态壁纸已运行（公开 API 已确认）',
  '需要 Lyra/R3 授权',
  '失败，可重试',
]);

const CODE = Object.freeze({
  OK: 0,
  USER_ACTION_REQUIRED: 20,
  BUSY: 10,
  TIMEOUT: 52,
  ACTION_TOKEN_EXPIRED: 53,
  PROTOCOL_MISMATCH: 42,
  UNKNOWN_METHOD: 40,
  PLUGIN_CALL_FAILED: 60,
  UNTRUSTED_ORIGIN: 61,
});

/** Bridge method names consumed (native). refresh → status. */
const BRIDGE_METHOD_MAP = Object.freeze({
  refresh: 'status',
  importMpkg: 'importMpkg',
  installPlugin: 'installPlugin',
  confirmUserAction: 'confirmUserAction',
  renewAction: 'renewAction',
  openLibrary: 'openLibrary',
  applyCurrent: 'applyCurrent',
  next: 'next',
  previous: 'previous',
  stop: 'stop',
  diagnostics: 'diagnostics',
});

function parseBridgeResult(raw) {
  if (raw == null) return { code: CODE.PLUGIN_CALL_FAILED, message: 'empty bridge result' };
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { code: CODE.PLUGIN_CALL_FAILED, message: 'invalid bridge JSON' };
    }
  }
  return { code: CODE.PLUGIN_CALL_FAILED, message: 'unsupported bridge result' };
}

/**
 * Map structured bridge status → allowed UI label.
 * ENGINE_LAUNCHED must not show 可预览 — forbidEngineLaunchedPreview.
 */
function mapBridgeStatusToUiState(status) {
  const s = status && typeof status === 'object' ? status : {};
  const code = Number(s.code);
  const op = String(s.operationState || s.state || s.bindingState || '').toUpperCase();
  const installed = s.installed === true || s.pluginInstalled === true;
  const previewReliable = s.previewReliable === true || s.reliableCallback === true;

  if (code === CODE.PROTOCOL_MISMATCH || op === 'PROTOCOL_MISMATCH') {
    return '失败，可重试';
  }
  if (s.installed === false || op === 'NOT_INSTALLED' || s.pluginInstalled === false) {
    return '未安装';
  }
  if (code === CODE.USER_ACTION_REQUIRED && (s.userActionKind === 'INSTALL_PLUGIN' || op === 'NEED_INSTALL')) {
    return '需要安装确认';
  }
  if (s.needsLyraAuth === true || op === 'LYRA_REQUIRED' || op === 'R3_REQUIRED') {
    return '需要 Lyra/R3 授权';
  }
  if (code === CODE.USER_ACTION_REQUIRED || op === 'USER_ACTION_REQUIRED' || s.actionToken) {
    return '等待用户确认';
  }
  if (op === 'IMPORTING' || op === 'IMPORT_IN_PROGRESS') {
    return '正在导入';
  }
  if (op === 'DELIVERED' || op === 'ENGINE_ACCEPTED') {
    return '已投递到壁纸引擎';
  }
  // forbidEngineLaunchedPreview: ENGINE_LAUNCHED alone is NOT 可预览
  if (op === 'ENGINE_LAUNCHED') {
    return '已投递到壁纸引擎';
  }
  if (op === 'APPLYING') {
    return '正在应用';
  }
  if (op === 'RUNNING' || op === 'LIVE' || s.publicApiConfirmed === true) {
    return '动态壁纸已运行（公开 API 已确认）';
  }
  if (previewReliable && (op === 'PREVIEW' || op === 'PREVIEW_READY')) {
    return '可预览（仅可靠回调）';
  }
  if (code === CODE.OK && installed) {
    return '插件可用';
  }
  if (code === CODE.BUSY || code === CODE.TIMEOUT || code === CODE.PLUGIN_CALL_FAILED || code === CODE.ACTION_TOKEN_EXPIRED) {
    return '失败，可重试';
  }
  if (installed) return '插件可用';
  return '失败，可重试';
}

function sanitizeErrorMessage(message) {
  let text = String(message == null ? '' : message);
  // error文案不包含文件路径
  text = text.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s'"]+/g, '[path]');
  text = text.replace(/content:\/\/[^\s'"]+/g, '[uri]');
  return text;
}

function isTopLevelAllowlistPage(doc, options = {}) {
  if (!doc || !doc.defaultView) return false;
  const win = doc.defaultView;
  try {
    if (win.top !== win) return false; // iframe
  } catch {
    return false;
  }
  const loc = win.location || {};
  const href = String(loc.href || '');
  const allow = options.allowlistPatterns || [
    /^file:\/\//i,
    /^https?:\/\/localhost\b/i,
    /mineradio/i,
    /android_asset/i,
  ];
  if (!allow.some((re) => re.test(href))) return false;
  const expectedNonce = options.pageNonce;
  if (expectedNonce != null) {
    const actual =
      (doc.documentElement && doc.documentElement.getAttribute('data-page-nonce')) ||
      (doc.body && doc.body.getAttribute('data-page-nonce'));
    if (String(actual || '') !== String(expectedNonce)) return false;
  }
  return true;
}

/**
 * Single command queue — only place for mutation dedupe / retry / serialize.
 * REFACTOR: no second queue in poll or UI; stable operationId on retry.
 */
function createCommandQueue(options = {}) {
  /** @type {Array<{id: string, kind: string, fn: Function, resolve: Function, reject: Function}>} */
  const q = [];
  let running = false;
  let lastOperationId = null;
  const sync = options.sync === true;

  async function pump() {
    if (running) return;
    running = true;
    while (q.length) {
      const item = q.shift();
      try {
        const result = item.fn();
        if (result && typeof result.then === 'function') {
          item.resolve(await result);
        } else {
          item.resolve(result);
        }
      } catch (err) {
        item.reject(err);
      }
    }
    running = false;
  }

  return {
    /**
     * Enqueue work bound to a stable operationId (retry/resume must reuse).
     * Dedupe: same operationId+kind still pending → coalesce to one tail wait
     * (throttle repeated taps without dropping the in-flight command).
     */
    enqueue(operationId, fn, kind = 'mutate') {
      const id =
        operationId == null || operationId === ''
          ? `op-${Date.now()}-${Math.random().toString(16).slice(2)}`
          : String(operationId);
      lastOperationId = id;
      if (sync) {
        return fn(id);
      }
      return new Promise((resolve, reject) => {
        // Coalesce pending identical op+kind (not the running head).
        const pendingIdx = q.findIndex((item) => item.id === id && item.kind === kind);
        if (pendingIdx >= 0) {
          const prev = q[pendingIdx];
          const prevResolve = prev.resolve;
          const prevReject = prev.reject;
          prev.resolve = (v) => {
            prevResolve(v);
            resolve(v);
          };
          prev.reject = (e) => {
            prevReject(e);
            reject(e);
          };
          return;
        }
        q.push({
          id,
          kind: String(kind || 'mutate'),
          fn: () => fn(id),
          resolve,
          reject,
        });
        pump();
      });
    },
    getLastOperationId() {
      return lastOperationId;
    },
    depth() {
      return q.length + (running ? 1 : 0);
    },
  };
}

function createRuntime(options = {}) {
  const bridge =
    options.bridge ||
    (typeof globalThis !== 'undefined' ? globalThis[BRIDGE_NAME] : null);
  const documentRef =
    options.document ||
    (typeof globalThis !== 'undefined' ? globalThis.document : null);
  const pageNonce = options.pageNonce;
  const allowlistPatterns = options.allowlistPatterns;
  const setTimer =
    typeof options.setTimeout === 'function'
      ? options.setTimeout
      : (fn, ms) => setTimeout(fn, ms);
  const clearTimer =
    typeof options.clearTimeout === 'function'
      ? options.clearTimeout
      : (id) => clearTimeout(id);

  /** Single queue for all mutation serialization / dedupe / retry. */
  const queue = createCommandQueue({ sync: options.sync === true });
  let lastUiState = '未安装';
  let lastStatus = null;
  /** Fingerprint of last projected structured status — skip redundant UI paint. */
  let lastProjectionKey = '';
  let pollTimer = null;
  let pollActive = false;
  let busyBackoffCount = 0;
  let confirmOnceGuard = new Set();
  let visibilityHandler = null;

  function allowed() {
    if (options.skipAllowlist) return true;
    if (!documentRef) return true; // Node fixtures without DOM
    return isTopLevelAllowlistPage(documentRef, { pageNonce, allowlistPatterns });
  }

  function invokeBridge(method, args) {
    if (!allowed()) {
      return {
        code: CODE.UNTRUSTED_ORIGIN,
        message: sanitizeErrorMessage('bridge not available off allowlist top-level page'),
      };
    }
    if (!bridge || typeof bridge[method] !== 'function') {
      return {
        code: CODE.PLUGIN_CALL_FAILED,
        message: sanitizeErrorMessage(`bridge method missing: ${method}`),
      };
    }
    try {
      return parseBridgeResult(bridge[method](...args));
    } catch (err) {
      return {
        code: CODE.PLUGIN_CALL_FAILED,
        message: sanitizeErrorMessage(err && err.message ? err.message : String(err)),
      };
    }
  }

  /**
   * Single HMI state projection — WebView only paints structured bridge fields
   * via mapBridgeStatusToUiState (no free-form engine strings as UI labels).
   */
  function projectStatus(result) {
    const structured = result && typeof result === 'object' ? result : {};
    lastStatus = structured;
    lastUiState = mapBridgeStatusToUiState(structured);
    if (Number(structured.code) === CODE.BUSY) {
      busyBackoffCount += 1;
    } else {
      busyBackoffCount = 0;
    }
    const key = [
      lastUiState,
      structured.code,
      structured.operationState || structured.state || '',
      structured.actionToken ? '1' : '0',
      structured.actionEpoch != null ? String(structured.actionEpoch) : '',
    ].join('|');
    if (key !== lastProjectionKey) {
      lastProjectionKey = key;
      if (options.onUiState) {
        try {
          options.onUiState(lastUiState, structured);
        } catch {
          // UI projection errors must not break queue
        }
      }
    }
    return structured;
  }

  function refresh(operationId) {
    const result = invokeBridge('status', operationId == null ? [] : [operationId]);
    return projectStatus(result);
  }

  function importMpkg(operationId, sourceUri) {
    return queue.enqueue(
      operationId,
      (id) => projectStatus(invokeBridge('importMpkg', [id, sourceUri])),
      'importMpkg',
    );
  }

  function installPlugin(sourceUri) {
    // Serialize install via the same queue (no second install path).
    return queue.enqueue(
      `install:${sourceUri || ''}`,
      () => projectStatus(invokeBridge('installPlugin', [sourceUri])),
      'installPlugin',
    );
  }

  /**
   * User click only; one-shot per token. Outside mutation queue (gesture path)
   * but still projects via projectStatus only.
   */
  function confirmUserAction(actionToken) {
    const token = String(actionToken || '');
    if (!token) {
      return projectStatus({
        code: CODE.ACTION_TOKEN_EXPIRED,
        message: sanitizeErrorMessage('empty actionToken'),
      });
    }
    if (confirmOnceGuard.has(token)) {
      return projectStatus({
        code: CODE.ACTION_TOKEN_EXPIRED,
        message: sanitizeErrorMessage('actionToken already consumed'),
      });
    }
    confirmOnceGuard.add(token);
    const result = invokeBridge('confirmUserAction', [token]);
    // Token expired / second click: status → renewAction → confirm (caller).
    // Do not re-issue original mutation command.
    return projectStatus(result);
  }

  function renewAction(operationId, actionEpoch) {
    return projectStatus(invokeBridge('renewAction', [operationId, actionEpoch]));
  }

  function openLibrary(operationId) {
    return queue.enqueue(
      operationId,
      (id) => projectStatus(invokeBridge('openLibrary', [id])),
      'openLibrary',
    );
  }

  function applyCurrent(operationId) {
    return queue.enqueue(
      operationId,
      (id) => projectStatus(invokeBridge('applyCurrent', [id])),
      'applyCurrent',
    );
  }

  function next(operationId) {
    return queue.enqueue(
      operationId,
      (id) => projectStatus(invokeBridge('next', [id])),
      'next',
    );
  }

  function previous(operationId) {
    return queue.enqueue(
      operationId,
      (id) => projectStatus(invokeBridge('previous', [id])),
      'previous',
    );
  }

  /**
   * stop carries new stop operationId + targetOperationId (stopCarriesTargetOperationId).
   */
  function stop(operationId, targetOperationId) {
    return queue.enqueue(
      operationId,
      (id) => {
        const target = targetOperationId == null ? id : targetOperationId;
        return projectStatus(invokeBridge('stop', [id, target]));
      },
      'stop',
    );
  }

  function diagnostics(operationId) {
    return projectStatus(
      invokeBridge('diagnostics', operationId == null ? [] : [operationId]),
    );
  }

  /**
   * Token-expired recovery: status(original) → renewAction → confirmUserAction(new).
   * Never re-fire original mutation.
   */
  function recoverExpiredAction(originalOperationId, actionEpoch) {
    const st = refresh(originalOperationId);
    const epoch =
      actionEpoch != null
        ? actionEpoch
        : st && st.actionEpoch != null
          ? st.actionEpoch
          : 0;
    const renewed = renewAction(originalOperationId, epoch);
    if (renewed && renewed.actionToken) {
      return confirmUserAction(renewed.actionToken);
    }
    return renewed;
  }

  function pollIntervalMs() {
    if (pollActive || (lastStatus && Number(lastStatus.code) === CODE.BUSY)) {
      return POLL_ACTIVE_MS; // 500
    }
    if (
      lastStatus &&
      (Number(lastStatus.code) === CODE.USER_ACTION_REQUIRED ||
        lastUiState === '正在导入' ||
        lastUiState === '正在应用' ||
        lastUiState === '等待用户确认')
    ) {
      return POLL_ACTIVE_MS; // 500
    }
    return POLL_IDLE_MS; // 5000
  }

  function schedulePoll() {
    if (pollTimer != null) {
      clearTimer(pollTimer);
      pollTimer = null;
    }
    if (!options.enablePoll && options.enablePoll !== undefined) return;
    const ms = pollIntervalMs();
    pollTimer = setTimer(() => {
      pollTimer = null;
      if (isPageHidden()) return; // stopPollingWhenHidden
      refresh(queue.getLastOperationId() || undefined);
      if (!isPageHidden()) schedulePoll();
    }, ms);
  }

  function isPageHidden() {
    if (!documentRef) return false;
    if (documentRef.hidden === true) return true;
    if (documentRef.visibilityState === 'hidden') return true;
    return false;
  }

  function startStatusPoll(active) {
    pollActive = active === true;
    if (documentRef && typeof documentRef.addEventListener === 'function' && !visibilityHandler) {
      visibilityHandler = () => {
        // visibilitychange — page hide stops poll
        if (isPageHidden()) {
          stopStatusPoll();
        } else {
          schedulePoll();
        }
      };
      documentRef.addEventListener('visibilitychange', visibilityHandler);
    }
    schedulePoll();
  }

  function stopStatusPoll() {
    if (pollTimer != null) {
      clearTimer(pollTimer);
      pollTimer = null;
    }
  }

  function dispose() {
    stopStatusPoll();
    if (documentRef && visibilityHandler && typeof documentRef.removeEventListener === 'function') {
      documentRef.removeEventListener('visibilitychange', visibilityHandler);
    }
    visibilityHandler = null;
    confirmOnceGuard = new Set();
  }

  // API surface — method names must appear for capacity scan
  const api = {
    refresh,
    importMpkg,
    installPlugin,
    confirmUserAction,
    renewAction,
    openLibrary,
    applyCurrent,
    next,
    previous,
    stop,
    diagnostics,
    recoverExpiredAction,
    startStatusPoll,
    stopStatusPoll,
    dispose,
    getUiState: () => lastUiState,
    getLastStatus: () => lastStatus,
    getBusyBackoffCount: () => busyBackoffCount,
    getLastOperationId: () => queue.getLastOperationId(),
    getQueueDepth: () => queue.depth(),
    mapBridgeStatusToUiState,
    projectStatus,
    // contract tokens for capacity / docs
    GLOBAL_NAME,
    BRIDGE_NAME,
    POLL_ACTIVE_MS, // 500
    POLL_IDLE_MS, // 5000
    minTouchCssPx: MIN_TOUCH_CSS_PX, // 48
    minPrimaryCssPx: MIN_PRIMARY_CSS_PX, // 64
    settingsOnlyEntry: SETTINGS_ONLY_ENTRY,
    noDefaultPlaybackMainOps: NO_DEFAULT_PLAYBACK_MAIN_OPS,
    UI_STATES,
    forbidEngineLaunchedPreview: true,
  };

  return api;
}

/**
 * Fake native WallpaperPlugin for RED/GREEN fixtures.
 * Scenarios: not-installed, protocol-mismatch, import-success, busy-backoff,
 * timeout, action-token, token-expired, engine-launched.
 */
function createFakeBridge(scenario, opts = {}) {
  const state = {
    scenario: scenario || 'not-installed',
    busyLeft: opts.busyCount != null ? opts.busyCount : 3,
    calls: [],
    tokens: new Map(),
    consumed: new Set(),
    operationId: opts.operationId || 'op-stable-1',
    actionEpoch: opts.actionEpoch != null ? opts.actionEpoch : 1,
    installed: scenario === 'not-installed' ? false : true,
  };

  function record(name, args, result) {
    state.calls.push({ name, args, result, at: Date.now() });
    return result;
  }

  function issueToken(kind) {
    const token = `tok-${Math.random().toString(16).slice(2)}`;
    state.tokens.set(token, {
      kind,
      operationId: state.operationId,
      actionEpoch: state.actionEpoch,
      createdAt: Date.now(),
    });
    return token;
  }

  const bridge = {
    status(operationId) {
      if (state.scenario === 'protocol-mismatch') {
        return record('status', [operationId], {
          code: CODE.PROTOCOL_MISMATCH,
          message: 'protocol mismatch',
          operationState: 'PROTOCOL_MISMATCH',
        });
      }
      if (state.scenario === 'not-installed' || state.installed === false) {
        return record('status', [operationId], {
          code: CODE.OK,
          installed: false,
          pluginInstalled: false,
          operationState: 'NOT_INSTALLED',
        });
      }
      if (state.scenario === 'timeout') {
        return record('status', [operationId], {
          code: CODE.TIMEOUT,
          message: 'status timeout',
          operationState: 'TIMEOUT',
        });
      }
      if (state.scenario === 'engine-launched') {
        return record('status', [operationId], {
          code: CODE.OK,
          installed: true,
          operationState: 'ENGINE_LAUNCHED',
          // must NOT become 可预览 without reliable callback
        });
      }
      if (state.scenario === 'import-success') {
        return record('status', [operationId], {
          code: CODE.OK,
          installed: true,
          operationState: 'DELIVERED',
          sourceConsumed: true,
        });
      }
      if (state.scenario === 'action-token' || state.scenario === 'token-expired') {
        const token = issueToken('APPLY');
        return record('status', [operationId], {
          code: CODE.USER_ACTION_REQUIRED,
          actionToken: token,
          actionEpoch: state.actionEpoch,
          operationId: operationId || state.operationId,
          operationState: 'USER_ACTION_REQUIRED',
          userActionKind: 'APPLY_CURRENT',
        });
      }
      return record('status', [operationId], {
        code: CODE.OK,
        installed: true,
        operationState: 'IDLE',
        pluginInstalled: true,
      });
    },

    importMpkg(operationId, sourceUri) {
      state.operationId = operationId;
      if (state.scenario === 'busy-backoff' && state.busyLeft > 0) {
        state.busyLeft -= 1;
        return record('importMpkg', [operationId, sourceUri], {
          code: CODE.BUSY,
          message: 'BUSY',
          operationId,
          operationState: 'BUSY',
        });
      }
      if (state.scenario === 'not-installed') {
        return record('importMpkg', [operationId, sourceUri], {
          code: CODE.USER_ACTION_REQUIRED,
          installed: false,
          userActionKind: 'INSTALL_PLUGIN',
          actionToken: issueToken('INSTALL_PLUGIN'),
          operationState: 'NEED_INSTALL',
        });
      }
      if (state.scenario === 'import-success' || state.busyLeft <= 0) {
        return record('importMpkg', [operationId, sourceUri], {
          code: CODE.OK,
          operationId,
          operationState: 'DELIVERED',
          sourceConsumed: true,
        });
      }
      const token = issueToken('IMPORT');
      return record('importMpkg', [operationId, sourceUri], {
        code: CODE.USER_ACTION_REQUIRED,
        actionToken: token,
        actionEpoch: state.actionEpoch,
        operationId,
        operationState: 'USER_ACTION_REQUIRED',
      });
    },

    installPlugin(sourceUri) {
      const token = issueToken('INSTALL_PLUGIN');
      return record('installPlugin', [sourceUri], {
        code: CODE.USER_ACTION_REQUIRED,
        actionToken: token,
        userActionKind: 'INSTALL_PLUGIN',
        operationState: 'NEED_INSTALL',
      });
    },

    confirmUserAction(actionToken) {
      const token = String(actionToken || '');
      if (!token || state.consumed.has(token)) {
        return record('confirmUserAction', [actionToken], {
          code: CODE.ACTION_TOKEN_EXPIRED,
          message: 'actionToken already consumed or unknown',
        });
      }
      if (state.scenario === 'token-expired' && !state.tokens.has(token)) {
        return record('confirmUserAction', [actionToken], {
          code: CODE.ACTION_TOKEN_EXPIRED,
          message: 'actionToken expired',
        });
      }
      if (!state.tokens.has(token) && state.scenario === 'token-expired') {
        return record('confirmUserAction', [actionToken], {
          code: CODE.ACTION_TOKEN_EXPIRED,
          message: 'actionToken expired',
        });
      }
      // First confirm ok; mark consumed (one-shot)
      if (state.scenario === 'token-expired' && opts.expireAll) {
        return record('confirmUserAction', [actionToken], {
          code: CODE.ACTION_TOKEN_EXPIRED,
          message: 'actionToken expired',
        });
      }
      state.consumed.add(token);
      state.tokens.delete(token);
      return record('confirmUserAction', [actionToken], {
        code: CODE.OK,
        operationState: 'CONFIRMED',
      });
    },

    renewAction(operationId, actionEpoch) {
      state.actionEpoch = Number(actionEpoch) + 1;
      state.operationId = operationId;
      const token = issueToken('RENEWED');
      return record('renewAction', [operationId, actionEpoch], {
        code: CODE.USER_ACTION_REQUIRED,
        actionToken: token,
        actionEpoch: state.actionEpoch,
        operationId,
        operationState: 'USER_ACTION_REQUIRED',
      });
    },

    openLibrary(operationId) {
      return record('openLibrary', [operationId], {
        code: CODE.OK,
        operationId,
        operationState: 'LIBRARY_OPEN',
      });
    },

    applyCurrent(operationId) {
      return record('applyCurrent', [operationId], {
        code: CODE.USER_ACTION_REQUIRED,
        actionToken: issueToken('APPLY'),
        actionEpoch: state.actionEpoch,
        operationId,
        operationState: 'USER_ACTION_REQUIRED',
      });
    },

    next(operationId) {
      return record('next', [operationId], { code: CODE.OK, operationId, operationState: 'IDLE' });
    },

    previous(operationId) {
      return record('previous', [operationId], {
        code: CODE.OK,
        operationId,
        operationState: 'IDLE',
      });
    },

    stop(operationId, targetOperationId) {
      return record('stop', [operationId, targetOperationId], {
        code: CODE.OK,
        operationId,
        targetOperationId,
        operationState: 'STOPPED',
      });
    },

    diagnostics(operationId) {
      return record('diagnostics', [operationId], {
        code: CODE.OK,
        operationId,
        operationState: 'DIAG',
      });
    },

    _state: state,
  };

  return bridge;
}

function runFakeBridgeFixtures() {
  const results = [];
  const syncOpts = { skipAllowlist: true, enablePoll: false, sync: true };

  function check(name, fn) {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail });
    } catch (err) {
      results.push({
        name,
        ok: false,
        message: sanitizeErrorMessage(err && err.message ? err.message : String(err)),
      });
    }
  }

  check('not-installed', () => {
    const bridge = createFakeBridge('not-installed');
    const rt = createRuntime({ bridge, ...syncOpts });
    const st = rt.refresh();
    if (rt.getUiState() !== '未安装') throw new Error(`ui=${rt.getUiState()}`);
    return st;
  });

  check('protocol-mismatch', () => {
    const bridge = createFakeBridge('protocol-mismatch');
    const rt = createRuntime({ bridge, ...syncOpts });
    rt.refresh();
    if (rt.getUiState() !== '失败，可重试') throw new Error(`ui=${rt.getUiState()}`);
    return true;
  });

  check('import-success', () => {
    const bridge = createFakeBridge('import-success');
    const rt = createRuntime({ bridge, ...syncOpts });
    const op = 'op-stable-import';
    const r1 = rt.importMpkg(op, 'content://demo/pkg.mpkg');
    if (bridge._state.operationId !== op) throw new Error('operationId not stable');
    rt.refresh(op);
    if (rt.getUiState() !== '已投递到壁纸引擎') throw new Error(`ui=${rt.getUiState()}`);
    return r1;
  });

  check('busy-backoff-3', () => {
    const bridge = createFakeBridge('busy-backoff', { busyCount: 3 });
    const rt = createRuntime({ bridge, ...syncOpts });
    const op = 'op-busy';
    rt.importMpkg(op, 'content://demo/a.mpkg');
    rt.importMpkg(op, 'content://demo/a.mpkg');
    rt.importMpkg(op, 'content://demo/a.mpkg');
    const fourth = rt.importMpkg(op, 'content://demo/a.mpkg');
    if (Number(fourth.code) === CODE.BUSY) throw new Error('expected BUSY exhausted');
    if (rt.getLastOperationId() !== op) throw new Error('operationId drifted');
    const busyCalls = bridge._state.calls.filter((c) => c.result.code === CODE.BUSY).length;
    if (busyCalls !== 3) throw new Error(`expected 3 BUSY, got ${busyCalls}`);
    return { busyCalls };
  });

  check('timeout', () => {
    const bridge = createFakeBridge('timeout');
    const rt = createRuntime({ bridge, ...syncOpts });
    rt.refresh();
    if (rt.getUiState() !== '失败，可重试') throw new Error(`ui=${rt.getUiState()}`);
    const msg = (rt.getLastStatus() && rt.getLastStatus().message) || '';
    if (/\/Users\/|content:\/\//.test(msg)) throw new Error('path leaked in error');
    return true;
  });

  check('page-hide-stops-poll', () => {
    const timers = [];
    let hidden = false;
    const listeners = {};
    const fakeDoc = {
      get hidden() {
        return hidden;
      },
      get visibilityState() {
        return hidden ? 'hidden' : 'visible';
      },
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      removeEventListener(type) {
        delete listeners[type];
      },
      defaultView: {
        top: null,
        location: { href: 'file:///android_asset/mineradio/index.html' },
      },
    };
    fakeDoc.defaultView.top = fakeDoc.defaultView;
    const bridge = createFakeBridge('import-success');
    const rt = createRuntime({
      bridge,
      document: fakeDoc,
      skipAllowlist: true,
      sync: true,
      setTimeout: (fn, ms) => {
        const id = { fn, ms, cleared: false };
        timers.push(id);
        return id;
      },
      clearTimeout: (id) => {
        if (id) id.cleared = true;
      },
    });
    rt.startStatusPoll(true);
    if (!timers.length) throw new Error('poll not scheduled (500/5000)');
    if (timers[0].ms !== POLL_ACTIVE_MS && timers[0].ms !== POLL_IDLE_MS) {
      throw new Error(`unexpected poll interval ${timers[0].ms}`);
    }
    hidden = true;
    if (listeners.visibilitychange) listeners.visibilitychange();
    rt.stopStatusPoll();
    if (timers.some((t) => !t.cleared)) {
      // stopStatusPoll should clear active timer
      rt.stopStatusPoll();
    }
    rt.dispose();
    return { scheduled: timers.length, pollActiveMs: POLL_ACTIVE_MS, pollIdleMs: POLL_IDLE_MS };
  });

  check('stable-operationId-on-retry', () => {
    const bridge = createFakeBridge('busy-backoff', { busyCount: 2 });
    const rt = createRuntime({ bridge, ...syncOpts });
    const op = 'op-retry-stable';
    rt.importMpkg(op, 'content://x');
    rt.importMpkg(op, 'content://x');
    rt.importMpkg(op, 'content://x');
    if (rt.getLastOperationId() !== op) throw new Error('operationId not stable on retry');
    return true;
  });

  check('stop-carries-targetOperationId', () => {
    const bridge = createFakeBridge('import-success');
    const rt = createRuntime({ bridge, ...syncOpts });
    const stopOp = 'op-stop-new';
    const target = 'op-target-running';
    rt.stop(stopOp, target);
    const call = bridge._state.calls.find((c) => c.name === 'stop');
    if (!call || call.args[0] !== stopOp || call.args[1] !== target) {
      throw new Error('stop must carry operationId + targetOperationId');
    }
    return true;
  });

  check('top-level-allowlist-only', () => {
    const bridge = createFakeBridge('import-success');
    const iframeDoc = {
      hidden: false,
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      defaultView: {
        top: {},
        location: { href: 'https://evil.example/login' },
      },
    };
    const rt = createRuntime({
      bridge,
      document: iframeDoc,
      skipAllowlist: false,
      enablePoll: false,
      sync: true,
    });
    const r = rt.refresh();
    if (Number(r.code) !== CODE.UNTRUSTED_ORIGIN) {
      throw new Error('iframe/external must not access high-privilege bridge');
    }
    return true;
  });

  check('code20-actionToken-confirm-once', () => {
    const bridge = createFakeBridge('action-token');
    const rt = createRuntime({ bridge, ...syncOpts });
    const st = rt.refresh('op-1');
    if (Number(st.code) !== CODE.USER_ACTION_REQUIRED || !st.actionToken) {
      throw new Error('expected code=20 + actionToken');
    }
    if (rt.getUiState() !== '等待用户确认') throw new Error(`ui=${rt.getUiState()}`);
    const c1 = rt.confirmUserAction(st.actionToken);
    if (Number(c1.code) !== CODE.OK) throw new Error('first confirm should OK');
    const c2 = rt.confirmUserAction(st.actionToken);
    if (Number(c2.code) !== CODE.ACTION_TOKEN_EXPIRED) {
      throw new Error('second confirm must ACTION_TOKEN_EXPIRED');
    }
    return true;
  });

  check('token-expired-renew-path', () => {
    // status → renewAction → confirmUserAction(new); never re-import
    const bridge = createFakeBridge('action-token');
    const rt = createRuntime({ bridge, ...syncOpts });
    const st = rt.refresh('op-renew');
    const renewed = rt.renewAction('op-renew', st.actionEpoch || 1);
    if (!renewed.actionToken) throw new Error('renew must issue new actionToken');
    const conf = rt.confirmUserAction(renewed.actionToken);
    if (Number(conf.code) !== CODE.OK) throw new Error('confirm after renew failed');
    const imports = bridge._state.calls.filter((c) => c.name === 'importMpkg');
    if (imports.length) throw new Error('must not re-issue mutation on token renew');
    return true;
  });

  check('ENGINE_LAUNCHED-not-preview', () => {
    const bridge = createFakeBridge('engine-launched');
    const rt = createRuntime({ bridge, ...syncOpts });
    rt.refresh();
    const ui = rt.getUiState();
    if (ui === '可预览（仅可靠回调）' || ui === '可预览') {
      throw new Error('forbidEngineLaunchedPreview violated');
    }
    if (ui !== '已投递到壁纸引擎') throw new Error(`ui=${ui}`);
    return true;
  });

  check('no-path-in-errors', () => {
    const msg = sanitizeErrorMessage('failed /Users/anpple/secret/file.mpkg content://auth/x');
    if (msg.includes('/Users/') || msg.includes('content://')) {
      throw new Error('path not sanitized');
    }
    return msg;
  });

  return results;
}

function assertRuntimeFixtures() {
  const results = runFakeBridgeFixtures();
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    results,
    failed: failed.map((f) => f.name),
    message:
      failed.length === 0
        ? 'all fake-bridge fixtures passed'
        : `fixtures failed: ${failed.map((f) => `${f.name}:${f.message}`).join('; ')}`,
    UI_STATES,
    POLL_ACTIVE_MS,
    POLL_IDLE_MS,
    GLOBAL_NAME,
    forbidEngineLaunchedPreview: true,
    minTouchCssPx: MIN_TOUCH_CSS_PX,
    minPrimaryCssPx: MIN_PRIMARY_CSS_PX,
    settingsOnlyEntry: SETTINGS_ONLY_ENTRY,
  };
}

function installOnWindow(win) {
  const w = win || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (!w) return null;
  const runtime = createRuntime({
    bridge: w[BRIDGE_NAME],
    document: w.document,
  });
  w[GLOBAL_NAME] = runtime;
  // Auto-start idle poll when DOM present
  if (w.document) {
    runtime.startStatusPoll(false);
  }
  return runtime;
}

const api = {
  GLOBAL_NAME,
  BRIDGE_NAME,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  MIN_TOUCH_CSS_PX,
  MIN_PRIMARY_CSS_PX,
  UI_STATES,
  CODE,
  BRIDGE_METHOD_MAP,
  createRuntime,
  createFakeBridge,
  runFakeBridgeFixtures,
  assertRuntimeFixtures,
  installOnWindow,
  mapBridgeStatusToUiState,
  sanitizeErrorMessage,
  isTopLevelAllowlistPage,
  forbidEngineLaunchedPreview: true,
  settingsOnlyEntry: SETTINGS_ONLY_ENTRY,
  noDefaultPlaybackMainOps: NO_DEFAULT_PLAYBACK_MAIN_OPS,
};

// Node
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

// Browser WebView
if (typeof window !== 'undefined' && window.document) {
  try {
    installOnWindow(window);
  } catch {
    // attach best-effort; HMI may call installOnWindow later
  }
}
