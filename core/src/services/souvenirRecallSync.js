'use strict';

// A souvenir the owner keeps, corrects or forgets reaches the private recall
// (Nestor's mail_recall) right away instead of at the next indexing run. The
// sync is debounced and runs after the decision has been saved: it never
// delays or fails the owner's action. Only an instance whose private recall is
// configured syncs; the recall service owns that check.

const DELAY_MS = 3000;
const LIMIT = 50;

function createSouvenirRecallSync({ recall = () => require('./ownerRecallService'),
  logger = null, delayMs = DELAY_MS, setTimer = setTimeout } = {}) {
  let timer = null, running = null, again = false;
  const configured = () => Boolean(recall().configured?.());

  async function run() {
    timer = null;
    if (running) { again = true; return running; }
    running = (async () => {
      try { return await recall().sync({ limit: LIMIT }); }
      catch (error) { logger?.warn?.('Souvenir recall sync failed; the next indexing run will retry', { error: error.message }); return null; }
      finally { running = null; if (again) { again = false; schedule(); } }
    })();
    return running;
  }

  function schedule() {
    if (!configured()) return false;
    if (timer) return true;
    timer = setTimer(run, delayMs);
    timer?.unref?.();
    return true;
  }

  return { schedule, run, configured };
}

const shared = createSouvenirRecallSync({ logger: (() => { try { return require('../../config/logger'); } catch { return null; } })() });

module.exports = { createSouvenirRecallSync, scheduleSouvenirRecallSync: () => shared.schedule() };
