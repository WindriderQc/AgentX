'use strict';

// Finance inbox: statements dropped in FINANCE_INBOX_PATH are ingested one at a
// time. A reconciled or already-known document moves to
// FINANCE_ARCHIVE_PATH/<year>/, a document that does not reconcile moves to
// FINANCE_REVIEW_PATH, and a refused inference (busy host) leaves the file in
// place for the next scan. Off unless both paths are absolute.

const fs = require('fs/promises');
const path = require('path');
const { ingestDocument, setArchivePath } = require('./financeIngestionService');

const DEFAULT_POLL_MS = 15 * 60 * 1000;
const RETRYABLE_STATUSES = new Set([409, 429, 499, 503]);

function config(env = process.env) {
  const inbox = String(env.FINANCE_INBOX_PATH || '').trim();
  const archive = String(env.FINANCE_ARCHIVE_PATH || '').trim();
  const review = String(env.FINANCE_REVIEW_PATH || '').trim() || (inbox ? path.join(inbox, 'a-verifier') : '');
  const pollMs = Number.parseInt(env.FINANCE_INBOX_POLL_MS, 10);
  return {
    enabled: path.isAbsolute(inbox) && path.isAbsolute(archive) && path.isAbsolute(review),
    inbox, archive, review,
    pollMs: Number.isFinite(pollMs) && pollMs >= 60000 ? pollMs : DEFAULT_POLL_MS
  };
}

async function moveInto(dir, filePath) {
  await fs.mkdir(dir, { recursive: true });
  const parsed = path.parse(filePath);
  let target = path.join(dir, parsed.base);
  for (let n = 2; await fs.access(target).then(() => true, () => false); n += 1) {
    target = path.join(dir, `${parsed.name}-${n}${parsed.ext}`);
  }
  try {
    await fs.rename(filePath, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(filePath, target);
    await fs.unlink(filePath);
  }
  return target;
}

function createFinanceInbox({ env = process.env, ingest = ingestDocument, logger = console,
  refreshAlerts = () => require('./financeAlerts').refresh() } = {}) {
  const settings = config(env);
  const state = { running: false, lastScanAt: null, lastResults: [], timer: null };

  async function processFile(filePath, ledger = 'perso') {
    const archiveRoot = ledger === 'corp' ? path.join(settings.archive, 'corp') : settings.archive;
    const reviewRoot = ledger === 'corp' ? path.join(settings.review, 'corp') : settings.review;
    try {
      const result = await ingest(filePath, { ledger });
      if (result.outcome === 'needs_review') {
        return { ...result, ledger, movedTo: await moveInto(reviewRoot, filePath) };
      }
      const year = (result.statementKey || '').split('|')[3]?.slice(0, 4) || String(new Date().getFullYear());
      const movedTo = await moveInto(path.join(archiveRoot, year), filePath);
      if (result.outcome === 'reconciled') await setArchivePath(result.statementId, movedTo);
      return { ...result, ledger, movedTo };
    } catch (error) {
      const retryLater = RETRYABLE_STATUSES.has(error.status);
      logger.warn?.(`Finance inbox: ${path.basename(filePath)} ${retryLater ? 'deferred' : 'failed'} (${error.code || error.message})`);
      if (retryLater) return { outcome: 'deferred', fileName: path.basename(filePath), code: error.code || null };
      return {
        outcome: 'failed', fileName: path.basename(filePath), code: error.code || null, error: error.message,
        movedTo: await moveInto(reviewRoot, filePath).catch(() => null)
      };
    }
  }

  async function scanOnce() {
    if (!settings.enabled) {
      throw Object.assign(new Error('Finance inbox is not configured'), { code: 'FINANCE_INBOX_DISABLED', status: 409 });
    }
    if (state.running) return { started: false, reason: 'scan_in_progress' };
    state.running = true;
    try {
      const pdfs = async (dir, ledger) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name))
        .map((entry) => ({ filePath: path.join(dir, entry.name), ledger })).sort((a, b) => a.filePath.localeCompare(b.filePath));
      const files = [...await pdfs(settings.inbox, 'perso'), ...await pdfs(path.join(settings.inbox, 'corp'), 'corp')];
      const results = [];
      for (const { filePath, ledger } of files) {
        const result = await processFile(filePath, ledger);
        results.push(result);
        if (result.outcome === 'deferred') break;
      }
      state.lastScanAt = new Date().toISOString();
      state.lastResults = results;
      if (results.some((result) => ['reconciled', 'needs_review'].includes(result.outcome))) {
        await refreshAlerts().catch((error) => logger.warn?.(`Finance alerts refresh failed: ${error.message}`));
      }
      return { started: true, results };
    } finally {
      state.running = false;
    }
  }

  function start() {
    if (!settings.enabled || state.timer) return false;
    state.timer = setInterval(() => {
      scanOnce().catch((error) => logger.warn?.(`Finance inbox scan failed: ${error.message}`));
    }, settings.pollMs);
    state.timer.unref?.();
    return true;
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function status() {
    return {
      enabled: settings.enabled, pollMs: settings.pollMs, scheduled: Boolean(state.timer),
      running: state.running, lastScanAt: state.lastScanAt, lastResults: state.lastResults
    };
  }

  return { scanOnce, start, stop, status, settings };
}

let shared = null;
function financeInbox() {
  shared = shared || createFinanceInbox();
  return shared;
}

module.exports = { createFinanceInbox, financeInbox, config };
