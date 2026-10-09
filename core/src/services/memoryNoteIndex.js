'use strict';

/**
 * Meaning index of the memory notes.
 *
 * Each note carries the embedding of its own text, in its own row. The note
 * stays the only memory: the vector is derived from it, is rebuilt from it,
 * and disappears with it. Nothing is copied to the shared document store, so a
 * search by meaning runs behind the same space boundary as every other read
 * of the notes.
 */

const { createHash } = require('node:crypto');
const fetch = require('node-fetch');
const MemoryNote = require('../../models/MemoryNote');
const { DEFAULT_TASK_MODELS } = require('./modelRouterDefaults');

const EMBED_TIMEOUT_MS = 20000;
const EMBED_TEXT_MAX = 4000;

const embeddingModel = () => DEFAULT_TASK_MODELS.embeddings.model;
// Older notes carry no content hash, so the index keeps its own mark of the
// text a vector was made from.
const textMark = text => createHash('sha256').update(String(text)).digest('hex');

// Core's own embedding route chooses the host, admits the call and refuses an
// input the model would cut, exactly as it does for the document store.
async function embedThroughCore(text, { model = embeddingModel() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3080}/api/inference/embed`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-service-caller': 'memory-notes' },
      body: JSON.stringify({ model, prompt: String(text).slice(0, EMBED_TEXT_MAX) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.embedding) || !body.embedding.length) {
      throw new Error(`embedding unavailable (HTTP ${response.status})`);
    }
    return body.embedding;
  } finally {
    clearTimeout(timer);
  }
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]; normA += a[index] * a[index]; normB += b[index] * b[index];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function createIndex({ embed = embedThroughCore, model = embeddingModel } = {}) {
  // The vector is stored only if the note still holds the text it was made
  // from: a correction that lands meanwhile gets its own vector.
  async function indexNote(id, text) {
    const embedding = await embed(text);
    const result = await MemoryNote.updateOne({ _id: id, text },
      { $set: { embedding, embeddingModel: model(), embeddedHash: textMark(text) } }, { timestamps: false });
    return result.matchedCount === 1;
  }
  const isCurrent = note => note.embeddingModel === model() && note.embeddedHash === textMark(note.text);

  // Notes written before the index, or under another embedding model.
  async function rebuild(filter = {}, { limit = 5000 } = {}) {
    const notes = await MemoryNote.find({ ...filter, status: { $ne: 'forgotten' } },
      { text: 1, embeddingModel: 1, embeddedHash: 1 }).limit(limit).lean();
    const stale = notes.filter(note => !isCurrent(note));
    const result = { model: model(), notes: notes.length, stale: stale.length, indexed: 0, failed: 0 };
    for (const note of stale) {
      try { if (await indexNote(note._id, note.text)) result.indexed += 1; } catch (error) { result.failed += 1; result.lastError = error.message; }
    }
    return result;
  }

  // `filter` is the caller's space boundary; this module never widens it.
  async function nearest(filter, queries, { limit = 3, minScore = 0 } = {}) {
    const notes = await MemoryNote.find(filter).select('+embedding').lean();
    const current = notes.filter(isCurrent);
    // Nothing indexed: there is nothing to compare, so no embedding is asked.
    if (!current.length) {
      return { results: queries.map(query => ({ query, hits: [] })), indexed: 0, unindexed: notes.length };
    }
    const results = [];
    for (const query of queries) {
      let vector;
      try { vector = await embed(query); } catch (error) { results.push({ query, error: error.message, hits: [] }); continue; }
      results.push({ query, hits: current
        .map(note => ({ note, score: cosine(vector, note.embedding) }))
        .filter(hit => hit.score >= minScore)
        .sort((a, b) => b.score - a.score).slice(0, limit) });
    }
    return { results, indexed: current.length, unindexed: notes.length - current.length };
  }

  return Object.freeze({ indexNote, rebuild, nearest, model });
}

module.exports = { createIndex, cosine, embedThroughCore, embeddingModel };
