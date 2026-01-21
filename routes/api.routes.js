const express = require('express');
const router = express.Router();

const metricsRoutes = require('./metrics');

router.use('/metrics', metricsRoutes);

// NOTE: config-variants routes are now mounted directly in src/app.js
// router.use('/config-variants', configVariantRoutes);

module.exports = router;
