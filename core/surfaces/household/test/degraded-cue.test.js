'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #135: a reply served by a fallback ladder rung is marked "mode dégradé".
test('a degraded household turn marks its assistant message with the existing note style', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(server, /if \(metadata\?\.routing\?\.degraded\) \{ fallbackUsed = true; fallbackReason = `task_fallback_\$\{metadata\.routing\.reason\}`; \}/);
  assert.match(page, /degradedReply = result\.routing\?\.fallbackUsed === true;/);
  assert.match(page, /if \(role === 'assistant' && degradedReply\) \{ row\.dataset\.degraded = 'true'; degradedReply = false; \}/);
  assert.match(css, /\.conversation-message\[data-degraded=true\]::after \{ content: 'mode dégradé';/);
});
