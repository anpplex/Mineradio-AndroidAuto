#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { patchManifest } = require('./patch-manifest');

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error('Usage: patch-apk-manifest.js <decoded-AndroidManifest.xml>');
}

const absolutePath = path.resolve(manifestPath);
const original = fs.readFileSync(absolutePath, 'utf8');
fs.writeFileSync(absolutePath, patchManifest(original), 'utf8');
