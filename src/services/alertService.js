const logger = require('../../config/logger');

let alertServiceInstance = null;

class AlertService {
    async triggerAlert(type, severity, payload) {
        logger.warn('Alert triggered', { type, severity, payload });
        return { type, severity, payload };
    }
}

function getAlertService() {
    if (!alertServiceInstance) {
        alertServiceInstance = new AlertService();
    }
    return alertServiceInstance;
}

module.exports = { getAlertService };
