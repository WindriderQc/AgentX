'use strict';

// Model-call waits of autonomous attempts (#363). The pipeline attribution
// lease marks each model call with workItemId = pipelineId and the attempt
// number; its inferencelogs row records what the call waited for before Ollama
// received it. Read-only, Core clock, durations and counts only.
const InferenceLog = require('../../models/InferenceLog');
const { resourceWaitKey } = require('./pipelineAttemptPhases');

const numberOrZero = (field) => ({ $cond: [{ $isNumber: field }, field, 0] });

// Admission and gate waits of the failed attempts a retried call went through.
const RETRIED_ATTEMPT_WAITS = Object.freeze({
  $reduce: {
    input: { $cond: [{ $isArray: '$retry.history' }, '$retry.history', []] },
    initialValue: 0,
    in: { $add: ['$$value', numberOrZero('$$this.admissionMs'), numberOrZero('$$this.hostGateMs')] },
  },
});

/**
 * Per attempt (`resourceWaitKey(pipelineId, attempt)`): attributed model calls,
 * the calls carrying a measured admission wait, and the summed waits.
 */
async function readAttemptResourceWaits(tasks, { from, to }, { model = InferenceLog } = {}) {
  const pipelineIds = [...new Set(tasks.map((task) => task?.pipelineId)
    .filter((id) => typeof id === 'string' && id))];
  const waits = new Map();
  if (pipelineIds.length === 0) return waits;
  const rows = await model.aggregate([
    { $match: { workItemId: { $in: pipelineIds }, timestamp: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { workItemId: '$workItemId', attempt: '$attempt' },
        calls: { $sum: 1 },
        measuredCalls: { $sum: { $cond: [{ $isNumber: '$admissionWaitMs' }, 1, 0] } },
        waitMs: {
          $sum: {
            $add: [
              numberOrZero('$admissionWaitMs'), numberOrZero('$hostGateWaitMs'),
              numberOrZero('$retry.delayMs'), RETRIED_ATTEMPT_WAITS,
            ]
          }
        },
      }
    },
  ]);
  for (const row of rows) {
    waits.set(resourceWaitKey(row._id?.workItemId, row._id?.attempt), {
      calls: row.calls || 0,
      measuredCalls: row.measuredCalls || 0,
      waitMs: Math.round(row.waitMs || 0),
    });
  }
  return waits;
}

module.exports = { readAttemptResourceWaits };
