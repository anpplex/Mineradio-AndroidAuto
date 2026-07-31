/**
 * Mineradio car visual runtime.
 *
 * Project HMI for Huawei Android 12 landscape head-units (density-scaled WebView).
 * Not an OEM certification claim.
 *
 * Modes:
 *   drive  — music-class driving: max readability, min motion distraction
 *   cruise — balanced: keep Mineradio identity without full desktop chaos
 *   stage  — maximize upstream Mineradio open / free / stunning stage
 *            via real APK APIs: setPreset / toggleFx / setShelfMode /
 *            setRenderQuality / FX sliders
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
    cruise: '平衡：封面氛围 + 可读歌词舞台',
    stage: '最大化：emily · 粒子 · 电影镜头 · 3D 架 · 极致画质',
  };

  /**
   * Per-mode budgets.
   * Stage values intentionally push toward upstream「默认测试 / emily」and above
   * for parked showcase (coverRes 1.55, strong cinema/bloom/intensity).
   */
  var MODE_BUDGET = {
    drive: {
      particleOpacity: 0.12,
      scrim: 0.42,
      lyricScaleBoost: 1.08,
      cineshake: 0,
      intensity: 0.22,
      bloom: 0.1,
      coverRes: 0.85,
      depth: 0.25,
      lyricGlow: 0.12,
      point: 0.35,
      speed: 0.35,
      twist: 0.1,
      scatter: 0.15,
      bgfade: 0.55,
      bgopacity: 0.78,
      quality: 'low',
      preset: null,
      shelf: 'off',
      shelfPresence: 'hover',
      fxOn: {},
      fxOff: {
        floatLayer: true,
        cinema: true,
        lyricGlow: true,
        lyricGlowBeat: true,
        lyricGlowParticles: true,
        bloom: true,
        edge: true,
      },
      reduceMotion: true,
    },
    cruise: {
      particleOpacity: 0.4,
      scrim: 0.22,
      lyricScaleBoost: 1.0,
      cineshake: 0.35,
      intensity: 0.58,
      bloom: 0.4,
      coverRes: 1.25,
      depth: 0.45,
      lyricGlow: 0.28,
      point: 0.55,
      speed: 0.5,
      twist: 0.25,
      scatter: 0.3,
      bgfade: 0.4,
      bgopacity: 0.5,
      quality: 'high',
      preset: 0,
      shelf: 'side',
      shelfPresence: 'hover',
      fxOn: {
        floatLayer: true,
        cinema: true,
        lyricGlow: true,
      },
      fxOff: {
        lyricGlowParticles: true,
        desktopLyrics: true,
      },
      reduceMotion: false,
    },
    stage: {
      particleOpacity: 1,
      scrim: 0.02,
      lyricScaleBoost: 1.02,
      cineshake: 0.55,
      intensity: 0.92,
      bloom: 0.72,
      coverRes: 1.55,
      depth: 0.72,
      lyricGlow: 0.42,
      point: 0.78,
      speed: 0.68,
      twist: 0.45,
      scatter: 0.48,
      bgfade: 0.28,
      bgopacity: 0.28,
      quality: 'ultra',
      /** emily专辑封面 — upstream default showcase preset */
      preset: 0,
      shelf: 'stage',
      shelfPresence: 'always',
      fxOn: {
        floatLayer: true,
        cinema: true,
        lyricGlow: true,
        lyricGlowBeat: true,
        lyricGlowParticles: true,
        lyricCameraLock: true,
        bloom: true,
        edge: true,
      },
      fxOff: {
        desktopLyrics: true,
        forceSystemWallpaper: true,
      },
      reduceMotion: false,
    },
  };

  var STAGE_RETRY_MS = [0, 400, 1200, 2500, 4500, 8000];

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
      /* ignore */
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

  function callGlobal(name, args) {
    try {
      var fn = global[name];
      if (typeof fn === 'function') {
        return fn.apply(global, args || []);
      }
    } catch (_) {
      return undefined;
    }
    return undefined;
  }

  function setRangeIfPresent(id, value) {
    var el = global.document.getElementById(id);
    if (!el) return false;
    var min = el.min !== '' && el.min != null ? Number(el.min) : 0;
    var max = el.max !== '' && el.max != null ? Number(el.max) : 1;
    var next = Math.min(max, Math.max(min, Number(value)));
    el.value = String(next);
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {
      /* older WebView */
    }
    return true;
  }

  function clickBySelector(selector) {
    var el = global.document.querySelector(selector);
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function readFxFlag(key) {
    try {
      if (global.fx && typeof global.fx === 'object' && key in global.fx) {
        return !!global.fx[key];
      }
    } catch (_) {
      /* ignore */
    }
    var toggleId = 't-' + (key === 'floatLayer' ? 'float' : key === 'aiDepth' ? 'aidepth' : key);
    var toggle = global.document.getElementById(toggleId);
    if (toggle) return toggle.classList.contains('on');
    return null;
  }

  function ensureFxKey(key, wantOn) {
    var current = readFxFlag(key);
    if (current === wantOn) return true;
    if (typeof global.toggleFx === 'function') {
      try {
        // toggleFx flips; if unknown state, click once toward desired via DOM class then re-check
        if (current == null) {
          global.toggleFx(key);
          current = readFxFlag(key);
          if (current === wantOn) return true;
          if (current != null && current !== wantOn) global.toggleFx(key);
          return readFxFlag(key) === wantOn;
        }
        global.toggleFx(key);
        return readFxFlag(key) === wantOn;
      } catch (_) {
        return false;
      }
    }
    var toggleId = 't-' + (key === 'floatLayer' ? 'float' : key);
    var toggle = global.document.getElementById(toggleId);
    if (toggle && !!toggle.classList.contains('on') !== wantOn) {
      try {
        toggle.click();
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function applyFxKeyMap(map, wantOn) {
    if (!map) return;
    Object.keys(map).forEach(function (key) {
      if (map[key]) ensureFxKey(key, wantOn);
    });
  }

  function exitImmersiveIfBlockingShelf(budget) {
    if (budget.shelf === 'off') return;
    try {
      if (global.immersiveMode) {
        var btn = global.document.getElementById('immersive-btn');
        if (btn) btn.click();
        else if (typeof global.setImmersiveMode === 'function') global.setImmersiveMode(false);
        else if (typeof global.toggleImmersiveMode === 'function') global.toggleImmersiveMode();
      }
    } catch (_) {
      /* ignore */
    }
  }

  function applyQuality(quality) {
    if (!quality) return false;
    if (typeof global.setRenderQuality === 'function') {
      try {
        global.setRenderQuality(quality);
        return true;
      } catch (_) {
        /* fall through */
      }
    }
    return clickBySelector('#render-quality-seg button[data-rq="' + quality + '"]');
  }

  function applyShelf(budget) {
    exitImmersiveIfBlockingShelf(budget);
    if (budget.shelf != null) {
      if (typeof global.setShelfMode === 'function') {
        try {
          global.setShelfMode(budget.shelf);
        } catch (_) {
          clickBySelector('#shelf-seg button[data-shelf="' + budget.shelf + '"]');
        }
      } else {
        clickBySelector('#shelf-seg button[data-shelf="' + budget.shelf + '"]');
      }
    }
    if (budget.shelfPresence) {
      if (typeof global.setShelfPresence === 'function') {
        try {
          global.setShelfPresence(budget.shelfPresence);
        } catch (_) {
          clickBySelector(
            '#shelf-presence-seg button[data-shelf-presence="' + budget.shelfPresence + '"]',
          );
        }
      } else {
        clickBySelector(
          '#shelf-presence-seg button[data-shelf-presence="' + budget.shelfPresence + '"]',
        );
      }
    }
  }

  function applyPreset(preset) {
    if (preset == null || preset === '') return false;
    if (typeof global.setPreset === 'function') {
      try {
        global.setPreset(Number(preset), { skipTransition: false });
        return true;
      } catch (_) {
        /* fall through */
      }
    }
    // Dynamic preset grid cards often use data-preset / data-id
    return (
      clickBySelector('#preset-grid [data-preset="' + preset + '"]') ||
      clickBySelector('#preset-grid [data-id="' + preset + '"]') ||
      clickBySelector('#preset-grid .preset-card:nth-child(' + (Number(preset) + 1) + ')')
    );
  }

  function applySliders(budget) {
    setRangeIfPresent('fx-intensity', budget.intensity);
    setRangeIfPresent('fx-cineshake', budget.cineshake);
    setRangeIfPresent('fx-bloom', budget.bloom);
    setRangeIfPresent('fx-coverres', budget.coverRes);
    setRangeIfPresent('fx-depth', budget.depth);
    setRangeIfPresent('fx-lyricglow', budget.lyricGlow);
    setRangeIfPresent('fx-point', budget.point);
    setRangeIfPresent('fx-speed', budget.speed);
    setRangeIfPresent('fx-twist', budget.twist);
    setRangeIfPresent('fx-scatter', budget.scatter);
    setRangeIfPresent('fx-bgfade', budget.bgfade);
    setRangeIfPresent('fx-bgopacity', budget.bgopacity);
    // Prefer landscape shell on car units when control exists.
    clickBySelector('#startup-orient-seg button[data-orient="landscape"]');
    if (typeof global.setStartupOrientation === 'function') {
      try {
        global.setStartupOrientation('landscape');
      } catch (_) {
        /* ignore */
      }
    }
  }

  function persistFxIfPossible() {
    callGlobal('syncFxUniforms');
    callGlobal('updateFxInputs');
    callGlobal('saveFxState');
    callGlobal('saveLyricLayout');
  }

  function applyFxProbes(mode, budget) {
    applySliders(budget);
    applyQuality(budget.quality);
    applyFxKeyMap(budget.fxOn, true);
    applyFxKeyMap(budget.fxOff, false);
    applyShelf(budget);

    // Desktop-only features always off on car.
    ensureFxKey('desktopLyrics', false);
    ensureFxKey('forceSystemWallpaper', false);
    try {
      if (typeof global.applyDesktopLyricsState === 'function') {
        global.applyDesktopLyricsState(true);
      }
    } catch (_) {
      /* ignore */
    }

    if (mode === 'stage' || mode === 'cruise') {
      applyPreset(budget.preset);
    }

    // Cam / gesture stays off for cockpit safety even on stage.
    clickBySelector('#cam-seg button[data-cam="off"]');

    // Keep lyrics visible on sonic topography if that control exists.
    clickBySelector('#st-showLyrics-seg button[data-val="true"]');

    persistFxIfPossible();
  }

  function scheduleStageMaximize(mode, budget) {
    if (mode !== 'stage' && mode !== 'cruise') {
      applyFxProbes(mode, budget);
      return;
    }
    STAGE_RETRY_MS.forEach(function (delay) {
      global.setTimeout(function () {
        var current = normalizeMode(
          global.document.documentElement && global.document.documentElement.getAttribute(ATTR),
        );
        if (current !== mode) return;
        applyFxProbes(mode, budget);
      }, delay);
    });
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
    scheduleStageMaximize(mode, budget);
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

  function applyStageNow() {
    return setMode('stage', { user: true, persist: true });
  }

  function boot() {
    if (!global.document || !global.document.body) {
      global.document.addEventListener('DOMContentLoaded', boot);
      return;
    }
    ensureModeSwitch();
    var initial = readStoredMode();
    if (!global.localStorage || global.localStorage.getItem(STORAGE_KEY) == null) {
      initial = 'drive';
    }
    setMode(initial, { persist: true });

    // After splash → home, re-assert once more for late APK shell bind.
    global.setTimeout(function () {
      var mode = normalizeMode(global.document.documentElement.getAttribute(ATTR));
      if (mode === 'stage' || mode === 'cruise') {
        applyFxProbes(mode, MODE_BUDGET[mode]);
      }
    }, 6000);

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
    applyStageNow: applyStageNow,
    budgets: MODE_BUDGET,
  };

  global.MineradioCarVisual = api;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
