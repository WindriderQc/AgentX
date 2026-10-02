'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../public/journal-display');
const { row, shown } = globalThis.JournalDisplay;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

const BASE = { inputText: 'Montre-moi une girafe', replyText: 'Je te l’ai mis à l’écran.', createdAt: '2026-09-30T12:00:00Z', packId: 'kidx_nestor', channel: 'voice', durationMs: 900 };

test('a turn with nothing on screen shows no screen section', () => {
  assert.equal(shown(BASE, esc), '');
  assert.doesNotMatch(row(BASE, { esc }), /Shown on screen/);
});

test('the parent sees each block the child saw, a masked secret only as a fact', () => {
  const html = shown({ display: [
    { kind: 'list', title: 'Étapes', body: '1. **Laver** les mains\n' + 'x'.repeat(400) },
    { kind: 'secret', title: 'Code', body: '', redacted: true },
    { kind: 'text', title: '', body: '<script>alert(1)</script>' }
  ] }, esc);
  assert.match(html, /Shown on screen · 3/);
  assert.match(html, /List<\/span> · Étapes/);
  assert.match(html, /…<\/div>/, 'a long block is previewed, not dumped');
  assert.match(html, /Secret<\/span> · Code <em>shown masked, not retained<\/em>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('pictures show their source and a thumbnail from an allowed address only', () => {
  const html = shown({ display: [
    { kind: 'image', source: 'web', title: 'Girafe', body: 'girafe', status: 'found',
      image: { url: 'https://images.example.test/g.jpg', origin: 'https://zoo.example.test/g', originTitle: 'Zoo' } },
    { kind: 'image', source: 'photos', body: 'cabane', status: 'found', image: { url: '/api/voice-personas/family/visuals/file?source=photos&path=a.jpg' } },
    { kind: 'image', source: 'web', body: 'licorne', status: 'missing', image: null },
    { kind: 'image', source: 'web', body: 'piège', status: 'found', image: { url: 'javascript:alert(1)' } }
  ] }, esc);
  assert.match(html, /src="https:\/\/images\.example\.test\/g\.jpg"[^>]*referrerpolicy="no-referrer"/);
  assert.match(html, /Internet · <a href="https:\/\/zoo\.example\.test\/g"/);
  assert.match(html, /Family photos<img[^>]+src="\/api\/voice-personas\/family\/visuals\/file\?source=photos&amp;path=a\.jpg"/);
  assert.match(html, /<em>no picture found<\/em> for « licorne »/);
  assert.match(html, /<em>no picture found<\/em> for « piège »/);
  assert.doesNotMatch(html, /javascript:/);
});

test('the math picture records whether it was drawn', () => {
  assert.match(shown({ sceneReceipt: { kind: 'add', a: 8, b: 5, status: 'applied' } }, esc), /3D<\/span> 8 \+ 5 = 13 · drawn/);
  assert.match(shown({ sceneReceipt: { kind: 'count', to: 12, status: 'rejected', reason: 'no-face' } }, esc),
    /counting to 12 · not drawn \(3D unavailable on the device\)/);
});

test('the journal row keeps its question, answer, flags and offered sound', () => {
  const html = row({ ...BASE, safetyFlags: ['medical'], soundId: 'rain', display: [{ kind: 'text', body: 'Bonjour' }] },
    { esc, sound: { emoji: '🌧', label: { fr: 'Pluie' } } });
  assert.match(html, /^<div class="audit danger-box"><strong>Montre-moi une girafe<\/strong><div>Je te l’ai mis à l’écran\.<\/div><details/);
  assert.match(html, /900ms · offered 🌧 Pluie · medical<\/small><\/div>$/);
});

test('the page loads the journal view before the app that renders it', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('journal-display.js') > 0 && html.indexOf('journal-display.js') < html.indexOf('/app.js'));
});
