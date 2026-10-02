/**
 * Process-local active batch state: the single owner of the running batch id
 * and its activity heartbeat interval.
 */

let activeBatchId = null;
let activeHeartbeatInterval = null;

function getActiveBatchId() {
    return activeBatchId;
}

function getActiveHeartbeatInterval() {
    return activeHeartbeatInterval;
}

function clearActiveBatch() {
    if (activeHeartbeatInterval) {
        clearInterval(activeHeartbeatInterval);
        activeHeartbeatInterval = null;
    }
    activeBatchId = null;
}

function setActiveBatchId(batchId) {
    activeBatchId = batchId;
}

function setActiveHeartbeatInterval(interval) {
    activeHeartbeatInterval = interval;
}

module.exports = {
    getActiveBatchId,
    getActiveHeartbeatInterval,
    clearActiveBatch,
    setActiveBatchId,
    setActiveHeartbeatInterval
};
