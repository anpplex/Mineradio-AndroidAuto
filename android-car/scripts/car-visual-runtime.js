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
    stage: 'Showcase 拉满：emily · 密粒子 · 电影镜头 · 3D 架 · 极致',
  };

  /**
   * Per-mode budgets.
   * Product decision (2026-07-31): stage = SHOWCASE MAX, not「默认测试」克制曲线.
   * Emily + densest legal cover mesh + full FX toggles for parked wow.
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
      /** Showcase 拉满 — user decision; not the conservative「默认测试」curve. */
      particleOpacity: 1,
      scrim: 0,
      lyricScaleBoost: 1.04,
      cineshake: 0.85,
      intensity: 1.0,
      bloom: 0.95,
      /** Car clamp max 2.2; densest emily cover particle mesh. */
      coverRes: 2.2,
      depth: 0.9,
      lyricGlow: 0.62,
      point: 1.0,
      speed: 1.0,
      twist: 0.65,
      scatter: 0.7,
      bgfade: 0.12,
      bgopacity: 0.18,
      color: 1.25,
      quality: 'ultra',
      /** emily专辑封面 */
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
      showcase: true,
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
    // P0-3: prefer direct fx write over toggle race.
    try {
      if (global.fx && typeof global.fx === 'object') {
        if (global.fx[key] !== wantOn) {
          global.fx[key] = !!wantOn;
          var toggleId =
            't-' + (key === 'floatLayer' ? 'float' : key === 'aiDepth' ? 'aidepth' : key);
          var toggle = global.document.getElementById(toggleId);
          if (toggle) toggle.classList.toggle('on', !!wantOn);
        }
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    var current = readFxFlag(key);
    if (current === wantOn) return true;
    if (typeof global.toggleFx === 'function') {
      try {
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
    var toggleId2 = 't-' + (key === 'floatLayer' ? 'float' : key);
    var toggle2 = global.document.getElementById(toggleId2);
    if (toggle2 && !!toggle2.classList.contains('on') !== wantOn) {
      try {
        toggle2.click();
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
    var ok = false;
    // P0-1: APK 1.1.7.0 path is data-rq segment (authoritative), then named APIs.
    try {
      if (global.fx && typeof global.fx === 'object') {
        if ('renderQuality' in global.fx) global.fx.renderQuality = quality;
        if ('rq' in global.fx) global.fx.rq = quality;
        if ('performanceQuality' in global.fx) global.fx.performanceQuality = quality;
      }
    } catch (_) {
      /* ignore */
    }
    ok = clickBySelector('#render-quality-seg button[data-rq="' + quality + '"]') || ok;
    if (typeof global.setRenderQuality === 'function') {
      try {
        global.setRenderQuality(quality);
        ok = true;
      } catch (_) {
        /* ignore */
      }
    }
    if (typeof global.setPerformanceQualityMode === 'function') {
      try {
        // Map car ultra → desktop-style ultra if present.
        global.setPerformanceQualityMode(quality === 'ultra' ? 'ultra' : quality);
        ok = true;
      } catch (_) {
        /* ignore */
      }
    }
    try {
      if (global.localStorage) {
        global.localStorage.setItem('mineradio-render-quality-v1', quality);
      }
      if (typeof global.currentRenderQuality !== 'undefined') {
        global.currentRenderQuality = quality;
      }
      if (typeof global.applyRenderQualityLevels === 'function') {
        global.applyRenderQualityLevels(quality);
        ok = true;
      }
      if (typeof global.updateRenderQualityUI === 'function') {
        global.updateRenderQualityUI();
      }
      if (typeof global.applyRendererPowerMode === 'function') {
        global.applyRendererPowerMode();
      }
    } catch (_) {
      /* ignore */
    }
    // Confirm active class; re-click once if missing.
    var active = global.document.querySelector(
      '#render-quality-seg button[data-rq="' + quality + '"].active',
    );
    if (!active) {
      ok = clickBySelector('#render-quality-seg button[data-rq="' + quality + '"]') || ok;
    }
    return ok;
  }

  /**
   * Stock APK clamps cover resolution to 1.55 → grid ≈183 / texture 512, which reads
   * soft on 1920×1080 car glass (emily is a particle reconstruction of the cover).
   * On car we raise the clamp + denser grid + larger cover texture for stage/cruise.
   */
  function installCoverSharpnessHooks() {
    if (global.__mineradioCarCoverSharpHooks) return;
    global.__mineradioCarCoverSharpHooks = true;

    global.normalizeCoverResolution = function carNormalizeCoverResolution(v) {
      v = Number(v);
      if (!isFinite(v) || v <= 0) v = 1;
      return Math.max(0.75, Math.min(2.2, v));
    };

    global.coverParticleGridForResolution = function carCoverParticleGridForResolution(v) {
      // Stock: round(118 * res) capped 183. Car stage: denser base + higher cap.
      var res = global.normalizeCoverResolution(v);
      var grid = Math.round(148 * res);
      grid = Math.max(88, Math.min(300, grid));
      return grid % 2 ? grid : grid + 1;
    };

    global.coverTextureSizeForResolution = function carCoverTextureSizeForResolution(v) {
      v = global.normalizeCoverResolution(v);
      if (v >= 1.9) return 1024;
      if (v >= 1.55) return 768;
      if (v >= 1.32) return 512;
      if (v >= 1.1) return 384;
      return 256;
    };

    // Widen the FX slider so UI stays consistent if user opens the panel.
    try {
      var slider = global.document.getElementById('fx-coverres');
      if (slider) {
        slider.max = '2.2';
        slider.step = '0.01';
      }
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Emily cover sharpness depends on cover particle grid + texture size.
   * Must call applyCoverParticleResolution with reload after setPreset.
   */
  function applyCoverResolutionSharp(value) {
    installCoverSharpnessHooks();
    var v = Number(value);
    if (!(v > 0)) v = 2.2;
    v = global.normalizeCoverResolution(v);
    setRangeIfPresent('fx-coverres', Math.min(v, 2.2));
    if (typeof global.applyCoverParticleResolution === 'function') {
      try {
        global.applyCoverParticleResolution(v, { reload: true });
        return true;
      } catch (_) {
        /* fall through */
      }
    }
    try {
      if (global.fx) global.fx.coverResolution = v;
    } catch (_) {
      /* ignore */
    }
    setRangeIfPresent('fx-coverres', v);
    return true;
  }

  function shelfLooksApplied(budget) {
    if (!budget || budget.shelf == null) return true;
    try {
      if (global.fx && global.fx.shelf === budget.shelf) return true;
    } catch (_) {
      /* ignore */
    }
    var btn = global.document.querySelector(
      '#shelf-seg button[data-shelf="' + budget.shelf + '"].active',
    );
    if (btn) return true;
    var bar = global.document.getElementById('bottom-bar');
    if (budget.shelf === 'stage' && bar && bar.classList.contains('stage-mode')) return true;
    return false;
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
      if (!shelfLooksApplied(budget)) {
        clickBySelector('#shelf-seg button[data-shelf="' + budget.shelf + '"]');
        try {
          if (global.fx) global.fx.shelf = budget.shelf;
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (budget.shelfPresence) {
      // APK only always|hover — never write upstream-only "auto".
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

  /** P0-2: force particle / stage lyrics on for stage mode. */
  function applyParticleLyrics(mode) {
    if (mode !== 'stage' && mode !== 'cruise') return false;
    var ok = false;
    try {
      if (global.fx && typeof global.fx === 'object') {
        global.fx.particleLyrics = true;
      }
      if (typeof global.lyricsVisible !== 'undefined') {
        global.lyricsVisible = true;
      }
    } catch (_) {
      /* ignore */
    }
    if (typeof global.setParticleLyricsSilently === 'function') {
      try {
        global.setParticleLyricsSilently(true);
        ok = true;
      } catch (_) {
        /* ignore */
      }
    }
    if (typeof global.toggleLyricsPanel === 'function') {
      try {
        // force open 3D lyrics path when available
        global.toggleLyricsPanel(true);
        ok = true;
      } catch (_) {
        try {
          if (global.fx && !global.fx.particleLyrics) global.toggleLyricsPanel();
        } catch (_2) {
          /* ignore */
        }
      }
    }
    ok = clickBySelector('#bottom-bar .lyrics-toggle-btn') || ok;
    ok = clickBySelector('#lyrics-toggle-btn') || ok;
    if (typeof global.createLyricsParticles === 'function') {
      try {
        global.createLyricsParticles();
        ok = true;
      } catch (_) {
        /* ignore */
      }
    }
    // P1-2: 流光溢彩 / cinema lyric style
    if (mode === 'stage') {
      if (typeof global.setLyricStyle === 'function') {
        try {
          global.setLyricStyle(1);
          ok = true;
        } catch (_) {
          /* ignore */
        }
      }
      clickBySelector('#lsb1') ||
        clickBySelector('[data-lyric-style="1"]') ||
        clickBySelector('button[onclick*="setLyricStyle(1"]');
      if (typeof global.setLyricDisplayMode === 'function') {
        try {
          global.setLyricDisplayMode('cinema');
        } catch (_) {
          /* ignore */
        }
      }
    }
    return ok;
  }

  /**
   * P1-5: unlock DIY so stage probes / #fx-fab work, but do not leave the
   * Windows FX console open on the car play surface (phone-density chrome).
   */
  function ensureDiyForStage(mode) {
    if (mode !== 'stage') return false;
    var unlocked = false;
    try {
      if (global.diyPlayerMode === true) unlocked = true;
    } catch (_) {
      /* ignore */
    }
    if (!unlocked && typeof global.toggleDiyMode === 'function') {
      try {
        if (!global.diyPlayerMode) global.toggleDiyMode();
        unlocked = !!global.diyPlayerMode;
      } catch (_) {
        /* fall through */
      }
    }
    if (!unlocked) {
      unlocked = !!(
        clickBySelector('#diy-mode-btn') ||
        clickBySelector('[data-diy="on"]') ||
        clickBySelector('button[onclick*="toggleDiyMode"]')
      );
    }
    collapseCarChrome({ keepFxClosed: true });
    return unlocked;
  }

  /**
   * Car UX: keep Windows visual language, but collapse phone-density chrome
   * that should not sit on the playing surface (search tabs, FX panel, etc.).
   */
  function collapseCarChrome(options) {
    var opts = options || {};
    try {
      if (global.document && global.document.body) {
        if (opts.keepFxClosed !== false) {
          global.document.body.classList.remove('car-fx-open');
        }
        if (opts.closeSearch !== false) {
          global.document.body.classList.remove('car-search-open');
        }
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (opts.closeSearch !== false && typeof global.closeSearchPanel === 'function') {
        global.closeSearchPanel();
      }
    } catch (_) {
      /* ignore */
    }
    try {
      var panel = global.document && global.document.getElementById('fx-panel');
      if (panel && opts.keepFxClosed !== false) {
        panel.classList.remove('open', 'is-open', 'show', 'visible');
        panel.setAttribute('aria-hidden', 'true');
      }
    } catch (_) {
      /* ignore */
    }
  }

  /** Wire search focus + FX fab so secondary surfaces open with car-scale UX. */
  function installCarChromeHooks() {
    if (global.__mineradioCarChromeHooks) return;
    global.__mineradioCarChromeHooks = true;
    var doc = global.document;
    if (!doc) return;

    function onSearchFocus() {
      try {
        if (doc.body) doc.body.classList.add('car-search-open');
      } catch (_) {
        /* ignore */
      }
    }
    function onSearchBlur() {
      global.setTimeout(function () {
        try {
          var area = doc.getElementById('search-area');
          if (area && area.contains(doc.activeElement)) return;
          if (doc.body) doc.body.classList.remove('car-search-open');
        } catch (_) {
          /* ignore */
        }
      }, 120);
    }
    try {
      var input = doc.getElementById('search-input');
      if (input) {
        input.addEventListener('focus', onSearchFocus, true);
        input.addEventListener('blur', onSearchBlur, true);
      }
    } catch (_) {
      /* ignore */
    }

    try {
      var fab = doc.getElementById('fx-fab');
      if (fab) {
        fab.addEventListener(
          'click',
          function () {
            try {
              if (!doc.body) return;
              // Stage/cruise only; drive CSS hides fab.
              doc.body.classList.toggle('car-fx-open');
            } catch (_) {
              /* ignore */
            }
          },
          true,
        );
      }
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * P2-5: showcase lyric palette via silent FX state only.
   * Never call setLyricHighlightCustom / color pickers — APK shows a floating
   * 「高亮颜色」chip that fights car play-surface chrome.
   */
  function applyLyricShowcaseColors(mode) {
    if (mode !== 'stage') return;
    try {
      if (global.fx) {
        if ('lyricHighlight' in global.fx) global.fx.lyricHighlight = '#fac900';
        if ('lyricGlowColor' in global.fx) global.fx.lyricGlowColor = '#00f5d4';
        if ('lyricGlow' in global.fx && typeof global.fx.lyricGlow === 'string') {
          global.fx.lyricGlow = '#00f5d4';
        }
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (typeof global.syncFxUniforms === 'function') global.syncFxUniforms();
    } catch (_) {
      /* ignore */
    }
  }

  /** P1-6: visible probe health for remote debug / adb logcat. */
  function reportStageHealth(mode, budget) {
    var health = {
      mode: mode,
      showcase: !!(budget && budget.showcase),
      ts: Date.now(),
      preset: null,
      quality: null,
      qualityBtn: null,
      shelf: null,
      shelfBtn: null,
      coverRes: null,
      particleLyrics: null,
      cinema: null,
      floatLayer: null,
      diy: null,
    };
    try {
      if (global.fx) {
        health.preset = global.fx.preset;
        health.shelf = global.fx.shelf;
        health.coverRes = global.fx.coverResolution;
        health.particleLyrics = global.fx.particleLyrics;
        health.cinema = global.fx.cinema;
        health.floatLayer = global.fx.floatLayer;
      }
      health.quality = global.currentRenderQuality || null;
      health.diy = global.diyPlayerMode;
    } catch (_) {
      /* ignore */
    }
    try {
      var qb = global.document.querySelector('#render-quality-seg button.active');
      health.qualityBtn = qb ? qb.getAttribute('data-rq') : null;
      var sb = global.document.querySelector('#shelf-seg button.active');
      health.shelfBtn = sb ? sb.getAttribute('data-shelf') : null;
    } catch (_) {
      /* ignore */
    }
    try {
      global.__mineradioCarStageHealth = health;
      if (global.console && console.info) {
        console.info('[MineradioCarVisual] stage-health', health);
      }
    } catch (_) {
      /* ignore */
    }
    // One soft toast on stage showcase apply (avoid spam on every reassert).
    try {
      if (
        mode === 'stage' &&
        budget &&
        budget.showcase &&
        !global.__mineradioCarStageToastShown &&
        typeof global.showToast === 'function'
      ) {
        var okShelf = health.shelf === 'stage' || health.shelfBtn === 'stage';
        var okQ = health.quality === 'ultra' || health.qualityBtn === 'ultra' || health.qualityBtn === 'fine';
        global.showToast(okShelf && okQ ? '舞台已就绪' : '舞台已应用');
        global.__mineradioCarStageToastShown = true;
        global.setTimeout(function () {
          global.__mineradioCarStageToastShown = false;
        }, 12000);
      }
    } catch (_) {
      /* ignore */
    }
    return health;
  }

  /**
   * P2-1: if showcase ultra melts the SoC, step quality down once (keep visual toggles).
   * Best-effort: uses rAF frame-time samples for ~1.2s after stage apply.
   */
  function maybeThrottleShowcaseQuality(mode) {
    if (mode !== 'stage' || global.__mineradioCarPerfGuardArmed) return;
    global.__mineradioCarPerfGuardArmed = true;
    var samples = [];
    var last = 0;
    var frames = 0;
    function tick(now) {
      if (last) samples.push(now - last);
      last = now;
      frames += 1;
      if (frames < 40) {
        global.requestAnimationFrame(tick);
        return;
      }
      global.__mineradioCarPerfGuardArmed = false;
      if (!samples.length) return;
      var sum = 0;
      for (var i = 0; i < samples.length; i += 1) sum += samples[i];
      var avg = sum / samples.length;
      // ~24fps or worse average → step down from ultra
      if (avg > 42) {
        var cur = normalizeMode(
          global.document.documentElement && global.document.documentElement.getAttribute(ATTR),
        );
        if (cur !== 'stage') return;
        applyQuality('fine');
        try {
          if (global.console && console.info) {
            console.info('[MineradioCarVisual] perf-guard: ultra→fine avgFrameMs=', avg.toFixed(1));
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
    try {
      global.requestAnimationFrame(tick);
    } catch (_) {
      global.__mineradioCarPerfGuardArmed = false;
    }
  }

  /** P0-3: write numeric/bool budget straight into global.fx then sync. */
  function writeFxBudget(budget) {
    if (!budget || !global.fx || typeof global.fx !== 'object') return false;
    var map = {
      intensity: budget.intensity,
      cinemaShake: budget.cineshake,
      bloomStrength: budget.bloom,
      coverResolution: budget.coverRes,
      depth: budget.depth,
      lyricGlowStrength: budget.lyricGlow,
      point: budget.point,
      speed: budget.speed,
      twist: budget.twist,
      scatter: budget.scatter,
      bgFade: budget.bgfade,
      backgroundOpacity: budget.bgopacity,
      color: budget.color,
    };
    Object.keys(map).forEach(function (k) {
      if (map[k] == null || !isFinite(Number(map[k]))) return;
      try {
        if (k in global.fx || true) global.fx[k] = Number(map[k]);
      } catch (_) {
        /* ignore */
      }
    });
    // Common alternate field names seen in APK shells
    try {
      if ('cineshake' in global.fx && budget.cineshake != null) {
        global.fx.cineshake = Number(budget.cineshake);
      }
      if ('bloom' in global.fx && budget.bloom != null) global.fx.bloom = Number(budget.bloom);
      if ('lyricGlow' in global.fx && budget.lyricGlow != null) {
        global.fx.lyricGlow = Number(budget.lyricGlow);
      }
      if ('bgopacity' in global.fx && budget.bgopacity != null) {
        global.fx.bgopacity = Number(budget.bgopacity);
      }
      if ('bgfade' in global.fx && budget.bgfade != null) {
        global.fx.bgfade = Number(budget.bgfade);
      }
    } catch (_) {
      /* ignore */
    }
    if (budget.fxOn) {
      Object.keys(budget.fxOn).forEach(function (k) {
        if (budget.fxOn[k]) global.fx[k] = true;
      });
    }
    if (budget.fxOff) {
      Object.keys(budget.fxOff).forEach(function (k) {
        if (budget.fxOff[k]) global.fx[k] = false;
      });
    }
    return true;
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
    setRangeIfPresent('fx-depth', budget.depth);
    setRangeIfPresent('fx-lyricglow', budget.lyricGlow);
    setRangeIfPresent('fx-point', budget.point);
    setRangeIfPresent('fx-speed', budget.speed);
    setRangeIfPresent('fx-twist', budget.twist);
    setRangeIfPresent('fx-scatter', budget.scatter);
    setRangeIfPresent('fx-bgfade', budget.bgfade);
    setRangeIfPresent('fx-bgopacity', budget.bgopacity);
    if (budget.color != null) setRangeIfPresent('fx-color', budget.color);
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
    // P0-5: never let save* throw or block stage re-assert (SPICa may still fail).
    try {
      callGlobal('syncFxUniforms');
    } catch (_) {
      /* ignore */
    }
    try {
      callGlobal('updateFxInputs');
    } catch (_) {
      /* ignore */
    }
    try {
      if (typeof global.saveFxState === 'function') global.saveFxState();
    } catch (_) {
      /* best-effort only */
    }
    try {
      if (typeof global.saveLyricLayout === 'function') global.saveLyricLayout();
    } catch (_) {
      /* best-effort only */
    }
    try {
      if (typeof global.applyRenderQualityLevels === 'function' && global.currentRenderQuality) {
        global.applyRenderQualityLevels(global.currentRenderQuality);
      }
      if (typeof global.applyRendererPowerMode === 'function') {
        global.applyRendererPowerMode();
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (global.fx && global.fx.floatLayer && typeof global.createFloatLayer === 'function') {
        global.createFloatLayer();
      }
    } catch (_) {
      /* ignore */
    }
  }

  function tryApplyDefaultTestArchive() {
    // Best-effort whole-snapshot path if the APK exposes archive apply helpers.
    var names = [
      'applyUserFxArchive',
      'applyFxArchiveSnapshot',
      'applyPackagedFxArchive',
      'loadDefaultUserFxArchive',
    ];
    for (var i = 0; i < names.length; i += 1) {
      if (typeof global[names[i]] !== 'function') continue;
      try {
        global[names[i]]('默认测试');
        return true;
      } catch (_) {
        try {
          global[names[i]](0);
          return true;
        } catch (_2) {
          /* try next */
        }
      }
    }
    return false;
  }

  function applyFxProbes(mode, budget) {
    // 0) Optional full snapshot, then explicit preset (emily) wins for stage identity.
    if (mode === 'stage' || mode === 'cruise') {
      tryApplyDefaultTestArchive();
    }

    // 1) Preset first — setPreset can reset coverResolution / visual knobs.
    if (mode === 'stage' || mode === 'cruise') {
      applyPreset(budget.preset);
    }

    // 2) Quality before cover rebuild so DPR/texture budget is already high.
    applyQuality(budget.quality);

    // 3) Direct fx write (P0-3) then DOM sliders for UI sync.
    writeFxBudget(budget);
    applySliders(budget);

    // 4) Cover sharpness after preset + quality (emily critical path).
    applyCoverResolutionSharp(budget.coverRes != null ? budget.coverRes : 2.2);
    writeFxBudget(budget);
    applyCoverResolutionSharp(budget.coverRes != null ? budget.coverRes : 2.2);

    applyFxKeyMap(budget.fxOn, true);
    applyFxKeyMap(budget.fxOff, false);
    writeFxBudget(budget);
    applyShelf(budget);

    // P0-2 / P1-2 particle + 流光 lyrics
    applyParticleLyrics(mode);
    applyLyricShowcaseColors(mode);

    // P1-5 DIY so FX console is reachable on stage (panel stays closed on car).
    ensureDiyForStage(mode);
    collapseCarChrome({ keepFxClosed: true, closeSearch: true });

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

    // Cam / gesture stays off for cockpit safety even on stage.
    clickBySelector('#cam-seg button[data-cam="off"]');

    // Keep lyrics visible on sonic topography if that control exists.
    clickBySelector('#st-showLyrics-seg button[data-val="true"]');

    persistFxIfPossible();
    reportStageHealth(mode, budget);
    if (mode === 'stage') maybeThrottleShowcaseQuality(mode);

    // 5) Delayed cover + shelf + lyrics reload after late shell bind.
    if (mode === 'stage' || mode === 'cruise') {
      global.setTimeout(function () {
        var current = normalizeMode(
          global.document.documentElement && global.document.documentElement.getAttribute(ATTR),
        );
        if (current !== mode) return;
        applyCoverResolutionSharp(budget.coverRes != null ? budget.coverRes : 2.2);
        if (!shelfLooksApplied(budget)) applyShelf(budget);
        applyParticleLyrics(mode);
        applyLyricShowcaseColors(mode);
        ensureDiyForStage(mode);
        collapseCarChrome({ keepFxClosed: true, closeSearch: true });
        persistFxIfPossible();
        reportStageHealth(mode, budget);
      }, 700);
    }
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
        // P0-4: extra shelf re-assert if still not stage
        if (mode === 'stage' && !shelfLooksApplied(budget)) {
          applyShelf(budget);
        }
      }, delay);
    });
  }

  function reassertIfStageLike(reason) {
    var mode = normalizeMode(
      (global.document &&
        global.document.documentElement &&
        global.document.documentElement.getAttribute(ATTR)) ||
        readStoredMode(),
    );
    if (mode !== 'stage' && mode !== 'cruise') return;
    // Don't stomp a navigation duck with full showcase mid-interrupt.
    if (audioDuckActive && reason && String(reason).indexOf('unduck') !== 0) {
      return;
    }
    applyFxProbes(mode, MODE_BUDGET[mode]);
  }

  /**
   * Audio duck — when nav/phone steals focus or media pauses, dim stage visuals
   * without leaving showcase mode. Restores on play / visible.
   * (Web-layer; native AudioFocusManager lives in APK media3 and is not patched.)
   */
  var audioDuckActive = false;
  var audioDuckReason = '';
  var DUCK_BUDGET = {
    particleOpacity: 0.2,
    scrim: 0.58,
    cineshake: 0,
    intensity: 0.22,
    bloom: 0.15,
    lyricGlow: 0.12,
  };

  function applyDuckCss(on) {
    var root = global.document && global.document.documentElement;
    var body = global.document && global.document.body;
    if (body) body.classList.toggle('car-audio-duck', !!on);
    if (!root) return;
    if (on) {
      root.style.setProperty('--car-particle-opacity', String(DUCK_BUDGET.particleOpacity));
      root.style.setProperty('--car-stage-scrim', String(DUCK_BUDGET.scrim));
    } else {
      var mode = normalizeMode(root.getAttribute(ATTR) || readStoredMode());
      var budget = MODE_BUDGET[mode] || MODE_BUDGET.drive;
      setCssBudget(budget);
    }
  }

  function setAudioDuck(on, reason) {
    on = !!on;
    var mode = normalizeMode(
      (global.document &&
        global.document.documentElement &&
        global.document.documentElement.getAttribute(ATTR)) ||
        readStoredMode(),
    );
    // Only duck immersive modes; drive is already quiet.
    if (on && mode === 'drive') {
      audioDuckActive = false;
      return false;
    }
    if (audioDuckActive === on) {
      audioDuckReason = reason || audioDuckReason;
      return on;
    }
    audioDuckActive = on;
    audioDuckReason = reason || '';
    applyDuckCss(on);
    if (on) {
      setRangeIfPresent('fx-intensity', DUCK_BUDGET.intensity);
      setRangeIfPresent('fx-cineshake', DUCK_BUDGET.cineshake);
      setRangeIfPresent('fx-bloom', DUCK_BUDGET.bloom);
      setRangeIfPresent('fx-lyricglow', DUCK_BUDGET.lyricGlow);
      try {
        if (global.fx) {
          if ('intensity' in global.fx) global.fx.intensity = DUCK_BUDGET.intensity;
          if ('cinemaShake' in global.fx) global.fx.cinemaShake = 0;
          if ('cinema' in global.fx) global.fx.cinema = false;
        }
      } catch (_) {
        /* ignore */
      }
      try {
        callGlobal('syncFxUniforms');
      } catch (_) {
        /* ignore */
      }
      try {
        if (global.console && console.info) {
          console.info('[MineradioCarVisual] audio-duck on', reason);
        }
      } catch (_2) {
        /* ignore */
      }
    } else {
      reassertIfStageLike('unduck:' + (reason || ''));
      try {
        if (global.console && console.info) {
          console.info('[MineradioCarVisual] audio-duck off', reason);
        }
      } catch (_3) {
        /* ignore */
      }
    }
    try {
      global.dispatchEvent(
        new CustomEvent('mineradio:car-audio-duck', {
          detail: { duck: on, reason: reason || '', mode: mode },
        }),
      );
    } catch (_) {
      /* ignore */
    }
    return on;
  }

  function anyMediaPlaying() {
    try {
      var nodes = global.document.querySelectorAll('audio, video');
      for (var i = 0; i < nodes.length; i += 1) {
        var el = nodes[i];
        if (!el.paused && !el.ended && el.readyState > 2) return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function installAudioDuckHooks() {
    if (global.__mineradioCarAudioDuckHooks) return;
    global.__mineradioCarAudioDuckHooks = true;

    function onPause() {
      // Delay: brief seeks shouldn't duck.
      global.setTimeout(function () {
        if (!anyMediaPlaying()) setAudioDuck(true, 'media-pause');
      }, 280);
    }
    function onPlay() {
      setAudioDuck(false, 'media-play');
    }
    function bindMedia(el) {
      if (!el || el.__mineradioCarDuckBound) return;
      el.__mineradioCarDuckBound = true;
      try {
        el.addEventListener('pause', onPause);
        el.addEventListener('play', onPlay);
        el.addEventListener('playing', onPlay);
        el.addEventListener('volumechange', function () {
          if (el.muted || el.volume === 0) setAudioDuck(true, 'volume-zero');
          else if (!el.paused) setAudioDuck(false, 'volume-restore');
        });
      } catch (_) {
        /* ignore */
      }
    }

    try {
      var existing = global.document.querySelectorAll('audio, video');
      for (var i = 0; i < existing.length; i += 1) bindMedia(existing[i]);
    } catch (_) {
      /* ignore */
    }

    try {
      var mo = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m += 1) {
          var nodes = mutations[m].addedNodes || [];
          for (var n = 0; n < nodes.length; n += 1) {
            var node = nodes[n];
            if (!node || node.nodeType !== 1) continue;
            if (node.matches && (node.matches('audio') || node.matches('video'))) bindMedia(node);
            if (node.querySelectorAll) {
              var nested = node.querySelectorAll('audio, video');
              for (var k = 0; k < nested.length; k += 1) bindMedia(nested[k]);
            }
          }
        }
      });
      mo.observe(global.document.documentElement, { childList: true, subtree: true });
    } catch (_) {
      /* ignore */
    }

    // Document hide often tracks multi-window / nav overlay on car HMIs.
    try {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.hidden) setAudioDuck(true, 'document-hidden');
        else if (anyMediaPlaying()) setAudioDuck(false, 'document-visible');
      });
      global.addEventListener('blur', function () {
        global.setTimeout(function () {
          if (!anyMediaPlaying() || global.document.hidden) setAudioDuck(true, 'window-blur');
        }, 200);
      });
      global.addEventListener('focus', function () {
        if (anyMediaPlaying()) setAudioDuck(false, 'window-focus');
      });
    } catch (_) {
      /* ignore */
    }

    // Poll as safety net for media sessions that don't emit pause reliably.
    global.setInterval(function () {
      var mode = normalizeMode(
        (global.document &&
          global.document.documentElement &&
          global.document.documentElement.getAttribute(ATTR)) ||
          'drive',
      );
      if (mode === 'drive') return;
      if (global.document.hidden) {
        setAudioDuck(true, 'poll-hidden');
        return;
      }
      if (!anyMediaPlaying() && audioDuckActive === false) {
        // stay unducked when idle on home with no media — don't force duck
        return;
      }
      if (!anyMediaPlaying() && audioDuckActive) {
        // keep duck while paused after interrupt
        return;
      }
      if (anyMediaPlaying() && audioDuckActive) {
        setAudioDuck(false, 'poll-playing');
      }
    }, 2500);
  }

  /**
   * Mode switch (行车/巡航/舞台) removed from car play surface.
   * Showcase stage is the fixed car visual budget; API setMode remains for debug.
   */
  function ensureModeSwitch() {
    var doc = global.document;
    if (!doc) return null;
    var existing = doc.getElementById('car-visual-mode-switch');
    if (existing && existing.parentNode) {
      try {
        existing.parentNode.removeChild(existing);
      } catch (_) {
        /* ignore */
      }
    }
    return null;
  }

  function syncSwitchUi(/* mode */) {
    /* no-op: on-screen mode switch removed */
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
    installCoverSharpnessHooks();
    installAudioDuckHooks();
    installCarChromeHooks();
    ensureModeSwitch();
    collapseCarChrome({ keepFxClosed: true, closeSearch: true });
    // Fixed showcase stage on car (no 行车/巡航/舞台 chrome).
    var initial = 'stage';
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, 'stage');
    } catch (_) {
      /* ignore */
    }
    setMode(initial, { persist: true });

    // After splash → home, re-assert once more for late APK shell bind.
    global.setTimeout(function () {
      reassertIfStageLike('boot+6s');
    }, 6000);

    // P0-5: re-apply stage FX after resume / tab show / playback start (SPICa may drop FX).
    try {
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden && !audioDuckActive) reassertIfStageLike('visibility');
      });
      global.addEventListener('pageshow', function () {
        if (!audioDuckActive) reassertIfStageLike('pageshow');
      });
      global.document.addEventListener(
        'play',
        function () {
          setAudioDuck(false, 'capture-play');
          reassertIfStageLike('play');
        },
        true,
      );
      global.document.addEventListener(
        'pause',
        function () {
          global.setTimeout(function () {
            if (!anyMediaPlaying()) setAudioDuck(true, 'capture-pause');
          }, 280);
        },
        true,
      );
    } catch (_) {
      /* ignore */
    }

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
    reassertIfStageLike: reassertIfStageLike,
    setAudioDuck: setAudioDuck,
    isAudioDuckActive: function () {
      return !!audioDuckActive;
    },
    reportStageHealth: function () {
      var mode = normalizeMode(
        (global.document &&
          global.document.documentElement &&
          global.document.documentElement.getAttribute(ATTR)) ||
          readStoredMode(),
      );
      return reportStageHealth(mode, MODE_BUDGET[mode]);
    },
    budgets: MODE_BUDGET,
  };

  global.MineradioCarVisual = api;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
