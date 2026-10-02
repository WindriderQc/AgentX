'use strict';

const MailJournalEntry = require('../../models/MailJournalEntry');
const { sealText } = require('./identifierVault');

// The mail journal holds dated digests of the owner's mail so they stay out of
// memory notes. Entries expire after MAIL_JOURNAL_RETENTION_DAYS (default 365,
// 0 keeps them); recording the same thread/message again replaces its entry.
const DEFAULT_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'MAIL_JOURNAL_INVALID' });

function retentionDays(env = process.env) {
  const raw = env.MAIL_JOURNAL_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const value = Number(raw);
  if (value === 0) return 0;
  // A typo must not silently keep mail forever: anything else falls back.
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RETENTION_DAYS;
}

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw error(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw error(`${field} must be text of at most ${max} characters`);
  const trimmed = value.trim();
  if (required && !trimmed) throw error(`${field} is required`);
  return trimmed;
}

function identifier(value, field, { required = false } = {}) {
  const id = text(value, field, 200, { required });
  if (/[\u0000-\u001f]/.test(id)) throw error(`${field} cannot contain control characters`);
  return id;
}

function dateOf(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw error(`${field} must be an ISO date`);
  return date;
}

function project(row) {
  return { id: String(row._id), threadId: row.threadId, messageId: row.messageId || null,
    occurredAt: row.occurredAt, subject: row.subject, counterpart: row.counterpart, summary: row.summary,
    tags: row.tags || [], sourceRef: row.sourceRef || null, source: row.source,
    createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: row.expiresAt || null };
}

async function record(input = {}, { now = new Date(), days = retentionDays() } = {}) {
  const threadId = identifier(input.threadId, 'threadId', { required: true });
  const messageId = identifier(input.messageId, 'messageId');
  const occurredAt = dateOf(input.occurredAt, 'occurredAt');
  if (occurredAt.getTime() > now.getTime() + DAY_MS) throw error('occurredAt cannot be in the future');
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags) || tags.length > 12 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) {
    throw error('tags must be at most 12 short labels');
  }
  const values = {
    threadId, messageId, occurredAt,
    subject: text(input.subject, 'subject', 300),
    counterpart: text(input.counterpart, 'counterpart', 200),
    summary: text(input.summary, 'summary', 4000, { required: true }),
    tags: [...new Set(tags.map(tag => tag.trim().toLowerCase()))],
    sourceRef: text(input.sourceRef, 'sourceRef', 500),
    source: /^[a-z0-9-]{1,40}$/.test(input.source || '') ? input.source : 'secretary',
    sensitivity: input.sensitivity === 'highly_private' ? 'highly_private' : 'private',
    // Retention counts from when the mail happened, not from when it was filed.
    expiresAt: days ? new Date(occurredAt.getTime() + days * DAY_MS) : null
  };
  values.summary = (await sealText(values.summary, { seenIn: 'mail-journal' })).text;
  values.subject = (await sealText(values.subject, { seenIn: 'mail-journal' })).text;
  if (values.expiresAt && values.expiresAt <= now) {
    return { ok: true, authority: 'agentx.core', recorded: false, reason: 'older than the journal retention' };
  }
  const key = `${threadId}\n${messageId}`;
  const write = upsert => MailJournalEntry.findOneAndUpdate({ key }, { $set: values, $setOnInsert: { key } },
    { new: true, upsert, runValidators: true, includeResultMetadata: true });
  let result;
  try {
    result = await write(true);
  } catch (failure) {
    if (failure.code !== 11000) throw failure;
    // A concurrent first record of the same key won; replace its entry.
    result = await write(false);
  }
  return { ok: true, authority: 'agentx.core', recorded: true,
    created: Boolean(result.lastErrorObject?.upserted), entry: project(result.value) };
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function search(input = {}) {
  const filter = {};
  const query = text(input.query, 'query', 500);
  if (query) {
    const pattern = { $regex: escapeRegex(query), $options: 'i' };
    filter.$or = [{ summary: pattern }, { subject: pattern }, { counterpart: pattern }, { tags: query.toLowerCase() }];
  }
  if (input.threadId !== undefined) filter.threadId = text(input.threadId, 'threadId', 200, { required: true });
  if (input.since !== undefined || input.until !== undefined) {
    filter.occurredAt = {};
    if (input.since !== undefined) filter.occurredAt.$gte = dateOf(input.since, 'since');
    if (input.until !== undefined) filter.occurredAt.$lte = dateOf(input.until, 'until');
  }
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(input.limit)) || 10));
  const [rows, total] = await Promise.all([
    MailJournalEntry.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(limit).lean(),
    MailJournalEntry.countDocuments(filter)
  ]);
  return { ok: true, authority: 'agentx.core', entries: rows.map(project), total, truncated: rows.length < total };
}

async function operate(input = {}) {
  const action = input.action || input.operation;
  if (action === 'record') return { ...await record(input), action };
  if (action === 'search') return { ...await search(input), action };
  throw error('Choose record or search');
}

module.exports = { DEFAULT_RETENTION_DAYS, retentionDays, record, search, operate };
