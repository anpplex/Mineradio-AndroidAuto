#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PASSPHRASE = Buffer.from('Sp1ca@Minerad1o#2024$SecureAssetKey!', 'ascii');
const KEY = crypto.createHash('sha256').update(PASSPHRASE).digest();
const MAGIC = Buffer.from('MENC', 'ascii');
const CAR_HMI_STYLESHEET_NAME = 'car-hmi.css';
const CAR_VISUAL_RUNTIME_NAME = 'car-visual-runtime.js';
const CAR_LOGIN_ENTRY_ID = 'car-login-entry';
const CAR_LOGIN_ENTRY = `<button type="button" id="${CAR_LOGIN_ENTRY_ID}" aria-label="网易云扫码登录" title="网易云扫码登录" onclick="showLoginModal()">网易云扫码登录</button>`;

const CAR_VISUAL_RUNTIME_SOURCE = fs.readFileSync(
  path.join(__dirname, 'car-visual-runtime.js'),
  'utf8',
);

/*
 * Project car-HMI + visual-mode targets for Huawei ICHU3200E15-ADV:
 * physical 1920x1080 @ 320dpi, WebView width=device-width → ≈960x540 CSS px.
 * Not an OEM certification claim.
 *
 * Visual stack:
 *   drive  — music-class driving safety (default)
 *   cruise — identity-preserving balance
 *   stage  — maximize Mineradio open / free / stunning stage
 */
