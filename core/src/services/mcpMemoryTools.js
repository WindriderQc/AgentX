'use strict';

// Owner memory tools for the Core MCP bus. /mcp sits behind the adult
// boundary, so callers act for the owner: they read and correct the owner's
// personal notes, the same store Nestor and the memory editor use.
const { personal } = require('./memoryNoteService');
const { SECRET_PATTERNS } = require('./nestorMemoryService');

const KINDS = ['fact', 'preference', 'decision'];
const SOURCE = 'mcp-agent';

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const MEMORY_TOOLS = [
  {
    name: 'memory_search',
    title: 'Search Owner Memory',
    description: 'Search the owner\'s durable memory notes (facts, preferences, decisions about the owner and the household) by keywords. Use it before asking the owner something they may already have told Nestor.',
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 1, maxLength: 4000 },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
    }, ['query']),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'memory_remember',
    title: 'Remember For The Owner',
    description: 'Save one durable fact, preference or decision about the owner or the household, in one self-contained sentence. Pass id to correct an existing note. Not for infrastructure notes (use the docs or a vault note), mail digests, logs or secrets: secret-like text is refused.',
    inputSchema: objectSchema({
      text: { type: 'string', minLength: 1, maxLength: 4000 },
      kind: { type: 'string', enum: KINDS, default: 'fact' },
      id: { type: 'string', pattern: '^[a-f0-9]{24}$' },
      expiresAt: { type: 'string', format: 'date-time' },
    }, ['text']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function toolError(message, code) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function plain(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw toolError('arguments must be an object', 'INVALID_ARGUMENTS');
  return args;
}

function view(note) {
  return { id: note.id, text: note.text, kind: note.kind, source: note.source,
    createdAt: note.createdAt, updatedAt: note.updatedAt, expiresAt: note.expiresAt };
}

async function memorySearch(args, deps = {}) {
  const input = plain(args);
  if (typeof input.query !== 'string' || !input.query.trim()) throw toolError('query is required', 'INVALID_ARGUMENTS');
  const limit = Math.max(1, Math.min(20, Math.trunc(Number(input.limit)) || 8));
  const result = await (deps.memoryNotes || personal()).search(input.query, { limit });
  return { query: input.query.trim(), count: result.notes.length, notes: result.notes.map(view) };
}

async function memoryRemember(args, deps = {}) {
  const input = plain(args);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw toolError('text is required', 'INVALID_ARGUMENTS');
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
    throw toolError('memory text looks secret-like; refusing to store it', 'SECRET_LIKE_MEMORY_REFUSED');
  }
  if (input.kind !== undefined && !KINDS.includes(input.kind)) throw toolError('kind must be fact, preference or decision', 'INVALID_ARGUMENTS');
  const note = await (deps.memoryNotes || personal()).remember({
    text, source: SOURCE,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
  return { id: note.id, created: note.created, changed: note.changed, kind: note.kind, text: note.text };
}

module.exports = { MEMORY_TOOLS, MEMORY_TOOL_HANDLERS: { memory_search: memorySearch, memory_remember: memoryRemember } };
