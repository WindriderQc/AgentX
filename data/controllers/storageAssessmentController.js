'use strict';
const { readStorageAssessment } = require('../services/storageAssessment');

async function getAssessment(req, res, next) {
  try {
    if (Object.keys(req.query).length) {
      return res.status(400).json({ status: 'error', message: 'Storage assessment accepts no arguments' });
    }
    res.json({ status: 'success', data: await readStorageAssessment(req.app.locals.db) });
  } catch (error) { next(error); }
}

module.exports = { getAssessment };
