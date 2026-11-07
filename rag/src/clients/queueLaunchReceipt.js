'use strict';
const { publishRefusal } = require('../../../shared/queueLaunchReceipt.cjs');
const fetchWithTimeout = require('../utils/fetchWithTimeout');
const { configuredServiceOrigin, SERVICE_OUTBOUND_OPERATION_IDS, SERVICE_OUTBOUND_TIMEOUTS } = require('./serviceOutboundClient');

async function publish(receipt, dispatchId) {
  const origin = configuredServiceOrigin(process.env.CORE_PROXY_URL || 'http://localhost:3080');
  const operationId = SERVICE_OUTBOUND_OPERATION_IDS.CORE_QUEUE_REFUSED;
  return publishRefusal(receipt, dispatchId, async (path, body) => {
    const response = await fetchWithTimeout(origin + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-caller': 'rag' }, body: JSON.stringify(body) },
    SERVICE_OUTBOUND_TIMEOUTS[operationId], { operationId, expectedOrigins: [origin] });
    if (!response.ok) throw new Error(`Core refusal receipt needs reconciliation (HTTP ${response.status})`);
    return response.json();
  });
}
module.exports = { publish };
