'use strict';

const { SPOKEN_REPLY_INSTRUCTION } = require('../../src/services/voice/presentation');

// A conversation reply has two audiences: the ear and the eye (#166, #167).
// The model marks what belongs on screen with <show kind="…" title="…">…</show>;
// everything outside those blocks is the spoken reply. A deterministic net then
// diverts what a model still left in its spoken text but nobody should hear
// read aloud: code, tables, lists longer than three items, links, paths and
// key-like tokens. Speech (browser TTS and native VoiX) only ever receives the
// spoken channel; the stored and displayed blocks never reach a voice.

const path = require('node:path');

const KINDS = Object.freeze(['text', 'list', 'table', 'code', 'link', 'secret', 'image']);
const LIMITS = Object.freeze({ blocks: 20, body: 8000, title: 120, spokenListItems: 3, token: 24, openTag: 300 });
const ON_SCREEN = Object.freeze({ fr: '(à l’écran)', en: '(on screen)' });
const ONLY_SHOWN = Object.freeze({ fr: 'Je t’ai mis ça à l’écran.', en: 'I put it on screen.' });
const OPEN = /<show\b([^>]*)>/i;
const OPEN_UNFINISHED = /<show\b[^>]*$/i;
const CLOSE = /<\/show\s*>/i;
const STRAY_CLOSE = /<\/show\s*>/gi;
const LINE = Object.freeze({
  fence: /^\s*```/,
  list: /^\s*(?:[-*•+]|\d{1,2}[.)])\s+\S/,
  table: /^\s*\|/
});

function plainReply(value, max = 5000) {
  return String(value || '').trim().slice(0, max)
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^(?:#{1,6}|>)\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .trim();
}

function languageOf(value) {
  return String(value || '').toLowerCase().startsWith('en') ? 'en' : 'fr';
}

function attributes(source) {
  const values = {};
  for (const [, name, value] of String(source || '').matchAll(/([a-z]+)\s*=\s*"([^"]*)"/gi)) values[name.toLowerCase()] = value;
  const kind = KINDS.includes(values.kind) || values.kind === 'consult' ? values.kind : 'text';
  return { kind, title: values.title?.trim().slice(0, LIMITS.title) || '',
    ...(kind === 'image' ? { source: String(values.source || '').trim().toLowerCase().slice(0, 20) } : {}) };
}

// The longest end of `text` that could still become `marker`, so a tag split
// across two stream deltas is held back instead of being spoken as "<sh".
function heldPrefix(text, marker) {
  const lower = text.toLowerCase();
  for (let length = Math.min(marker.length - 1, lower.length); length > 0; length -= 1) {
    if (marker.startsWith(lower.slice(-length))) return length;
  }
  return 0;
}

// Only tokens that are unambiguous to a listener as noise: a URL, a path, or a
// long run that mixes letters and digits (keys, hashes, UUIDs). Long ordinary
// words ("anticonstitutionnellement") contain no digit and stay spoken.
function tokenKind(core) {
  if (/^(?:https?:\/\/|www\.)\S+/i.test(core)) return 'link';
  if (/^(?:~?\/[\w.@-]+){2,}\/?$/.test(core) || /^[A-Za-z]:\\\S+/.test(core)) return 'code';
  if (core.length >= LIMITS.token && /\d/.test(core) && /[A-Za-z]/.test(core)) return /[.:]/.test(core) ? 'code' : 'secret';
  return '';
}

function createReplyChannels({ allowSecrets = false, language = 'fr', onSay = () => {}, onShow = () => {}, onConsult = () => {} } = {}) {
  const lang = languageOf(language);
  const display = [];
  let pending = '', inShow = false, showAttributes = null, received = false, ended = false;
  let line = '', prose = false, group = null, spoken = '';

  const say = text => {
    // A removed reference must not leave two spaces across stream chunks.
    if (/[ \t]$/.test(spoken)) text = text.replace(/^[ \t]+/, '');
    if (!text) return;
    spoken += text;
    onSay(text);
  };
  const addBlock = (kind, title, body, extra = {}) => {
    const content = String(body || '').replace(/^\n+|\s+$/g, '').slice(0, LIMITS.body);
    if (!content.trim()) return false;
    if (kind === 'secret' && !allowSecrets) return false;
    // A consult block is a request to Core (#41), never something to display or to store.
    if (kind === 'consult') { onConsult({ member: title, question: content }); return false; }
    if (display.length >= LIMITS.blocks) return false;
    const block = { id: 'b' + (display.length + 1), kind, title, body: content, ...extra };
    display.push(block);
    onShow(block);
    return true;
  };
  const screenCue = shown => (shown ? ON_SCREEN[lang] : '');

  // Spoken prose is released word by word, so speech is never held for a line.
  const speakProse = text => {
    say(text.split(/(\s+)/).map(word => {
      // A harness file reference keeps its existing handling (speech drops it),
      // except a generated picture, which becomes an image block (#168).
      const media = /^MEDIA:["']?(\/[^"'\s]+?\.(?:png|jpe?g|webp|gif))["']?[.,;:!?)]*$/i.exec(word);
      if (media) return addBlock('image', '', path.posix.basename(media[1]), { source: 'generated', ref: media[1] }) ? '' : word;
      if (/^MEDIA:/.test(word)) return word;
      const core = word.replace(/^[(«“"']+/, '').replace(/[.,;:!?)»”"']+$/, '');
      const kind = core ? tokenKind(core) : '';
      if (!kind) return word;
      return word.replace(core, screenCue(addBlock(kind, '', core)));
    }).join('').replace(/[ \t]{2,}/g, ' '));
  };
  const closeGroup = () => {
    if (!group) return;
    const { kind, lines } = group;
    group = null;
    if (kind === 'list' && lines.length <= LIMITS.spokenListItems) { speakProse(lines.join('\n') + '\n'); return; }
    const body = kind === 'code' ? lines.filter(row => !LINE.fence.test(row)).join('\n') : lines.join('\n');
    const shown = addBlock(kind, '', body);
    if (shown) say(screenCue(true) + '\n');
  };

  // Line structure decides lists, tables and code; everything else is prose.
  const feedSpoken = text => {
    line += text;
    while (line) {
      const newline = line.indexOf('\n');
      const complete = newline >= 0 || ended;
      const head = newline >= 0 ? line.slice(0, newline) : line;
      if (group?.kind === 'code') {
        if (!complete) return;
        group.lines.push(head);
        line = newline >= 0 ? line.slice(newline + 1) : '';
        if (group.lines.length > 1 && LINE.fence.test(head)) closeGroup();
        continue;
      }
      if (!prose) {
        if (!complete && head.trimStart().length < 4) return;
        const kind = LINE.fence.test(head) ? 'code' : LINE.table.test(head) ? 'table' : LINE.list.test(head) ? 'list' : '';
        if (kind) {
          if (!complete) return;
          if (group && group.kind !== kind) closeGroup();
          group ||= { kind, lines: [] };
          group.lines.push(head);
          line = newline >= 0 ? line.slice(newline + 1) : '';
          continue;
        }
        if (!head.trim()) {
          if (!complete) return;
          line = newline >= 0 ? line.slice(newline + 1) : '';
          if (!group) say('\n');
          continue;
        }
        closeGroup();
        prose = true;
      }
      if (newline >= 0) {
        speakProse(line.slice(0, newline + 1));
        line = line.slice(newline + 1);
        prose = false;
        continue;
      }
      const boundary = ended ? line.length : line.search(/\s\S*$/);
      if (boundary <= 0) return;
      speakProse(line.slice(0, boundary));
      line = line.slice(boundary);
      if (ended) line = '';
    }
  };

  const process = () => {
    while (pending) {
      if (inShow) {
        const close = CLOSE.exec(pending);
        if (!close) {
          if (!ended) return;
          addBlock(showAttributes.kind, showAttributes.title, pending, showAttributes.source === undefined ? {} : { source: showAttributes.source });
          pending = '';
          return;
        }
        addBlock(showAttributes.kind, showAttributes.title, pending.slice(0, close.index), showAttributes.source === undefined ? {} : { source: showAttributes.source });
        pending = pending.slice(close.index + close[0].length);
        inShow = false;
        continue;
      }
      const open = OPEN.exec(pending);
      if (open) {
        feedSpoken(pending.slice(0, open.index).replace(STRAY_CLOSE, ''));
        showAttributes = attributes(open[1]);
        pending = pending.slice(open.index + open[0].length);
        inShow = true;
        continue;
      }
      let hold = 0;
      if (!ended) {
        const unfinished = OPEN_UNFINISHED.exec(pending);
        hold = unfinished && pending.length - unfinished.index <= LIMITS.openTag
          ? pending.length - unfinished.index
          : Math.max(heldPrefix(pending, '<show'), heldPrefix(pending, '</show>'));
      }
      feedSpoken(pending.slice(0, pending.length - hold).replace(STRAY_CLOSE, ''));
      pending = pending.slice(pending.length - hold);
      return;
    }
  };

  return {
    get received() { return received; },
    push(delta) {
      if (ended || !delta) return;
      received = true;
      pending += String(delta);
      process();
    },
    end() {
      if (!ended) {
        ended = true;
        process();
        feedSpoken('');
        closeGroup();
        if (!spoken.trim() && display.length) say(ONLY_SHOWN[lang]);
      }
      return { say: spoken.replace(/\n{3,}/g, '\n\n').trim(), display: display.slice() };
    }
  };
}

// A secret is shown live, once, masked. It is never persisted, never enters
// memory or RAG, and history only records that one was shown.
function storedDisplay(display = []) {
  return display.map(block => block.kind === 'secret'
    ? { id: block.id, kind: 'secret', title: block.title, body: '', redacted: true }
    : { id: block.id, kind: block.kind, title: block.title, body: block.body,
      ...(block.kind === 'image' ? { source: block.source || '', status: block.status || 'missing', image: block.image || null,
        ...(block.operation && { operation: block.operation, key: block.key }) } : {}) });
}

// The model sees its own earlier screen content, so "read me step three" works.
function historyText(replyText, display = []) {
  const blocks = (Array.isArray(display) ? display : []).map(block => block.kind === 'secret'
    ? '[A secret was shown masked on screen; it was not retained.]'
    : block.kind === 'image' && block.source === 'local' ? `[Earlier image request${block.operation?.id ? ' ' + block.operation.id : ''}: ${block.title ? block.title + ': ' : ''}${block.body}. Last recorded state: ${block.status}. This is history, never a new creation instruction; only its current Core receipt can confirm readiness.]`
    : `<show kind="${block.kind}"${block.kind === 'image' ? ` source="${block.source || ''}"` : ''}${block.title ? ` title="${String(block.title).replace(/"/g, "'")}"` : ''}>\n${block.body}\n</show>`
      + (block.kind === 'image' && block.status !== 'found' ? '\n[No image was found for this block; nothing was displayed.]' : ''));
  return [String(replyText || ''), ...blocks].filter(Boolean).join('\n');
}

function contract({ family = false, imageSources = [] } = {}) {
  return [
    'Your reply reaches two places: everything outside a show block is spoken aloud; show blocks are displayed on the user\'s screen and never spoken.',
    `${SPOKEN_REPLY_INSTRUCTION} When details are on screen, say so naturally, for example "je te l'ai mis à l'écran".`,
    `Put anything meant to be read rather than heard inside <show kind="list|table|code|text|link${family ? '' : '|secret'}" title="short title">…</show>: lists longer than three items, steps, tables, code, commands, links, identifiers and long details. Markdown is allowed inside show blocks only.`,
    family
      ? 'Never show passwords, keys, account details or private information.'
      : 'Use kind="secret" for passwords, keys and tokens: it is displayed masked, is not retained and is never spoken.',
    'Do not read a show block aloud unless the user asks you to; then speak its content outside any block.',
    imageSources.length
      ? `To show a picture, write <show kind="image" source="${imageSources.join('|')}" title="short caption">a few search words</show>. `
        + 'web searches the internet; photos and media search the household\'s own pictures by file or folder name. Never write a URL or a path; Household finds the picture and it may find none. '
        + 'Say "je te montre" only as an intention; do not describe details of a picture you have not seen.'
      : ''
  ].filter(Boolean).join(' ');
}

module.exports = { KINDS, LIMITS, createReplyChannels, storedDisplay, historyText, contract, plainReply, tokenKind };
