#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PASSPHRASE = Buffer.from('Sp1ca@Minerad1o#2024$SecureAssetKey!', 'ascii');
const KEY = crypto.createHash('sha256').update(PASSPHRASE).digest();
const MAGIC = Buffer.from('MENC', 'ascii');
const CAR_HMI_STYLESHEET_NAME = 'car-hmi.css';
const CAR_LOGIN_ENTRY_ID = 'car-login-entry';
const CAR_LOGIN_ENTRY = `<button type="button" id="${CAR_LOGIN_ENTRY_ID}" aria-label="网易云扫码登录" title="网易云扫码登录" onclick="showLoginModal()">网易云扫码登录</button>`;

/*
 * Project car-HMI target for the validated Huawei ICHU3200E15-ADV unit:
 * physical 1920x1080 @ 320dpi, WebView meta viewport width=device-width.
 * At density 2.0 that is about 960x540 CSS px — not physical pixels.
 * Values below are intentional project targets, not OEM certification.
 */
const CAR_HMI_STYLESHEET = String.raw`/* Mineradio Huawei / Android automotive HMI overlay.
 * Match density-scaled WebView CSS px on the validated landscape unit. */
:root {
  --car-space-12: 12px;
  --car-space-16: 16px;
  --car-space-20: 20px;
  --car-space-24: 24px;
  --car-space-32: 32px;
  --car-touch-target: 48px;
  --car-primary-action: 64px;
  --car-panel: rgba(10, 15, 23, .92);
  --car-panel-strong: rgba(8, 12, 19, .97);
  --car-text-primary: rgba(255, 255, 255, .98);
  --car-text-secondary: rgba(234, 243, 247, .78);
}

/* 900 CSS px ≈ 1800 physical px @ 320dpi; covers the 960 CSS-wide car WebView. */
@media (min-width: 900px) and (min-height: 480px) {
  html, body { font-size: 16px; }

  /* Do not leave the automotive home screen as a small desktop island. */
  #empty-home, #home-empty, .empty-home, .home-page {
    top: 88px !important;
    bottom: 108px !important;
    width: min(920px, calc(100vw - 48px)) !important;
  }
  .empty-home-shell, .home-shell, .home-layout {
    grid-template-columns: minmax(280px, .95fr) minmax(420px, 1.35fr) !important;
    grid-template-rows: minmax(0, 1fr) !important;
    gap: var(--car-space-16) !important;
  }
  .home-hero { grid-row: 1 !important; }

  /* Search is a primary driving action, so keep it visible and legible. */
  #search-area, .search-area {
    top: 20px !important;
    opacity: 1 !important;
    pointer-events: auto !important;
  }
  #search-stack { width: min(420px, 48vw) !important; }
  #search-box, .search-box {
    min-height: var(--car-touch-target) !important;
    height: var(--car-touch-target) !important;
    padding-inline: 18px !important;
    border-radius: 22px !important;
    background: var(--car-panel-strong) !important;
    border-color: rgba(255, 255, 255, .20) !important;
  }
  #search-icon { width: 22px !important; height: 22px !important; margin-right: 12px !important; }
  #search-input, .search-input { font-size: 18px !important; font-weight: 520 !important; }
  #search-input::placeholder { color: rgba(255, 255, 255, .62) !important; }

  /* Main cards become full-card actions with readable Chinese hierarchy. */
  .home-grid, .home-quick-grid, .home-cards, .dashboard-grid {
    grid-template-rows: repeat(3, minmax(0, 1fr)) !important;
    height: 100% !important;
    gap: var(--car-space-16) !important;
  }
  .home-card, .dashboard-card, .quick-card, .home-tile {
    min-height: 104px !important;
    padding: 16px !important;
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
    font-size: 20px !important;
    line-height: 1.2 !important;
    font-weight: 720 !important;
  }
  .home-card-sub, .dashboard-card-sub, .card-sub, .home-tile-sub {
    margin-top: 8px !important;
    color: var(--car-text-secondary) !important;
    font-size: 14px !important;
    line-height: 1.4 !important;
  }
  .home-card-art { width: 72px !important; height: 72px !important; right: 14px !important; bottom: 14px !important; }

  /* Ensure the existing empty/recent panel is useful and readable. */
  #home-recent-panel, .home-hero, .recent-play-card, .recent-card, .home-recent {
    background: var(--car-panel) !important;
    border-color: rgba(255, 255, 255, .20) !important;
    border-radius: 20px !important;
    padding: 18px !important;
  }
  #home-recent-panel { max-width: none !important; }
  .home-recent-title, .home-title, .recent-title, .recent-play-title {
    color: var(--car-text-primary) !important;
    font-size: 22px !important;
    line-height: 1.18 !important;
  }
  .home-recent-grid { gap: 8px !important; }
  .home-recent-item { min-height: var(--car-touch-target) !important; padding: 8px 12px !important; }
  .home-recent-empty, .home-sub, .recent-empty, .recent-play-empty {
    color: var(--car-text-secondary) !important;
    font-size: 15px !important;
    line-height: 1.45 !important;
  }

  /* Login stays discoverable without covering the top-right account chip. */
  #car-login-entry {
    position: fixed !important;
    z-index: 24 !important;
    top: 20px !important;
    right: 168px !important;
    min-width: 168px !important;
    min-height: var(--car-touch-target) !important;
    padding: 0 16px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    border: 1px solid rgba(96, 255, 231, .60) !important;
    border-radius: 16px !important;
    background: #0ccdbf !important;
    color: #041312 !important;
    font-size: 15px !important;
    font-weight: 760 !important;
    letter-spacing: .02em !important;
    box-shadow: 0 8px 20px rgba(0, 0, 0, .34) !important;
  }
  #trial-banner {
    top: 84px !important;
    left: auto !important;
    right: 20px !important;
    transform: translateY(-8px) !important;
    min-height: var(--car-touch-target) !important;
    padding: 8px 14px !important;
    border-radius: 14px !important;
    font-size: 14px !important;
    background: var(--car-panel-strong) !important;
  }
  #trial-banner.show { transform: translateY(0) !important; }
  #trial-login-btn {
    min-height: var(--car-touch-target) !important;
    padding: 0 14px !important;
    margin-left: 10px !important;
    display: inline-flex !important;
    align-items: center !important;
    border-radius: 12px !important;
    background: #0ccdbf !important;
    color: #041312 !important;
    font-size: 14px !important;
    font-weight: 760 !important;
  }

  /* Primary shell actions: 48 CSS px ≈ 96 physical px @ 320dpi. */
  #playlist-toggle, #home-btn, #announcement-entry, #fx-fab, #bottom-bar-close-btn {
    width: var(--car-touch-target) !important;
    height: var(--car-touch-target) !important;
    min-width: var(--car-touch-target) !important;
    min-height: var(--car-touch-target) !important;
  }
  #playlist-toggle { top: 20px !important; left: 20px !important; }
  /* Keep visual settings above the player rather than over its right-hand controls. */
  #fx-fab { right: 20px !important; bottom: 128px !important; }
  #fx-fab-hide-btn { display: none !important; }
  #playlist-toggle svg, #home-btn svg, #announcement-entry svg, #fx-fab svg { width: 22px !important; height: 22px !important; }

  /* Main playback only: metadata, previous, play/pause, next and queue. */
  #bottom-bar {
    min-height: 88px !important;
    width: min(920px, calc(100vw - 48px)) !important;
    bottom: 16px !important;
    padding: 10px 16px !important;
    border-radius: 22px !important;
    background: var(--car-panel-strong) !important;
  }
  #bottom-bar > #controls {
    grid-template-columns: minmax(0, 1fr) auto auto !important;
    gap: 12px !important;
    align-items: center !important;
  }
  #bottom-bar .control-track, #bottom-bar .control-meta { min-width: 0 !important; }
  #bottom-bar .control-meta { max-width: none !important; }
  #bottom-bar .control-title, #bottom-bar .control-artist {
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }
  #bottom-bar > #bottom-bar-close-btn,
  #bottom-bar > #controls > .control-cluster > .ctrl-btn {
    width: var(--car-touch-target) !important;
    height: var(--car-touch-target) !important;
    min-width: var(--car-touch-target) !important;
    min-height: var(--car-touch-target) !important;
    border-radius: 16px !important;
  }
  #bottom-bar > #bottom-bar-close-btn svg,
  #bottom-bar > #controls > .control-cluster > .ctrl-btn svg { width: 22px !important; height: 22px !important; }
  #play-btn {
    width: var(--car-primary-action) !important;
    height: var(--car-primary-action) !important;
    min-width: var(--car-primary-action) !important;
    min-height: var(--car-primary-action) !important;
    border-radius: 50% !important;
    background: #0ccdbf !important;
    color: #031111 !important;
  }
  #play-btn svg { width: 28px !important; height: 28px !important; }
  .control-title, #song-title, .now-playing-title { font-size: 18px !important; color: var(--car-text-primary) !important; }
  .control-artist, #artist-name, .now-playing-artist { font-size: 14px !important; color: var(--car-text-secondary) !important; }
  .control-cluster.actions, .control-cluster.modes { gap: var(--car-space-12) !important; }
  #bottom-bar #quality-control, #bottom-bar #heart-btn, #bottom-bar #collect-btn,
  #bottom-bar #refresh-download-btn, #bottom-bar #play-mode-btn, #bottom-bar #sleep-timer-btn,
  #bottom-bar #audio-effect-control, #bottom-bar #eq-control, #bottom-bar .lyrics-toggle-btn,
  #bottom-bar #volume-control, #bottom-bar #controls-hide-btn, #bottom-bar #immersive-btn {
    display: none !important;
  }
  #bottom-bar #time-display { min-width: 104px !important; font-size: 13px !important; color: var(--car-text-secondary) !important; }

  /* A moving particle field may remain decorative, but cannot compete with controls. */
  body.empty-home-active .home-card { animation: none !important; }
  #canvas-container, #idle-guide-canvas, .particle-background { opacity: .34 !important; }
  #canvas-container::after, .particle-background::after {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: rgba(0, 0, 0, .26);
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
  if (!patched.includes(`id="${CAR_LOGIN_ENTRY_ID}"`)) {
    const entry = `\n${CAR_LOGIN_ENTRY}\n`;
    patched = /<\/body>/i.test(patched)
      ? patched.replace(/<\/body>/i, `${entry}</body>`)
      : `${patched}${entry}`;
  }
  return patched;
}

function patchCarHmiAssets(decodedDir) {
  const assetDir = path.join(decodedDir, 'assets', 'mineradio');
  const indexPath = path.join(assetDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`Missing Mineradio index asset: ${indexPath}`);

  const originalIndex = fs.readFileSync(indexPath);
  const patchedIndex = Buffer.from(injectCarHmiStylesheet(decryptMineradioAsset(originalIndex).toString('utf8')), 'utf8');
  fs.writeFileSync(indexPath, encryptMineradioAsset(patchedIndex));
  fs.writeFileSync(path.join(assetDir, CAR_HMI_STYLESHEET_NAME), encryptMineradioAsset(Buffer.from(CAR_HMI_STYLESHEET, 'utf8')));
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
  decryptMineradioAsset,
  encryptMineradioAsset,
  injectCarHmiStylesheet,
  patchCarHmiAssets,
};
