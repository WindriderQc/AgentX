'use strict';

const crypto = require('node:crypto');
const PipelineTask = require('../../models/PipelineTask');
const workerTaskScope = require('../helpers/workerTaskScope');
const { SUMMARY_FIELDS, projectTaskRows } = require('./pipelineTaskProjectionReadService');

// Bounded, read-only attention projection over Core's next-action contract.
// It never claims, leases, heartbeats or counts an attempt: a read is only an
// observation. Engineering and private lanes stay separate queues.
const ACTIVE_STATUSES = ['queued', 'in_progress', 'review', 'blocked'];
const SCAN_LIMIT = 2000;
const DEFAULT_PAGE = 10;
const MAX_PAGE = 50;
const SCOPES = ['engineering', 'private'];
const SCHEMA = 'agentx.pipeline-attention/v1';

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_ATTENTION_QUERY' });
}

function text(value, max = 160) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw invalid('Attention filters are limited to 160 characters');
  return result;
}

function integer(value, fallback, { min, max }) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw invalid(`Pagination values must be integers from ${min} to ${max}`);
  return number;
}

function parseAttentionQuery(params = {}) {
  const scope = String(params.scope || 'engineering');
  if (!SCOPES.includes(scope)) throw invalid('scope must be engineering or private');
  const status = text(params.status);
  if (status && !['done', ...ACTIVE_STATUSES].includes(status)) throw invalid('status is not a supported task status');
  return {
    scope,
    filters: {
      status, service: text(params.service), lane: text(params.lane), epic: text(params.epic), search: text(params.search),
      task: text(params.task, 64), assignee: text(params.assignee, 80), alias: text(params.alias, 80),
    },
    offset: integer(params.offset, 0, { min: 0, max: SCAN_LIMIT }),
    limit: integer(params.limit, DEFAULT_PAGE, { min: 1, max: MAX_PAGE }),
  };
}

function scopeQuery(scope) {
  const rules = workerTaskScope();
  if (scope === 'engineering') return rules;
  return { $or: Object.entries(rules).map(([key, rule]) => ({ [key]: rule.$not })) };
}

// Mirrors the Pipeline board filters so the attention queue and the work table
// narrow the same records (accent-insensitive search, "unspecified" buckets).
function fold(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function identity(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
}
function matchesFilters(task, filters) {
  if (filters.epic && (task.epic || 'ungrouped') !== filters.epic) return false;
  if (filters.status && task.status !== filters.status) return false;
  if (filters.service && (task.service || 'unspecified') !== filters.service) return false;
  if (filters.lane && (task.source || 'unspecified') !== filters.lane) return false;
  if (filters.task && String(task.pipelineId) !== filters.task) return false;
  if (filters.assignee) {
    const owners = new Set([filters.assignee, filters.alias].map(identity).filter(Boolean));
    if (!owners.has(identity(task.assignee))) return false;
  }
  if (filters.search) {
    const haystack = [task.pipelineId, task.title, task.assignee, task.epic, task.service, task.source].map(fold).join(' ');
    if (!haystack.includes(fold(filters.search))) return false;
  }
  return true;
}

function compareItems(a, b) {
  return a.rank - b.rank || String(a.pipelineId).localeCompare(String(b.pipelineId), 'en', { numeric: true });
}

function attentionItem(task) {
  const next = task.nextAction;
  return {
    key: `${task.pipelineId}:${next.code}`, pipelineId: task.pipelineId, title: task.title || 'Untitled task',
    status: task.status, service: task.service || null, source: task.source || null,
    code: next.code, actor: next.actor, label: next.label, detail: next.detail, action: next.action,
    rank: next.rank, icon: next.icon, tone: next.tone, reference: next.reference, lastEvidenceAt: next.lastEvidenceAt,
  };
}

async function scanScope(scope, filters, now, scanLimit) {
  const statuses = filters.status ? ACTIVE_STATUSES.filter(status => status === filters.status) : ACTIVE_STATUSES;
  if (!statuses.length) return { items: [], candidateCount: 0, scannedCount: 0 };
  const query = { $and: [{ status: { $in: statuses } }, scopeQuery(scope)] };
  const [candidateCount, rows] = await Promise.all([
    PipelineTask.countDocuments(query),
    PipelineTask.find(query).select(SUMMARY_FIELDS).sort({ pipelineId: 1 }).limit(scanLimit).lean(),
  ]);
  const projected = await projectTaskRows(rows, { now, references: false });
  const items = projected.filter(task => task.nextAction?.attention && matchesFilters(task, filters))
    .map(attentionItem).sort(compareItems);
  return { items, candidateCount, scannedCount: rows.length };
}

function coverage({ candidateCount, scannedCount, items }, scanLimit) {
  const complete = scannedCount >= candidateCount;
  return {
    complete, candidateCount, scannedCount, scanLimit, order: 'pipelineId ascending',
    total: complete ? items.length : null,
    lowerBound: items.length,
    basis: complete
      ? 'Every open task in this scope was projected through Core next-action rules'
      : `Only the first ${scannedCount} of ${candidateCount} open tasks (pipelineId ascending) were projected; the total is unknown`,
  };
}

async function readAttention(params = {}, { now = new Date(), scanLimit = SCAN_LIMIT } = {}) {
  const { scope, filters, offset: requested, limit } = parseAttentionQuery(params);
  const otherScope = scope === 'engineering' ? 'private' : 'engineering';
  const primary = await scanScope(scope, filters, now, scanLimit);
  const known = primary.items.length;
  const offset = requested < known ? requested : Math.max(0, known - (known % limit || limit));
  const page = primary.items.slice(offset, offset + limit);
  const keys = primary.items.map(item => item.key);
  return {
    schema: SCHEMA, authority: 'core.pipeline', observedAt: now.toISOString(), scope,
    authorization: 'not_granted',
    filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
    order: 'next-action rank, then pipelineId',
    coverage: coverage(primary, scanLimit),
    page: { offset, requestedOffset: requested, limit, returnedCount: page.length,
      hasPrevious: offset > 0, hasNext: offset + page.length < known },
    items: page,
    signal: { fingerprint: crypto.createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16), keys },
    // The other queue is not scanned here; clients read it only when selected.
    otherScope: { scope: otherScope, count: null },
  };
}

module.exports = { readAttention, parseAttentionQuery, matchesFilters, SCAN_LIMIT, MAX_PAGE, DEFAULT_PAGE, SCHEMA };
