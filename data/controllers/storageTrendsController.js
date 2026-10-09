'use strict';

const storageTrends = require('../services/storageTrends');

/**
 * GET /storage/trends?root=&from=&to=&folder=&limit=
 * Without `root`, only the roots that have snapshots. See services/storageTrends.js.
 */
const getTrends = async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await storageTrends.trends(req.app.locals.db, req.query) });
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ status: 'error', message: error.message });
    next(error);
  }
};

module.exports = { getTrends };
