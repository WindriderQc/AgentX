'use strict';

// Passive presentation data only. The same contract is bundled for browsers;
// it grants no tools, URLs, component imports or business actions.
const SCHEMA = 'agentx.answer-blocks/v1';
const LIMITS = Object.freeze({ blocks: 5, columns: 8, rows: 50, title: 120, column: 120, cell: 500, characters: 16000 });
class AnswerBlocksError extends Error {
  constructor(message) { super(message); this.name = 'AnswerBlocksError'; this.code = 'ANSWER_BLOCKS_INVALID'; this.statusCode = 400; }
}
const fail = message => { throw new AnswerBlocksError(message); };
function fields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    fail('Answer blocks contain missing or unsupported fields.');
  }
}

function normalizeEnvelope(value) {
  fields(value, ['schema', 'blocks']);
  if (value.schema !== SCHEMA) fail('Unsupported answer block schema.');
  if (!Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > LIMITS.blocks) fail('Keep 1 to 5 answer tables.');
  let characters = 0;
  function text(value, limit, required) {
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)
      || (required && !value.trim())) fail('Table labels and cells must be bounded, single-line text.');
    characters += value.length;
    if (characters > LIMITS.characters) fail('Answer tables exceed the total text budget.');
    return value;
  }
  const blocks = [...value.blocks].map(block => {
    fields(block, ['kind', 'title', 'columns', 'rows']);
    if (block.kind !== 'table') fail('Only table answer blocks are supported.');
    const title = text(block.title, LIMITS.title, true);
    if (!Array.isArray(block.columns) || block.columns.length < 1 || block.columns.length > LIMITS.columns) fail('Keep 1 to 8 table columns.');
    const columns = [...block.columns].map(value => text(value, LIMITS.column, true));
    if (!Array.isArray(block.rows) || block.rows.length > LIMITS.rows) fail('Keep at most 50 table rows.');
    const rows = [...block.rows].map(row => {
      if (!Array.isArray(row) || row.length !== columns.length) fail('Every table row must match its columns.');
      return [...row].map(value => text(value, LIMITS.cell, false));
    });
    return { kind: 'table', title, columns, rows };
  });
  return { schema: SCHEMA, blocks };
}

// A fence longer than every run in the data keeps hostile Markdown/HTML literal
// even in existing text-only Markdown renderers. Copy/context/export keep all text.
function tableFallback(envelope) {
  return normalizeEnvelope(envelope).blocks.map(block => {
    const lines = [block.title, block.columns.join(' | '), ...block.rows.map(row => row.join(' | '))];
    if (!block.rows.length) lines.push('(No rows)');
    const body = lines.join('\n');
    const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map(match => match[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}text\n${body}\n${fence}`;
  }).join('\n\n');
}

function isCompleteFallback(content, envelope) {
  if (typeof content !== 'string' || !content.trim()) return false;
  try { return content.endsWith(tableFallback(envelope)); } catch { return false; }
}

function normalizeMessage(message) {
  if (message?.answerBlocks === undefined) return { role: message?.role, content: message?.content };
  if (message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()) {
    fail('Assistant answer blocks require a nonempty text fallback.');
  }
  const answerBlocks = normalizeEnvelope(message.answerBlocks);
  const fallback = tableFallback(answerBlocks);
  const content = message.content.endsWith(fallback) ? message.content : `${message.content}\n\n${fallback}`;
  return { role: 'assistant', content, answerBlocks };
}

module.exports = { SCHEMA, LIMITS, AnswerBlocksError, normalizeEnvelope, tableFallback, isCompleteFallback, normalizeMessage };
