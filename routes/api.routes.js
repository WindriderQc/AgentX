const express = require('express');
const router = express.Router();

const metricsRoutes = require('./metrics');

router.use('/metrics', metricsRoutes);

module.exports = router;
