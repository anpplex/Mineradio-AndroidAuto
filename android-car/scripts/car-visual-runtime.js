/**
 * Mineradio car visual runtime.
 *
 * Project HMI for Huawei Android 12 landscape head-units (density-scaled WebView).
 * Not an OEM certification claim.
 *
 * Modes:
 *   drive  — music-class driving: max readability, min motion distraction
 *   cruise — balanced: keep Mineradio identity without full desktop chaos
 *   stage  — parked / user-opt-in: maximize open / free / stunning stage looks
 *
 * Does not bypass auth, alter media rights, or talk to OEM vehicle buses.
 */
(function carVisualRuntime(global) {
  'use strict';

  var STORAGE_KEY = 'mineradio.car.visualMode';
  var ATTR = 'data-car-visual-mode';
  var MODES = ['drive', 'cruise', 'stage'];
  var LABELS = {
    drive: '行车',
    cruise: '巡航',
    stage: '舞台',
  };
  var HINTS = {
    drive: '驾驶优先：弱动效、强可读、主播控突出',
    cruise: '平衡：保留氛围与歌词舞台，控制台仍清爽',
    stage: '惊艳：尽量还原 Mineradio 粒子 / 镜头 / 舞台',
  };

  /** Per-mode budgets: CSS vars + best-effort FX control probes. */
  var MODE_BUDGET = {
    drive: {
      particleOpacity: 0.12,
      scrim: 0.42,
      lyricScaleBoost: 1.08,
      cineshake: 0,
      intensity: 0.28,
      bloom: 0.15,
      coverRes: 0.9,
      qualityHint: '低',
      shelf: 'off',
      hideFxFab: false,
      reduceMotion: true,
    },
    cruise: {
      particleOpacity: 0.34,
      scrim: 0.26,
      lyricScaleBoost: 1.0,
      cineshake: 0.22,
      intensity: 0.55,
      bloom: 0.35,
      coverRes: 1.2,
      qualityHint: '中',
      shelf: 'side',
      hideFxFab: false,
      reduceMotion: false,
    },
    stage: {
      particleOpacity: 0.72,
      scrim: 0.08,
      lyricScaleBoost: 1.0,
      cineshake: 0.55,
      intensity: 0.85,
      bloom: 0.62,
      coverRes: 1.55,
      qualityHint: '高',
      shelf: 'stage',
      hideFxFab: false,
      reduceMotion: false,
    },
  };

  function normalizeMode(value) {
    var mode = String(value || '').toLowerCase();
    return MODES.indexOf(mode) >= 0 ? mode : 'drive';
  }

  function readStoredMode() {
    try {
      return normalizeMode(global.localStorage && global.localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return 'drive';
    }
  }

  function writeStoredMode(mode) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, mode);
    } catch (_) {
      /* ignore quota / private mode */
    }
  }

  function setCssBudget(budget) {
    var root = global.document && global.document.documentElement;
    if (!root) return;
    root.style.setProperty('--car-particle-opacity', String(budget.particleOpacity));
    root.style.setProperty('--car-stage-scrim', String(budget.scrim));
    root.style.setProperty('--car-lyric-scale-boost', String(budget.lyricScaleBoost));
    root.style.setProperty('--car-reduce-motion', budget.reduceMotion ? '1' : '0');
  }

  function setRangeIfPresent(id, value) {
    var el = global.document.getElementById(id);
    if (!el) return false;
    var min = el.min !== '' && el.min != null ? Number(el.min) : 0;
    var max = el.max !== '' && el.max != null ? Number(el.max) : 1;
    var next = Math.min(max, Math.max(min, Number(value)));
    if (String(el.value) === String(next)) return true;
    el.value = String(next);
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {
      /* older WebView */
    }
    return true;
  }

  function clickSegmentByLabel(containerId, label) {
    var root = global.document.getElementById(containerId);
    if (!root) return false;
    var nodes = root.querySelectorAll('button, [role="button"], .seg-btn, .segment, label, span');
    for (var i = 0; i < nodes.length; i += 1) {
      var text = (nodes[i].textContent || '').replace(/\s+/g, '');
      if (text.indexOf(label) >= 0) {
        try {
          nodes[i].click();
          return true;
        } catch (_) {
          return false;
        }
      }
    }
    return false;
  }

  function applyFxProbes(mode, budget) {
    // Best-effort: only touch controls that already exist in the APK shell.
    setRangeIfPresent('fx-intensity', budget.intensity);
    setRangeIfPresent('fx-cineshake', budget.cineshake);
    setRangeIfPresent('fx-bloom', budget.bloom);
    setRangeIfPresent('fx-coverres', budget.coverRes);
    setRangeIfPresent('fx-bgopacity', mode === 'stage' ? 0.35 : mode === 'cruise' ? 0.55 : 0.72);

    if (budget.qualityHint) clickSegmentByLabel('render-quality-seg', budget.qualityHint);

    // Drive: prefer shelf closed if the segmented control exists.
    if (mode === 'drive') {
      clickSegmentByLabel('shelf-seg', '关闭') || clickSegmentByLabel('shelf-seg', '关');
    } else if (mode === 'stage') {
      clickSegmentByLabel('shelf-seg', '舞台') || clickSegmentByLabel('shelf-presence-seg', '常驻');
    }

    // Desktop-only features stay off on car (never force-enable).
    var desk = global.document.getElementById('t-desktopLyrics');
    if (desk && desk.checked) {
      try {
        desk.click();
      } catch (_) {
        desk.checked = false;
      }
    }
  }

  function ensureModeSwitch() {
    var doc = global.document;
    if (!doc) return null;
    var existing = doc.getElementById('car-visual-mode-switch');
    if (existing) return existing;

    var wrap = doc.createElement('div');
    wrap.id = 'car-visual-mode-switch';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', '车机视觉模式');
    wrap.innerHTML =
      '<button type="button" data-car-mode="drive" aria-pressed="false">行车</button>' +
      '<button type="button" data-car-mode="cruise" aria-pressed="false">巡航</button>' +
      '<button type="button" data-car-mode="stage" aria-pressed="false">舞台</button>' +
      '<span id="car-visual-mode-hint" class="car-visual-mode-hint"></span>';

    wrap.addEventListener('click', function onModeClick(event) {
      var target = event.target;
      if (!target || !target.getAttribute) return;
      var mode = target.getAttribute('data-car-mode');
      if (!mode) return;
      setMode(mode, { user: true });
    });

    doc.body.appendChild(wrap);
    return wrap;
  }

  function syncSwitchUi(mode) {
    var wrap = global.document.getElementById('car-visual-mode-switch');
    if (!wrap) return;
    var buttons = wrap.querySelectorAll('[data-car-mode]');
    for (var i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      var active = btn.getAttribute('data-car-mode') === mode;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (active) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    }
    var hint = global.document.getElementById('car-visual-mode-hint');
    if (hint) hint.textContent = HINTS[mode] || '';
  }

  function setMode(nextMode, options) {
    var mode = normalizeMode(nextMode);
    var budget = MODE_BUDGET[mode];
    var root = global.document.documentElement;
    var body = global.document.body;
    root.setAttribute(ATTR, mode);
    if (body) {
      body.setAttribute(ATTR, mode);
      body.classList.toggle('car-mode-drive', mode === 'drive');
      body.classList.toggle('car-mode-cruise', mode === 'cruise');
      body.classList.toggle('car-mode-stage', mode === 'stage');
      body.classList.toggle('car-reduce-motion', !!budget.reduceMotion);
    }
    setCssBudget(budget);
    syncSwitchUi(mode);
    if (!options || options.persist !== false) writeStoredMode(mode);
    // Delay FX probes until shell widgets exist.
    global.setTimeout(function () {
      applyFxProbes(mode, budget);
    }, options && options.immediate ? 0 : 400);
    try {
      global.dispatchEvent(
        new CustomEvent('mineradio:car-visual-mode', {
          detail: { mode: mode, budget: budget, user: !!(options && options.user) },
        }),
      );
    } catch (_) {
      /* ignore */
    }
    return mode;
  }

  function cycleMode() {
    var current = normalizeMode(global.document.documentElement.getAttribute(ATTR));
    var idx = MODES.indexOf(current);
    return setMode(MODES[(idx + 1) % MODES.length], { user: true });
  }

  function boot() {
    if (!global.document || !global.document.body) {
      global.document.addEventListener('DOMContentLoaded', boot);
      return;
    }
    ensureModeSwitch();
    var initial = readStoredMode();
    // First run defaults to drive (music-class safety), not stage.
    if (!global.localStorage || global.localStorage.getItem(STORAGE_KEY) == null) {
      initial = 'drive';
    }
    setMode(initial, { persist: true });

    // Re-assert budget after late shell hydration (splash → home).
    var retries = 0;
    var timer = global.setInterval(function () {
      retries += 1;
      var mode = normalizeMode(global.document.documentElement.getAttribute(ATTR));
      applyFxProbes(mode, MODE_BUDGET[mode]);
      if (retries >= 8) global.clearInterval(timer);
    }, 1500);

    // Long-press play button area is reserved by player; double-tap mode switch cycles.
    var switchEl = global.document.getElementById('car-visual-mode-switch');
    if (switchEl) {
      switchEl.addEventListener('dblclick', function (event) {
        event.preventDefault();
        cycleMode();
      });
    }
  }

  var api = {
    modes: MODES.slice(),
    labels: LABELS,
    getMode: function () {
      return normalizeMode(
        (global.document &&
          global.document.documentElement &&
          global.document.documentElement.getAttribute(ATTR)) ||
          readStoredMode(),
      );
    },
    setMode: setMode,
    cycleMode: cycleMode,
    budgets: MODE_BUDGET,
  };

  global.MineradioCarVisual = api;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
