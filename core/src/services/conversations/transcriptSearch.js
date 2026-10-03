'use strict';

const store = require('./transcriptStore');

function parseSearch(search) {
  const positive = [], negative = [], phrases = [], negativePhrases = [];
  for (const token of search.match(/-?"[^"]*"|[^\s]+/g) || []) {
    const negated = token.startsWith('-'), value = negated ? token.slice(1) : token;
    if (value.startsWith('"') && value.endsWith('"')) {
      const phrase = value.slice(1, -1);
      (negated ? negativePhrases : phrases).push(phrase);
      if (!negated) positive.push(phrase);
    } else (negated ? negative : positive).push(value);
  }
  return { positive: positive.join(' '), negative: negative.join(' '), phrases, negativePhrases };
}

function normalize(value, expression) {
  let result = String(value);
  if (!expression.$diacriticSensitive) result = result.normalize('NFD').replace(/\p{M}/gu, '');
  if (!expression.$caseSensitive) result = result.toLowerCase();
  return result;
}

// Mongo indexes provide stemming, language handling and term scores.
// Negations apply to the whole current conversation; exact phrases are checked
// on complete messages, including across binary and search chunk boundaries.
async function resolveTextMatches(model, expression, scope = {}) {
  const query = parseSearch(expression.$search);
  if (!query.positive.trim()) return [];
  const pages = model.db.collection('conversation_transcript_pages');
  const chunks = model.db.collection('conversation_payload_chunks');
  await pages.createIndex({ searchContent: 'text' },
    { name: 'transcript_full_text_search', weights: { searchContent: 5 } });
  await chunks.createIndex({ searchText: 'text' }, { name: 'payload_text_search', weights: { searchText: 5 } });
  const roots = await model.collection.find(scope,
    { projection: { _id: 1, transcript: 1, title: 1 } }).toArray();
  if (!roots.length) return [];
  const rootIds = roots.map(row => row._id), pageIds = [], searchIds = [], current = new Map();
  for (const row of roots) {
    const items = row.transcript ? await store.readPageItems(row._id, row.transcript) : [];
    const indexedPages = row.transcript?.pages.length ? await pages.find({ _id: { $in: row.transcript.pages },
      owner: String(row._id) }).toArray() : [];
    if (indexedPages.some(page => JSON.stringify(page.searchContent)
      !== JSON.stringify(page.items.filter(item => !item._payload).map(item => item.content || '')))) {
      throw Object.assign(new Error('Conversation page search metadata is missing or corrupt.'),
        { code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE', statusCode: 503 });
    }
    if (items.some(message => message._payload?.searchUnavailable)) {
      throw Object.assign(new Error('A complete search token exceeds the safe index document size.'),
        { code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE', statusCode: 503 });
    }
    const ids = items.flatMap(message => message._payload?.searchIds || []);
    await store.readSearchTexts(row._id, ids);
    pageIds.push(...(row.transcript?.pages || []));
    searchIds.push(...ids);
    current.set(String(row._id), { ...row, items });
  }

  async function collect(search) {
    const text = { ...expression, $search: search };
    const rootMatches = await model.collection.find({ _id: { $in: rootIds }, $text: text },
      { projection: { _id: 1, score: { $meta: 'textScore' } } }).toArray();
    const pageMatches = pageIds.length ? await pages.find({ _id: { $in: pageIds }, $text: text },
      { projection: { _id: 1, score: { $meta: 'textScore' } } }).toArray() : [];
    const chunkMatches = searchIds.length ? await chunks.find({ _id: { $in: searchIds }, $text: text },
      { projection: { _id: 1, score: { $meta: 'textScore' } } }).toArray() : [];
    const pageScores = new Map(pageMatches.map(row => [row._id, row.score]));
    const chunkScores = new Map(chunkMatches.map(row => [row._id, row.score]));
    if (chunkScores.size) {
      const payloadPages = await pages.find({ _id: { $in: pageIds },
        'items._payload.searchIds': { $in: [...chunkScores.keys()] } },
      { projection: { _id: 1, 'items._payload.searchIds': 1 } }).toArray();
      for (const page of payloadPages) {
        const score = Math.max(0, ...page.items.flatMap(message =>
          (message._payload?.searchIds || []).map(id => chunkScores.get(id) || 0)));
        pageScores.set(page._id, Math.max(pageScores.get(page._id) || 0, score));
      }
    }
    const result = new Map(rootMatches.map(row => [String(row._id), row.score]));
    for (const row of roots) {
      const score = (row.transcript?.pages || []).reduce((sum, id) => sum + (pageScores.get(id) || 0), 0);
      if (score) result.set(String(row._id), (result.get(String(row._id)) || 0) + score);
    }
    return result;
  }

  const positive = await collect(query.positive);
  const excluded = query.negative ? await collect(query.negative) : new Map();
  const result = [];
  for (const [id, score] of positive) {
    if (excluded.has(id)) continue;
    const row = current.get(id);
    if (query.phrases.length || query.negativePhrases.length) {
      const messages = row.transcript ? await store.expandMessages(row._id, row.items)
        : (await model.collection.findOne({ _id: row._id })).messages || [];
      const texts = [row.title, ...messages.map(message => message.content)].map(value => normalize(value || '', expression));
      const includes = phrase => texts.some(text => text.includes(normalize(phrase, expression)));
      if (!query.phrases.every(includes) || query.negativePhrases.some(includes)) continue;
    }
    result.push({ _id: row._id, score });
  }
  return result;
}

function replaceTextScore(value, scores) {
  if (Array.isArray(value)) return value.map(entry => replaceTextScore(entry, scores));
  if (!value || typeof value !== 'object' || value._bsontype || value instanceof Date || value instanceof RegExp) return value;
  if (value.$meta === 'textScore') return scores.length ? { $switch: { branches: scores.map(row =>
    ({ case: { $eq: ['$_id', row._id] }, then: row.score })), default: 0 } } : { $literal: 0 };
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceTextScore(entry, scores)]));
}

module.exports = { resolveTextMatches, replaceTextScore };