const CAR_HMI_STYLESHEET = String.raw`/* Mineradio car HMI + visual-mode overlay (CSS px, density-scaled).
 *
 * Design policy:
 *   - Keep Windows Mineradio visual language (glass panels, teal accent,
 *     particle stage, control chrome look).
 *   - Optimize UX for Android car HMI (type scale, touch targets, fewer
 *     always-on controls) — not a phone Material density transplant.
 */
:root {
  --car-space-12: 12px;
  --car-space-16: 16px;
  --car-space-20: 20px;
  --car-space-24: 24px;
  --car-space-32: 32px;
  /* Car touch: phone 48 is too small at arm's length. */
  --car-touch-target: 64px;
  --car-primary-action: 76px;
  /* System chrome clearance (Huawei status bar + bottom Docker). CSS px @ ~960. */
  --car-safe-top: 28px;
  --car-safe-bottom: 48px;
  /* Corner chrome: TL nav cluster + BL FX (mode switch removed). */
  --car-corner-inset: 20px;
  --car-corner-btn: 72px;
  --car-corner-icon: 30px;
  --car-corner-gap: 12px;
  /* Car type: glanceable at ~50–80cm. */
  --car-type-caption: 16px;
  --car-type-body: 18px;
  --car-type-title: 24px;
  --car-type-control: 18px;
  /* Windows look tokens (color/material — do not restyle to OEM flat). */
  --car-panel: rgba(10, 15, 23, .92);
  --car-panel-strong: rgba(8, 12, 19, .97);
  --car-text-primary: rgba(255, 255, 255, .98);
  --car-text-secondary: rgba(234, 243, 247, .78);
  --car-accent: #0ccdbf;
  --car-accent-ink: #041312;
  --car-particle-opacity: .34;
  --car-stage-scrim: .26;
  --car-lyric-scale-boost: 1;
  --car-reduce-motion: 0;
}

/* 900 CSS px ≈ 1800 physical px @ 320dpi; covers the 960 CSS-wide car WebView. */
@media (min-width: 900px) and (min-height: 480px) {
  html, body { font-size: 18px; }

  /* ——— Shell / navigation ——— */
  #empty-home, #home-empty, .empty-home, .home-page {
    top: calc(var(--car-safe-top) + var(--car-corner-btn) + var(--car-space-20)) !important;
    bottom: calc(var(--car-safe-bottom) + 108px) !important;
    width: min(920px, calc(100vw - 48px)) !important;
  }
  .empty-home-shell, .home-shell, .home-layout {
    grid-template-columns: minmax(280px, .95fr) minmax(420px, 1.35fr) !important;
    grid-template-rows: minmax(0, 1fr) !important;
    gap: var(--car-space-16) !important;
  }
  .home-hero { grid-row: 1 !important; }

  #search-area, .search-area {
    top: 16px !important;
    opacity: 1 !important;
    pointer-events: auto !important;
  }
  #search-stack { width: min(360px, 42vw) !important; }
  #search-box, .search-box {
    min-height: var(--car-touch-target) !important;
    height: var(--car-touch-target) !important;
    padding-inline: 20px !important;
    border-radius: 22px !important;
    background: var(--car-panel-strong) !important;
    border-color: rgba(255, 255, 255, .20) !important;
  }
  #search-icon { width: 24px !important; height: 24px !important; margin-right: 12px !important; }
  #search-input, .search-input {
    font-size: var(--car-type-body) !important;
    font-weight: 560 !important;
  }
  #search-input::placeholder { color: rgba(255, 255, 255, .62) !important; }
  /* Car: platform tabs (All/NE/QQ…) only when search is focused — not always-on desktop chrome. */
  #search-mode-tabs,
  #search-close-btn,
  #upload-actions {
    display: none !important;
  }
  #search-area:focus-within #search-mode-tabs,
  body.car-search-open #search-mode-tabs {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 6px !important;
    margin-top: 8px !important;
  }
  #search-area:focus-within #search-close-btn,
  body.car-search-open #search-close-btn {
    display: inline-flex !important;
  }
  /* Beat analysis / cinema-lock chips are desktop status — never primary car chrome. */
  #beat-chip {
    display: none !important;
  }
  /* DIY desktop button; car uses #fx-fab only. */
  #diy-mode-btn,
  .desktop-mode-btn {
    display: none !important;
  }
  #version-label,
  #mobile-update-entry,
  #user-capsule-hide-btn,
  #playlist-hide-btn,
  #fx-fab-hide-btn {
    display: none !important;
  }
  /* Announcement is low-frequency on car. */
  #announcement-entry {
    display: none !important;
  }
  /* Color chips / pickers only when FX console is intentionally open. */
  body:not(.car-fx-open) #lyric-highlight-value,
  body:not(.car-fx-open) #lyric-glow-value,
  body:not(.car-fx-open) .lyric-color-value,
  body:not(.car-fx-open) .fx-color-row-label,
  body:not(.car-fx-open) #lyric-highlight-picker,
  body:not(.car-fx-open) #lyric-glow-picker,
  body:not(.car-fx-open) #ui-accent-picker,
  body:not(.car-fx-open) #ui-accent-value,
  body:not(.car-fx-open) #lyric-highlight-auto-btn {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

  .home-grid, .home-quick-grid, .home-cards, .dashboard-grid {
    grid-template-rows: repeat(3, minmax(0, 1fr)) !important;
    height: 100% !important;
    gap: var(--car-space-16) !important;
  }
  .home-card, .dashboard-card, .quick-card, .home-tile {
    min-height: 120px !important;
    padding: 18px 20px !important;
    border-radius: 18px !important;
    background: var(--car-panel) !important;
    border-color: rgba(255, 255, 255, .18) !important;
    box-shadow: 0 10px 28px rgba(0, 0, 0, .32) !important;
  }
  .home-card-label, .dashboard-card-label, .card-label, .home-kicker {
    display: none !important;
  }
  .home-card-title, .dashboard-card-title, .card-title, .home-tile-title {
    color: var(--car-text-primary) !important;
    font-size: var(--car-type-title) !important;
    line-height: 1.2 !important;
    font-weight: 720 !important;
  }
  .home-card-sub, .dashboard-card-sub, .card-sub, .home-tile-sub {
    margin-top: 10px !important;
    color: var(--car-text-secondary) !important;
    font-size: var(--car-type-body) !important;
    line-height: 1.4 !important;
  }
  .home-card-art { width: 80px !important; height: 80px !important; right: 14px !important; bottom: 14px !important; }

  #home-recent-panel, .home-hero, .recent-play-card, .recent-card, .home-recent {
    background: var(--car-panel) !important;
    border-color: rgba(255, 255, 255, .20) !important;
    border-radius: 20px !important;
    padding: 18px !important;
  }
  #home-recent-panel { max-width: none !important; }
  .home-recent-title, .home-title, .recent-title, .recent-play-title {
    color: var(--car-text-primary) !important;
    font-size: var(--car-type-title) !important;
    line-height: 1.18 !important;
  }
  .home-recent-grid { gap: 10px !important; }
  .home-recent-item { min-height: var(--car-touch-target) !important; padding: 10px 14px !important; }
  .home-recent-empty, .home-sub, .recent-empty, .recent-play-empty {
    color: var(--car-text-secondary) !important;
    font-size: var(--car-type-body) !important;
    line-height: 1.45 !important;
  }

  /*
   * Corner chrome — car + Mac play-surface IA:
   *   TL: playlist + home
   *   BL: visual console (FX)  — was BR; mode switch removed
   *   TR: empty on play (login only on empty home, top-right)
   * Safe top/bottom clear status bar + Docker.
   */
  #playlist-toggle,
  #home-btn,
  #fx-fab {
    position: fixed !important;
    z-index: 32 !important;
    box-sizing: border-box !important;
    width: var(--car-corner-btn) !important;
    height: var(--car-corner-btn) !important;
    min-width: var(--car-corner-btn) !important;
    min-height: var(--car-corner-btn) !important;
    max-width: var(--car-corner-btn) !important;
    max-height: var(--car-corner-btn) !important;
    padding: 0 !important;
    margin: 0 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 50% !important;
    border: 1px solid rgba(255, 255, 255, .18) !important;
    background: var(--car-panel-strong) !important;
    color: var(--car-text-primary) !important;
    box-shadow: 0 10px 28px rgba(0, 0, 0, .36) !important;
    -webkit-tap-highlight-color: transparent;
  }
  /* TL — Home left, playlist/list right (Mac-like nav order) */
  #home-btn {
    top: calc(var(--car-safe-top) + 8px) !important;
    left: var(--car-corner-inset) !important;
    right: auto !important;
    bottom: auto !important;
  }
  #playlist-toggle {
    top: calc(var(--car-safe-top) + 8px) !important;
    left: calc(var(--car-corner-inset) + var(--car-corner-btn) + var(--car-corner-gap)) !important;
    right: auto !important;
    bottom: auto !important;
  }
  /*
   * #home-btn lives under #top-right in APK DOM — cannot display:none the wrapper
   * or Home vanishes. Zero-size host; Home is position:fixed to TL cluster.
   */
  #top-right {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: auto !important;
    bottom: auto !important;
    z-index: 32 !important;
    display: block !important;
    width: 0 !important;
    height: 0 !important;
    overflow: visible !important;
    padding: 0 !important;
    margin: 0 !important;
    border: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    pointer-events: none !important;
  }
  #top-right #home-btn {
    pointer-events: auto !important;
  }
  /*
   * Visual console — bottom floating capsule (Mac label + car hit size).
   * Panel opens as bottom sheet (not right dock).
   */
  #fx-fab {
    top: auto !important;
    left: 50% !important;
    right: auto !important;
    bottom: calc(var(--car-safe-bottom) + 108px + var(--car-space-12)) !important;
    width: auto !important;
    min-width: 172px !important;
    max-width: none !important;
    height: 56px !important;
    min-height: 56px !important;
    max-height: 56px !important;
    padding: 0 22px 0 18px !important;
    gap: 10px !important;
    border-radius: 999px !important;
    transform: translateX(-50%) !important;
    flex-direction: row !important;
  }
  #fx-fab::after {
    content: '视觉控制台';
    font-size: 16px !important;
    font-weight: 720 !important;
    letter-spacing: .02em !important;
    color: var(--car-text-primary) !important;
    white-space: nowrap !important;
    line-height: 1 !important;
  }
  body.car-fx-open #fx-fab {
    bottom: calc(var(--car-safe-bottom) + min(58vh, 480px) + 20px) !important;
  }
  #fx-fab-hide-btn { display: none !important; }
  /* Plugin install — extreme bottom-right */
  #plugin-fab {
    position: fixed !important;
    z-index: 33 !important;
    top: auto !important;
    left: auto !important;
    right: var(--car-corner-inset) !important;
    bottom: calc(var(--car-safe-bottom) + 12px) !important;
    width: var(--car-corner-btn) !important;
    height: var(--car-corner-btn) !important;
    min-width: var(--car-corner-btn) !important;
    min-height: var(--car-corner-btn) !important;
    padding: 0 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 50% !important;
    border: 1px solid rgba(255, 255, 255, .18) !important;
    background: var(--car-panel-strong) !important;
    color: var(--car-text-primary) !important;
    box-shadow: 0 10px 28px rgba(0, 0, 0, .36) !important;
  }
  #plugin-fab svg {
    width: var(--car-corner-icon) !important;
    height: var(--car-corner-icon) !important;
  }
  /* Mode switch permanently off the play surface */
  #car-visual-mode-switch {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
    width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
  }
  #playlist-toggle svg,
  #home-btn svg,
  #fx-fab svg,
  #announcement-entry svg {
    width: var(--car-corner-icon) !important;
    height: var(--car-corner-icon) !important;
    flex-shrink: 0 !important;
  }
  #fx-fab svg {
    width: 24px !important;
    height: 24px !important;
  }
  #announcement-entry,
  #bottom-bar-close-btn {
    width: var(--car-touch-target) !important;
    height: var(--car-touch-target) !important;
    min-width: var(--car-touch-target) !important;
    min-height: var(--car-touch-target) !important;
  }

  /* Login CTA only on empty home — top-right, clear of TL nav cluster. */
  #car-login-entry {
    position: fixed !important;
    z-index: 32 !important;
    top: calc(var(--car-safe-top) + 8px) !important;
    right: var(--car-corner-inset) !important;
    left: auto !important;
    min-width: 160px !important;
    height: var(--car-corner-btn) !important;
    min-height: var(--car-corner-btn) !important;
    padding: 0 20px !important;
    display: none !important;
    align-items: center !important;
    justify-content: center !important;
    border: 1px solid rgba(96, 255, 231, .50) !important;
    border-radius: 999px !important;
    background: var(--car-accent) !important;
    color: var(--car-accent-ink) !important;
    font-size: var(--car-type-control) !important;
    font-weight: 720 !important;
    letter-spacing: .02em !important;
    line-height: 1 !important;
    white-space: nowrap !important;
    box-shadow: 0 10px 28px rgba(0, 0, 0, .34) !important;
  }
  body.empty-home-active #car-login-entry {
    display: inline-flex !important;
  }
  #trial-banner {
    top: calc(var(--car-safe-top) + var(--car-corner-btn) + var(--car-space-16)) !important;
    left: auto !important;
    right: var(--car-corner-inset) !important;
    transform: translateY(-8px) !important;
    min-height: var(--car-touch-target) !important;
    padding: 10px 16px !important;
    border-radius: 14px !important;
    font-size: var(--car-type-body) !important;
    background: var(--car-panel-strong) !important;
  }
  #trial-banner.show { transform: translateY(0) !important; }
  #trial-login-btn {
    min-height: var(--car-touch-target) !important;
    padding: 0 16px !important;
    margin-left: 10px !important;
    display: inline-flex !important;
    align-items: center !important;
    border-radius: 12px !important;
    background: var(--car-accent) !important;
    color: var(--car-accent-ink) !important;
    font-size: var(--car-type-control) !important;
    font-weight: 760 !important;
  }

  /*
   * Transport bar — Mac layout: cover+meta | 臻音/心/+ | transport | 词/音量/调声/时间
   * Car hit sizes; hide only low-frequency desktop chrome.
   */
  #bottom-bar {
    min-height: 104px !important;
    width: min(960px, calc(100vw - 36px)) !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    bottom: var(--car-safe-bottom) !important;
    padding: 10px 18px 12px !important;
    border-radius: 26px !important;
    background: rgba(8, 12, 19, .88) !important;
    border: 1px solid rgba(255, 255, 255, .12) !important;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .42) !important;
    backdrop-filter: blur(18px) saturate(1.12) !important;
  }
  #bottom-bar #progress-bar {
    height: 6px !important;
    border-radius: 999px !important;
    margin-bottom: 8px !important;
  }
  #bottom-bar #progress-fill {
    border-radius: 999px !important;
  }
  #bottom-bar > #controls {
    display: grid !important;
    grid-template-columns: minmax(160px, 1.1fr) auto minmax(140px, .95fr) !important;
    gap: 10px 14px !important;
    align-items: center !important;
  }
  #bottom-bar .control-track {
    display: flex !important;
    align-items: center !important;
    gap: 12px !important;
    min-width: 0 !important;
  }
  #bottom-bar .control-cover {
    width: 56px !important;
    height: 56px !important;
    min-width: 56px !important;
    border-radius: 12px !important;
  }
  #bottom-bar .control-meta { min-width: 0 !important; max-width: none !important; }
  #bottom-bar .control-title, #bottom-bar .control-artist {
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  #bottom-bar .control-cluster {
    display: inline-flex !important;
    align-items: center !important;
    gap: 8px !important;
  }
  #bottom-bar .control-cluster.transport {
    justify-content: center !important;
    gap: 10px !important;
  }
  #bottom-bar .control-cluster.modes {
    justify-content: flex-end !important;
    flex-wrap: nowrap !important;
  }
  #bottom-bar > #bottom-bar-close-btn,
  #bottom-bar > #controls > .control-cluster > .ctrl-btn,
  #bottom-bar #quality-btn,
  #bottom-bar #eq-btn,
  #bottom-bar #audio-effect-btn,
  #bottom-bar #volume-btn {
    width: var(--car-touch-target) !important;
    height: var(--car-touch-target) !important;
    min-width: var(--car-touch-target) !important;
    min-height: var(--car-touch-target) !important;
    border-radius: 16px !important;
  }
  #bottom-bar #quality-btn.quality-pill,
  #bottom-bar #eq-btn.quality-pill {
    width: auto !important;
    min-width: 72px !important;
    padding: 0 14px !important;
    font-size: 15px !important;
    font-weight: 700 !important;
  }
  #bottom-bar > #bottom-bar-close-btn svg,
  #bottom-bar > #controls > .control-cluster > .ctrl-btn svg,
  #bottom-bar #volume-btn svg {
    width: 26px !important;
    height: 26px !important;
  }
  #play-btn {
    width: var(--car-primary-action) !important;
    height: var(--car-primary-action) !important;
    min-width: var(--car-primary-action) !important;
    min-height: var(--car-primary-action) !important;
    border-radius: 50% !important;
    background: var(--car-accent) !important;
    color: #031111 !important;
  }
  #play-btn svg { width: 32px !important; height: 32px !important; }
  .control-title, #song-title, .now-playing-title, #control-title {
    font-size: var(--car-type-title) !important;
    font-weight: 700 !important;
    color: var(--car-text-primary) !important;
  }
  .control-artist, #artist-name, .now-playing-artist, #control-artist {
    font-size: var(--car-type-body) !important;
    color: var(--car-text-secondary) !important;
  }
  .lyrics-word-icon {
    font-size: 18px !important;
    font-weight: 720 !important;
  }
  /* Mac-visible set; hide only rare desktop tools */
  #bottom-bar #quality-control,
  #bottom-bar #heart-btn,
  #bottom-bar #collect-btn,
  #bottom-bar #play-mode-btn,
  #bottom-bar .lyrics-toggle-btn,
  #bottom-bar #volume-control,
  #bottom-bar #eq-control,
  #bottom-bar #mini-queue-btn {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
  }
  #bottom-bar #refresh-download-btn,
  #bottom-bar #sleep-timer-btn,
  #bottom-bar #audio-effect-control,
  #bottom-bar #controls-hide-btn,
  #bottom-bar #immersive-btn,
  #bottom-bar .fullscreen-toggle-btn,
  #bottom-bar > #bottom-bar-close-btn {
    display: none !important;
  }
  #bottom-bar #time-display {
    min-width: 112px !important;
    font-size: var(--car-type-caption) !important;
    font-variant-numeric: tabular-nums !important;
    color: var(--car-text-secondary) !important;
    white-space: nowrap !important;
  }
  /* Floating thumb (Mac uses bar cover); avoid double chrome on car */
  #thumb-wrap {
    display: none !important;
  }

  /* ——— Visual layer budgets (driven by data-car-visual-mode) ———
   * Do NOT paint WebGL canvases with CSS opacity < 1 on stage: intermediate
   * compositing on Android WebView softens emily cover particles.
   * Drive dims via scrim only; stage keeps canvas fully opaque. */
  #canvas-container,
  #idle-guide-canvas,
  .particle-background,
  #splash-canvas {
    opacity: 1 !important;
    filter: none !important;
    transform: translateZ(0);
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
  }
  #canvas-container::after,
  .particle-background::after {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: rgba(0, 0, 0, var(--car-stage-scrim));
    transition: background .35s ease;
    z-index: 0;
  }

  /* Stage lyrics: keep readable hierarchy on density-scaled glass. */
  #stage-lyrics,
  #lyric-float-stage,
  #lyric-popword-stage {
    transform: scale(var(--car-lyric-scale-boost)) !important;
    transform-origin: center center !important;
  }
  #lyric-float-curr,
  #lyric-popword-line {
    color: var(--car-text-primary) !important;
    text-shadow: 0 2px 18px rgba(0, 0, 0, .55) !important;
  }

  /* Drive budget (API-only; no on-screen mode switch). */
  html[data-car-visual-mode="drive"] body.empty-home-active .home-card,
  body.car-mode-drive.empty-home-active .home-card {
    animation: none !important;
  }
  html[data-car-visual-mode="drive"] #shelf-touch-shield,
  body.car-mode-drive #shelf-touch-shield {
    pointer-events: none !important;
  }
  html[data-car-visual-mode="drive"] body:not(.empty-home-active):not(.car-search-open) #search-area,
  body.car-mode-drive:not(.empty-home-active):not(.car-search-open) #search-area {
    opacity: 0 !important;
    pointer-events: none !important;
  }

  /* Stage: maximize open / free / stunning — full canvas, glass chrome, lyric stage. */
  html[data-car-visual-mode="stage"],
  body.car-mode-stage {
    --car-particle-opacity: 1;
    --car-stage-scrim: 0.02;
  }
  html[data-car-visual-mode="stage"] #canvas-container,
  html[data-car-visual-mode="stage"] #idle-guide-canvas,
  html[data-car-visual-mode="stage"] .particle-background,
  html[data-car-visual-mode="stage"] #splash-canvas,
  body.car-mode-stage #canvas-container,
  body.car-mode-stage #idle-guide-canvas,
  body.car-mode-stage .particle-background,
  body.car-mode-stage #splash-canvas {
    opacity: 1 !important;
    filter: none !important;
  }
  html[data-car-visual-mode="stage"] #canvas-container::after,
  html[data-car-visual-mode="stage"] .particle-background::after,
  body.car-mode-stage #canvas-container::after,
  body.car-mode-stage .particle-background::after {
    background: rgba(0, 0, 0, 0.02) !important;
  }
  html[data-car-visual-mode="stage"] #empty-home,
  html[data-car-visual-mode="stage"] #home-empty,
  body.car-mode-stage #empty-home,
  body.car-mode-stage #home-empty {
    background: transparent !important;
  }
  html[data-car-visual-mode="stage"] .home-card,
  html[data-car-visual-mode="stage"] #home-recent-panel,
  body.car-mode-stage .home-card,
  body.car-mode-stage #home-recent-panel {
    background: rgba(10, 15, 23, .72) !important;
    border-color: rgba(12, 205, 191, .22) !important;
    box-shadow: 0 12px 36px rgba(0, 0, 0, .36), 0 0 0 1px rgba(12, 205, 191, .08) inset !important;
  }
  html[data-car-visual-mode="stage"] #bottom-bar,
  body.car-mode-stage #bottom-bar,
  html[data-car-visual-mode="stage"] #bottom-bar.stage-mode,
  body.car-mode-stage #bottom-bar.stage-mode {
    background: rgba(6, 10, 16, .62) !important;
    backdrop-filter: blur(16px) saturate(1.15) !important;
    border: 1px solid rgba(12, 205, 191, .18) !important;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .4) !important;
  }
  /* Stage: keep Windows glass search style only when user opens search. */
  html[data-car-visual-mode="stage"] body:not(.car-search-open) #search-area,
  body.car-mode-stage:not(.car-search-open) #search-area,
  html[data-car-visual-mode="cruise"] body:not(.empty-home-active):not(.car-search-open) #search-area,
  body.car-mode-cruise:not(.empty-home-active):not(.car-search-open) #search-area {
    opacity: 0 !important;
    pointer-events: none !important;
  }
  html[data-car-visual-mode="stage"] body.car-search-open #search-box,
  body.car-mode-stage.car-search-open #search-box {
    background: rgba(8, 12, 19, .7) !important;
    border-color: rgba(12, 205, 191, .28) !important;
  }
  /* Stage: keep FX capsule centered (do not reset transform). */
  html[data-car-visual-mode="stage"] #fx-fab,
  body.car-mode-stage #fx-fab {
    opacity: 1 !important;
    transform: translateX(-50%) !important;
    box-shadow: 0 10px 28px rgba(0, 0, 0, .36) !important;
  }
  /*
   * FX panel — bottom sheet (not right rail). Car type scale inside.
   * Probes can still touch nodes while closed (visibility only).
   */
  #fx-panel {
    position: fixed !important;
    z-index: 46 !important;
    top: auto !important;
    left: 50% !important;
    right: auto !important;
    bottom: calc(var(--car-safe-bottom) + 8px) !important;
    width: min(900px, calc(100vw - 32px)) !important;
    max-width: min(900px, calc(100vw - 32px)) !important;
    max-height: min(58vh, 480px) !important;
    height: auto !important;
    margin: 0 !important;
    padding: 16px 18px 20px !important;
    border-radius: 22px !important;
    border: 1px solid rgba(255, 255, 255, .14) !important;
    background: rgba(8, 12, 19, .94) !important;
    box-shadow: 0 20px 48px rgba(0, 0, 0, .5) !important;
    backdrop-filter: blur(18px) saturate(1.1) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    transform: translateX(-50%) translateY(120%) !important;
    opacity: 0 !important;
    pointer-events: none !important;
    visibility: hidden !important;
    transition: transform .28s ease, opacity .2s ease, visibility .2s !important;
  }
  body.car-fx-open #fx-panel {
    transform: translateX(-50%) translateY(0) !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    visibility: visible !important;
  }
  #fx-panel .fx-title {
    font-size: 20px !important;
    font-weight: 740 !important;
    line-height: 1.25 !important;
  }
  #fx-panel .fx-sub {
    font-size: 14px !important;
    line-height: 1.35 !important;
    opacity: .72 !important;
  }
  #fx-panel .fx-section-label,
  #fx-panel .fx-fold-title,
  #fx-panel .fx-fold-title strong {
    font-size: 15px !important;
    font-weight: 700 !important;
  }
  #fx-panel .fx-fold-title small,
  #fx-panel .fx-color-row-label,
  #fx-panel .fx-color-row-label small,
  #fx-panel label {
    font-size: 14px !important;
  }
  #fx-panel .fx-mini-btn,
  #fx-panel .fx-seg button,
  #fx-panel button.fx-mini-btn {
    min-height: 48px !important;
    min-width: 48px !important;
    padding: 0 14px !important;
    font-size: 15px !important;
    font-weight: 650 !important;
    border-radius: 12px !important;
  }
  #fx-panel .preset-grid,
  #fx-panel .user-archive-grid {
    gap: 10px !important;
  }
  #fx-panel .preset-grid > *,
  #fx-panel .user-archive-grid > * {
    min-height: 72px !important;
    font-size: 15px !important;
  }
  #fx-panel input[type="text"],
  #fx-panel input[type="range"] + output,
  #fx-panel .fx-slider label {
    font-size: 15px !important;
  }
  #fx-panel .fx-slider {
    min-height: 44px !important;
    gap: 10px !important;
  }
  #fx-panel .fx-slider input[type="range"] {
    height: 28px !important;
  }
  #fx-panel .fx-fold-head {
    min-height: 52px !important;
    padding: 10px 8px !important;
  }
  html[data-car-visual-mode="stage"] #stage-lyrics,
  html[data-car-visual-mode="stage"] #lyric-float-stage,
  html[data-car-visual-mode="stage"] #lyric-popword-stage,
  body.car-mode-stage #stage-lyrics,
  body.car-mode-stage #lyric-float-stage,
  body.car-mode-stage #lyric-popword-stage {
    opacity: 1 !important;
    filter: drop-shadow(0 10px 36px rgba(12, 205, 191, .28))
            drop-shadow(0 2px 12px rgba(0, 0, 0, .55)) !important;
  }
  html[data-car-visual-mode="stage"] #lyric-float-curr,
  html[data-car-visual-mode="stage"] #lyric-popword-line,
  body.car-mode-stage #lyric-float-curr,
  body.car-mode-stage #lyric-popword-line {
    color: rgba(255, 255, 255, .98) !important;
    text-shadow: 0 0 18px rgba(12, 205, 191, .35), 0 4px 22px rgba(0, 0, 0, .65) !important;
  }
  html[data-car-visual-mode="stage"] #play-btn,
  body.car-mode-stage #play-btn {
    box-shadow: 0 0 0 3px rgba(12, 205, 191, .28), 0 10px 28px rgba(0, 0, 0, .35) !important;
  }
  /* Stage keeps transport readable but lets particles breathe through panels. */
  html[data-car-visual-mode="stage"] #playlist-panel,
  body.car-mode-stage #playlist-panel {
    background: rgba(8, 12, 19, .86) !important;
    backdrop-filter: blur(14px) !important;
  }
  html[data-car-visual-mode="stage"] #fx-panel,
  body.car-mode-stage #fx-panel {
    background: rgba(8, 12, 19, .94) !important;
    border-color: rgba(12, 205, 191, .22) !important;
  }
  /* P2-3: keep transport above stage shelf hit layers. */
  html[data-car-visual-mode="stage"] #bottom-bar,
  body.car-mode-stage #bottom-bar {
    z-index: 40 !important;
    position: fixed !important;
  }
  html[data-car-visual-mode="stage"] #shelf-touch-shield,
  body.car-mode-stage #shelf-touch-shield {
    bottom: calc(var(--car-safe-bottom) + 100px + var(--car-corner-btn) + var(--car-space-16)) !important;
    pointer-events: auto !important;
  }
  html[data-car-visual-mode="stage"] #fx-fab,
  body.car-mode-stage #fx-fab {
    z-index: 41 !important;
  }
  html[data-car-visual-mode="stage"] #play-btn,
  body.car-mode-stage #play-btn {
    z-index: 42 !important;
  }

  /* Audio duck: nav/phone interrupt — dim stage without leaving showcase mode. */
  body.car-audio-duck #canvas-container::after,
  body.car-audio-duck .particle-background::after {
    background: rgba(0, 0, 0, 0.58) !important;
    transition: background .2s ease !important;
  }
  body.car-audio-duck #stage-lyrics,
  body.car-audio-duck #lyric-float-stage,
  body.car-audio-duck #lyric-popword-stage {
    opacity: .42 !important;
    filter: none !important;
  }
  body.car-audio-duck #beat-chip {
    opacity: .35 !important;
  }
  body.car-audio-duck #fx-fab {
    opacity: .55 !important;
  }

  /* Reduced motion: honor drive budget + system preference.
   * Never soft-composite stage WebGL via opacity — only raise scrim. */
  body.car-reduce-motion *,
  html[data-car-visual-mode="drive"] * {
    scroll-behavior: auto !important;
  }
  html[data-car-visual-mode="drive"] #canvas-container::after,
  body.car-mode-drive #canvas-container::after {
    background: rgba(0, 0, 0, 0.42) !important;
  }
  @media (prefers-reduced-motion: reduce) {
    html[data-car-visual-mode="drive"] #canvas-container::after,
    body.car-mode-drive #canvas-container::after {
      background: rgba(0, 0, 0, 0.55) !important;
    }
    html[data-car-visual-mode="stage"] #canvas-container,
    body.car-mode-stage #canvas-container {
      opacity: 1 !important;
    }
    body.empty-home-active .home-card { animation: none !important; }
  }

  button:focus-visible, [role="button"]:focus-visible, input:focus-visible {
    outline: 3px solid #5cf6e9 !important;
    outline-offset: 3px !important;
  }
}
`;

