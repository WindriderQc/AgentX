/**
 * Benchmark Routes - Diagnostics
 * Judge validation + ground truth management
 *
 * Routes are registered directly on this router, in their original order,
 * by capability modules: validation, ground truth, calibration, governance.
 */

const express = require('express');
const router = express.Router();
const { registerJudgeValidationRoutes } = require('./diagnosticsValidation');
const { registerGroundTruthRoutes } = require('./diagnosticsGroundTruth');
const { registerCalibrationRoutes } = require('./diagnosticsCalibration');
const { registerGovernanceRoutes } = require('./diagnosticsGovernance');

registerJudgeValidationRoutes(router);
registerGroundTruthRoutes(router);
registerCalibrationRoutes(router);
registerGovernanceRoutes(router);

module.exports = router;
