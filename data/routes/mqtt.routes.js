const router = require('express').Router();
const mqttController = require('../controllers/mqttController');

// Broker monitor: connection state and the last messages kept in memory
router.get('/status', mqttController.status);
router.get('/messages', mqttController.messages);

// One message published by hand (QoS 0, never queued)
router.post('/publish', mqttController.publish);

module.exports = router;
