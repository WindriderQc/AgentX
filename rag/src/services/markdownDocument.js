'use strict';
/**
 * Obsidian-flavoured Markdown reader for ingestion.
 *
 * Turns a note into indexable sections: frontmatter properties, heading
 * breadcrumbs, readable wikilinks and the note's link targets. It reads the
 * subset of YAML that Obsidian properties use (scalars and lists); nested
 * maps are ignored rather than guessed.
 */

const path = require('path');
const { MEMORY_SCOPES, SENSITIVITY_LEVELS } = require('../../../shared/memoryClassification');

const MARKDOWN_FORMAT = 'markdown';
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const WIKILINK = /(!?)\[\[([^\]|#^]*)(?:[#^]([^\]|]*))?(?:\|([^\]]*))?\]\]/g;
const INLINE_TAG = /(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const EMBED_MEDIA = /\.(png|jpe?g|gif|webp|svg|bmp|pdf|mp3|mp4|webm|wav|ogg|m4a|mov)$/i;
// Properties that steer ingestion; they are not rendered as note content.
const CONTROL_PROPERTIES = new Set(['scope', 'sensitivity', 'rag', 'tags', 'tag', 'aliases', 'alias', 'title', 'cssclasses']);

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(['"]).*\1$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (/^(['"]).*\1$/.test(trimmed)) return unquote(trimmed);
  const value = trimmed.replace(/\s+#.*$/, '');
  if (/^(true|yes)$/i.test(value)) return true;
  if (/^(false|no)$/i.test(value)) return false;
  if (/^\[.*\]$/.test(value)) {
    return value.slice(1, -1).split(',').map((item) => unquote(item)).filter(Boolean);
  }
  return value;
}

function splitFrontmatter(text) {
  const raw = String(text || '');
  const normalized = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { yaml: null, body: normalized };
  const end = normalized.slice(4).search(/^(---|\.\.\.)\s*$/m);
  if (end < 0) return { yaml: null, body: normalized };
  const yaml = normalized.slice(4, 4 + end);
  const rest = normalized.slice(4 + end).replace(/^(---|\.\.\.)\s*(\n|$)/, '');
  return { yaml, body: rest };
}

function parseProperties(yaml) {
  const properties = {};
  let listKey = null;
  for (const line of String(yaml || '').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s*(.*)$/.exec(line) || (listKey && /^-\s*(.*)$/.exec(line));
    if (item && listKey) {
      const value = unquote(item[1]);
      if (value) properties[listKey].push(value);
      continue;
    }
    const pair = /^([^\s:#][^:]*):(.*)$/.exec(line);
    if (!pair) { listKey = null; continue; }
    const key = pair[1].trim().toLowerCase();
    if (pair[2].trim()) {
      properties[key] = parseScalar(pair[2]);
      listKey = null;
    } else {
      properties[key] = [];
      listKey = key;
    }
  }
  return properties;
}

function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function normalizeTag(value) {
  return String(value).trim().replace(/^#/, '').toLowerCase();
}

function noteKey(value) {
  const base = path.posix.basename(String(value || '').replace(/\\/g, '/').trim());
  return base.replace(/\.md$/i, '').trim().toLowerCase();
}

function readableLinks(line, links) {
  return line.replace(WIKILINK, (_match, embed, target, anchor, alias) => {
    const name = String(target || '').trim();
    if (embed && EMBED_MEDIA.test(name)) return '';
    if (name) links.add(noteKey(name));
    if (alias && alias.trim()) return alias.trim();
    const label = path.posix.basename(name.replace(/\\/g, '/')).replace(/\.md$/i, '');
    const section = String(anchor || '').trim();
    return [label, section].filter(Boolean).join(' > ');
  });
}

/**
 * Parse a note. `fallbackTitle` names the note when neither a `title`
 * property nor a first-level heading does (usually the file name).
 */
function parseMarkdownNote(text, options = {}) {
  const { yaml, body } = splitFrontmatter(text);
  const properties = yaml === null ? {} : parseProperties(yaml);
  const withoutComments = body.replace(/%%[\s\S]*?%%/g, '');

  const links = new Set();
  for (const value of Object.values(properties).flat()) {
    if (typeof value === 'string') readableLinks(value, links);
  }
  const tags = new Set([...asList(properties.tags), ...asList(properties.tag)].map(normalizeTag).filter(Boolean));
  const sections = [];
  const stack = [];
  let current = { headingPath: [], lines: [] };
  let inFence = false;
  let firstH1 = null;

  const flush = () => {
    const content = current.lines.join('\n').trim();
    if (content) sections.push({ headingPath: current.headingPath, text: content });
  };

  for (const line of withoutComments.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      current.lines.push(line);
      continue;
    }
    const heading = !inFence && HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const title = readableLinks(heading[2], links).trim();
      if (level === 1 && firstH1 === null) firstH1 = title;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      current = { headingPath: stack.map((entry) => entry.title), lines: [] };
      continue;
    }
    if (inFence) {
      current.lines.push(line);
      continue;
    }
    for (const match of line.matchAll(INLINE_TAG)) tags.add(normalizeTag(match[2]));
    current.lines.push(readableLinks(line, links));
  }
  flush();

  const title = (typeof properties.title === 'string' && properties.title.trim())
    || firstH1
    || String(options.fallbackTitle || '').trim()
    || null;

  return {
    properties,
    title,
    aliases: [...asList(properties.aliases), ...asList(properties.alias)].map(noteKey).filter(Boolean),
    tags: [...tags],
    links: [...links].filter(Boolean),
    sections,
    excluded: properties.rag === false
  };
}

function renderProperties(properties) {
  return Object.entries(properties || {})
    .filter(([key, value]) => !CONTROL_PROPERTIES.has(key) && value !== '' && !(Array.isArray(value) && !value.length))
    .map(([key, value]) => `${key}: ${readableLinks(Array.isArray(value) ? value.join(', ') : String(value), new Set())}`)
    .join('\n');
}

/**
 * Indexable chunks for a parsed note. Each chunk begins with its breadcrumb
 * so both embeddings and keyword search see which note and section it is
 * from; the first chunk also carries the note's descriptive properties.
 */
function chunkMarkdownNote(note, chunkSize, chunkOverlap, splitIntoChunks) {
  const chunks = [];
  const rendered = renderProperties(note.properties);
  const sections = note.sections.length || !rendered ? note.sections : [{ headingPath: [], text: '' }];
  sections.forEach((section, index) => {
    const trail = [note.title, ...section.headingPath]
      .filter((part, position, all) => part && !(position === 1 && part === all[0]));
    const prefix = trail.length ? `${trail.join(' > ')}\n\n` : '';
    const body = index === 0 && rendered ? [rendered, section.text].filter(Boolean).join('\n\n') : section.text;
    const room = Math.max(100, chunkSize - prefix.length);
    const overlap = Math.min(chunkOverlap, Math.floor(room / 2));
    for (const piece of splitIntoChunks(body, room, overlap)) {
      chunks.push({ text: `${prefix}${piece}`, headingPath: trail.join(' > ') });
    }
  });
  return chunks;
}

const SENSITIVITY_RANK = Object.fromEntries(SENSITIVITY_LEVELS.map((level, rank) => [level, rank]));

/**
 * Combine a folder's labels with a note's own. A note may narrow what its
 * folder grants (a more private sensitivity, or a scope other than
 * household) but never widen it: only a household folder yields household
 * labels. Returns `{ classification }` or `{ reason }` when the file must be
 * skipped instead of guessed.
 */
function noteClassification(folder = {}, properties = {}) {
  const noteScope = properties.scope;
  const noteSensitivity = properties.sensitivity;
  if (noteScope === undefined && noteSensitivity === undefined) return { classification: folder };
  if ((noteScope !== undefined && !MEMORY_SCOPES.includes(noteScope))
    || (noteSensitivity !== undefined && !SENSITIVITY_LEVELS.includes(noteSensitivity))) {
    return { reason: 'invalid_note_classification' };
  }
  const scope = noteScope ?? folder.scope ?? 'owner';
  if (scope === 'household' && folder.scope !== 'household') return { reason: 'note_classification_widening' };
  const candidates = [noteSensitivity, folder.sensitivity].filter(Boolean);
  const sensitivity = candidates.length
    ? candidates.sort((a, b) => SENSITIVITY_RANK[b] - SENSITIVITY_RANK[a])[0]
    : 'private';
  return { classification: { scope, sensitivity } };
}

/**
 * Ingestion decision for one note: the labels and format to ingest with, or
 * the reason it stays out of the index (`rag: false`, invalid or widening
 * labels, nothing indexable).
 */
function prepareMarkdownIngest(text, folderClassification = {}) {
  const { yaml, body } = splitFrontmatter(text);
  const properties = yaml === null ? {} : parseProperties(yaml);
  if (properties.rag === false) return { reason: 'excluded_by_note' };
  const { classification, reason } = noteClassification(folderClassification, properties);
  if (reason) return { reason };
  if (!body.replace(/%%[\s\S]*?%%/g, '').trim() && !renderProperties(properties)) {
    return { reason: 'empty extracted text' };
  }
  return { classification, format: MARKDOWN_FORMAT };
}

module.exports = {
  MARKDOWN_FORMAT,
  prepareMarkdownIngest,
  chunkMarkdownNote,
  noteClassification,
  noteKey,
  parseMarkdownNote,
  parseProperties,
  renderProperties,
  splitFrontmatter
};