function decryptMineradioAsset(data) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (input.length < 20 || !input.subarray(0, 4).equals(MAGIC)) return input;
  const iv = input.subarray(4, 20);
  const encrypted = input.subarray(20);
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function encryptMineradioAsset(data, iv = crypto.randomBytes(16)) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!Buffer.isBuffer(iv) || iv.length !== 16) throw new TypeError('iv must be a 16-byte Buffer');
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
  return Buffer.concat([MAGIC, iv, cipher.update(input), cipher.final()]);
}

function injectCarHmiStylesheet(document) {
  let patched = document;
  const stylesheetPattern = /<link\b[^>]*\bhref=["']car-hmi\.css["'][^>]*>/i;
  if (!stylesheetPattern.test(patched)) {
    const stylesheet = `\n<link rel="stylesheet" href="${CAR_HMI_STYLESHEET_NAME}">`;
    patched = /<\/head>/i.test(patched)
      ? patched.replace(/<\/head>/i, `${stylesheet}\n</head>`)
      : `${stylesheet}\n${patched}`;
  }

  const runtimePattern = /<script\b[^>]*\bsrc=["']car-visual-runtime\.js["'][^>]*>\s*<\/script>/i;
  if (!runtimePattern.test(patched)) {
    const runtimeTag = `\n<script src="${CAR_VISUAL_RUNTIME_NAME}" defer></script>`;
    patched = /<\/body>/i.test(patched)
      ? patched.replace(/<\/body>/i, `${runtimeTag}\n</body>`)
      : `${patched}${runtimeTag}`;
  }

  if (!patched.includes(`id="${CAR_LOGIN_ENTRY_ID}"`)) {
    const entry = `\n${CAR_LOGIN_ENTRY}\n`;
    patched = /<\/body>/i.test(patched)
      ? patched.replace(/<\/body>/i, `${entry}</body>`)
      : `${patched}${entry}`;
  }

  // Default mode attribute before JS boots (safe music-class baseline).
  if (!/\bdata-car-visual-mode=/.test(patched)) {
    if (/<html\b[^>]*>/i.test(patched)) {
      patched = patched.replace(/<html\b([^>]*)>/i, '<html$1 data-car-visual-mode="drive">');
    } else {
      patched = `<html data-car-visual-mode="drive">\n${patched}`;
    }
  }

  return patched;
}

function patchCarHmiAssets(decodedDir) {
  const assetDir = path.join(decodedDir, 'assets', 'mineradio');
  const indexPath = path.join(assetDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`Missing Mineradio index asset: ${indexPath}`);

  const originalIndex = fs.readFileSync(indexPath);
  const patchedIndex = Buffer.from(
    injectCarHmiStylesheet(decryptMineradioAsset(originalIndex).toString('utf8')),
    'utf8',
  );
  fs.writeFileSync(indexPath, encryptMineradioAsset(patchedIndex));
  fs.writeFileSync(
    path.join(assetDir, CAR_HMI_STYLESHEET_NAME),
    encryptMineradioAsset(Buffer.from(CAR_HMI_STYLESHEET, 'utf8')),
  );
  fs.writeFileSync(
    path.join(assetDir, CAR_VISUAL_RUNTIME_NAME),
    encryptMineradioAsset(Buffer.from(CAR_VISUAL_RUNTIME_SOURCE, 'utf8')),
  );
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('Usage: patch-car-hmi-assets.js <apktool-decoded-directory>');
    process.exitCode = 64;
    return;
  }
  patchCarHmiAssets(path.resolve(argv[0]));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  CAR_HMI_STYLESHEET,
  CAR_HMI_STYLESHEET_NAME,
  CAR_VISUAL_RUNTIME_NAME,
  CAR_VISUAL_RUNTIME_SOURCE,
  decryptMineradioAsset,
  encryptMineradioAsset,
  injectCarHmiStylesheet,
  patchCarHmiAssets,
};
