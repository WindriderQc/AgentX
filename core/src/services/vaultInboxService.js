'use strict';

// Agents file Markdown notes into the owner's vault inbox. The inbox sits
// outside approved ingestion roots: nothing written here reaches retrieval
// until the owner moves the note into the documents folder, which is the
// approval. The capability is off unless VAULT_INBOX_PATH names a directory.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const MAX_TITLE = 120;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TAGS = 12;
const AUTHORS = new Set(['nestor', 'agent']);
const TAG = /^[\p{L}\p{N}_][\p{L}\p{N}_/-]{0,63}$/u;

function inboxError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function cleanTitle(value) {
  const title = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_TITLE)
    .trim();
  if (!title) throw inboxError('title must contain 1-120 visible characters', 'VAULT_NOTE_INVALID');
  return title;
}

function cleanTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw inboxError(`tags must be an array of at most ${MAX_TAGS} words`, 'VAULT_NOTE_INVALID');
  }
  const tags = value.map((tag) => String(tag).trim().replace(/^#/, ''));
  if (tags.some((tag) => !TAG.test(tag))) {
    throw inboxError('tags use letters, digits, _, - and /', 'VAULT_NOTE_INVALID');
  }
  return [...new Set(tags)];
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function renderNote({ title, body, tags, author, created }) {
  const lines = ['---', `title: ${yamlString(title)}`, `created: ${created}`, `author: ${author}`, 'status: inbox'];
  if (tags.length) lines.push('tags:', ...tags.map((tag) => `  - ${yamlString(tag)}`));
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

function createVaultInbox({ root = process.env.VAULT_INBOX_PATH, clock = () => new Date() } = {}) {
  const configuredRoot = String(root || '').trim();
  const enabled = path.isAbsolute(configuredRoot);

  async function resolveRoot() {
    if (!enabled) throw inboxError('The vault inbox is not configured.', 'VAULT_INBOX_DISABLED', 503);
    try {
      const realRoot = await fs.realpath(configuredRoot);
      if ((await fs.stat(realRoot)).isDirectory()) return realRoot;
    } catch (_error) {
      // Reported below without the host path.
    }
    throw inboxError('The vault inbox folder is unavailable.', 'VAULT_INBOX_UNAVAILABLE', 503);
  }

  // Link a fully written temp file to a free name: the note appears whole,
  // and an existing note is never overwritten.
  async function place(dir, baseName, content) {
    const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temp, content, { flag: 'wx', mode: 0o644 });
    try {
      for (let attempt = 1; attempt <= 50; attempt += 1) {
        const fileName = `${baseName}${attempt === 1 ? '' : ` (${attempt})`}.md`;
        try {
          await fs.link(temp, path.join(dir, fileName));
          return fileName;
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
        }
        // Filesystems without hard links (some network mounts): exclusive create still never overwrites.
        try {
          await fs.writeFile(path.join(dir, fileName), content, { flag: 'wx', mode: 0o644 });
          return fileName;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      throw inboxError('Too many notes share this title today.', 'VAULT_NOTE_CONFLICT', 409);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async function writeNote(input = {}, { author } = {}) {
    if (!AUTHORS.has(author)) throw inboxError('A server-selected author is required', 'VAULT_AUTHOR_REQUIRED', 500);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw inboxError('note must be an object', 'VAULT_NOTE_INVALID');
    }
    const title = cleanTitle(input.title);
    const body = typeof input.body === 'string' ? input.body : '';
    if (!body.trim()) throw inboxError('body must be non-empty Markdown', 'VAULT_NOTE_INVALID');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw inboxError(`body exceeds ${MAX_BODY_BYTES} bytes`, 'VAULT_NOTE_TOO_LARGE', 413);
    }
    const tags = cleanTags(input.tags);
    const dir = await resolveRoot();
    const now = clock();
    const created = now.toISOString();
    const fileName = await place(dir, `${created.slice(0, 10)} ${title}`, renderNote({ title, body, tags, author, created }));
    return { ok: true, authority: 'agentx.core', operation: 'write_vault_note', file: fileName, title, created, status: 'inbox' };
  }

  return Object.freeze({ enabled, writeNote });
}

module.exports = { MAX_BODY_BYTES, createVaultInbox, renderNote };
