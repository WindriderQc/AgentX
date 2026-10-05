/**
 * Integrations — webhook sink for ClickUp and other sources.
 */
const router = require('express').Router();
const ctrl = require('../controllers/integrationController');

router.post('/webhooks/clickup', ctrl.createClickUpEvent);
router.post('/webhooks/:source', ctrl.createWebhookEvent);

module.exports = router;
