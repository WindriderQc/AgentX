'use strict';

/**
 * Local outbox of the public scoreboard: the exact tree a public site reads.
 *
 *   summary.json  leaderboard.json  efficiency.json  model-cards.json
 *   snapshots.json                  index of dated releases, newest first
 *   snapshots/<YYYY-MM-DD>.json     one release per day the content changed
 *
 * The outbox is the only history: nothing is read back from the public side.
 * Current files are rewritten only when the content changed, so their
 * `generatedAt` is the time of the last change.
 */

const fs = require('fs');
const path = require('path');
const { SCHEMA, assertPublicSafe } = require('./projection');

const DEFAULT_KEEP_SNAPSHOTS = 100;
const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}$/;
const CURRENT_FILES = ['summary.json', 'leaderboard.json', 'efficiency.json', 'model-cards.json'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temp, file);
}

function snapshotDate(isoTime, timeZone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(isoTime));
}

function readIndex(outbox) {
  const index = readJson(path.join(outbox, 'snapshots.json'), null);
  const snapshots = Array.isArray(index?.snapshots) ? index.snapshots : [];
  return snapshots.filter((entry) => SNAPSHOT_ID.test(entry?.snapshot_id || ''));
}

function snapshotEntry(id, publication) {
  const { files, hash } = publication;
  const summary = files['summary.json'];
  return {
    snapshot_id: id,
    title: `Scoreboard ${id}`,
    published_at: summary.generatedAt,
    modelCount: summary.metrics.models,
    testCount: files['leaderboard.json'].leaderboard.reduce((sum, row) => sum + row.totalTests, 0),
    topModel: summary.topModel ? summary.topModel.model : null,
    topScore: summary.topModel ? summary.topModel.generalistScore : null,
    file: `snapshots/${id}.json`,
    contentHash: hash,
  };
}

/**
 * Write a publication into the outbox.
 * Returns { status: 'changed' | 'unchanged', snapshotId, written, removed }.
 */
function writeOutbox(outbox, publication, { timeZone, keepSnapshots = DEFAULT_KEEP_SNAPSHOTS, force = false } = {}) {
  const root = path.resolve(outbox);
  const previous = readIndex(root);
  const latest = previous[0] || null;
  const currentPresent = CURRENT_FILES.every((name) => fs.existsSync(path.join(root, name)));
  if (!force && latest && latest.contentHash === publication.hash && currentPresent) {
    return { status: 'unchanged', snapshotId: latest.snapshot_id, written: [], removed: [] };
  }

  const generatedAt = publication.files['summary.json'].generatedAt;
  const id = snapshotDate(generatedAt, timeZone);
  const entry = snapshotEntry(id, publication);
  const kept = [entry, ...previous.filter((item) => item.snapshot_id !== id)]
    .sort((a, b) => b.snapshot_id.localeCompare(a.snapshot_id))
    .slice(0, Math.max(1, keepSnapshots));
  const files = { ...publication.files };
  files['summary.json'] = {
    ...files['summary.json'],
    metrics: { ...files['summary.json'].metrics, snapshots: kept.length },
  };
  const index = { schema: SCHEMA, generatedAt, snapshots: kept };
  const snapshot = {
    schema: SCHEMA,
    snapshot_id: id,
    published_at: generatedAt,
    summary: files['summary.json'],
    leaderboard: files['leaderboard.json'],
    efficiency: files['efficiency.json'],
  };
  const pending = { ...files, 'snapshots.json': index, [entry.file]: snapshot };
  assertPublicSafe(pending, publication.forbiddenTokens || []);

  const written = [];
  // Snapshot first, index last: a reader never sees an index entry without its file.
  for (const name of [entry.file, ...CURRENT_FILES, 'snapshots.json']) {
    writeJsonAtomic(path.join(root, name), pending[name]);
    written.push(name);
  }

  const keepFiles = new Set(kept.map((item) => path.basename(item.file)));
  const removed = [];
  const snapshotDir = path.join(root, 'snapshots');
  for (const name of fs.readdirSync(snapshotDir)) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && !keepFiles.has(name)) {
      fs.unlinkSync(path.join(snapshotDir, name));
      removed.push(`snapshots/${name}`);
    }
  }
  return { status: 'changed', snapshotId: id, written, removed };
}

module.exports = { CURRENT_FILES, DEFAULT_KEEP_SNAPSHOTS, readIndex, snapshotDate, writeOutbox };
