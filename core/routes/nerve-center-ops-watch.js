'use strict';

/**
 * Nerve Center — operations watch.
 *
 * The latest report, the watch settings (on/off, interval, language) and a
 * check on demand. Mounted at `/api/nerve-center`. Household-entry requests
 * already need an adult session (parental access middleware).
 */

const express = require('express');
const { getOpsWatch } = require('../src/services/opsWatchService');
const settingsStore = require('../src/services/opsWatchSettings');

const router = express.Router();

function fail(res, error) {
  const status = error?.status || 500;
  return res.status(status).json({
    status: 'error', code: error?.code || 'OPS_WATCH_FAILED', message: error?.message || 'Operations watch failed'
  });
}

function settingsView(settings) {
  return {
    enabled: settings.enabled,
    intervalMinutes: Math.round(settings.intervalMs / 60000),
    language: settings.language,
    source: settings.source,
    minMinutes: settingsStore.MIN_MINUTES,
    maxMinutes: settingsStore.MAX_MINUTES
  };
}

router.get('/ops-watch', async (_req, res) => {
  try {
    const watch = getOpsWatch();
    const { scheduled, checking } = watch.state();
    return res.json({ status: 'success', data: {
      report: watch.latest(), settings: settingsView(await settingsStore.effective()), scheduled, checking
    } });
  } catch (error) {
    return fail(res, error);
  }
});

router.put('/ops-watch/settings', async (req, res) => {
  try {
    const settings = await settingsStore.save(req.body || {});
    const watch = getOpsWatch();
    watch.configure(settings);
    return res.json({ status: 'success', data: { settings: settingsView(settings), scheduled: watch.state().scheduled } });
  } catch (error) {
    return fail(res, error);
  }
});

// The model can take minutes on a slow host: answer at once, the card polls.
router.post('/ops-watch/check', async (_req, res) => {
  try {
    const watch = getOpsWatch();
    const alreadyChecking = watch.state().checking;
    if (!alreadyChecking) {
      const { language } = await settingsStore.effective();
      watch.setLanguage(language);
      watch.tick();
    }
    return res.status(202).json({ status: 'success', data: { checking: true, alreadyChecking } });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;
