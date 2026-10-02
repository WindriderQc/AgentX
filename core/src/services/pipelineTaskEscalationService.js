'use strict';

const Alert = require('../../models/Alert');
const { readEscalationPage, readTaskDiagnosis } = require('./pipelineTaskDiagnosisReadService');

const RULE_ID = 'pipeline-task-escalation';

async function recordEscalation(diagnosis) {
  const key = diagnosis.escalation.key;
  const recordedAt = new Date();
  try {
    const result = await Alert.updateOne({ ruleId: RULE_ID, fingerprint: key }, {
      $setOnInsert: {
        ruleName: 'Pipeline task needs inspection',
        severity: diagnosis.category === 'recovery_required' ? 'error' : 'warning',
        status: 'active',
        title: `Pipeline task ${diagnosis.pipelineId} needs inspection`,
        message: `Task ${diagnosis.pipelineId}: ${diagnosis.code}. Inspect the diagnosis before changing its status.`,
        context: { component: 'pipeline', additionalData: {
          pipelineId: diagnosis.pipelineId, diagnosisCode: diagnosis.code, escalationKey: key,
        } },
        channels: [],
        source: 'agentx-core',
        tags: ['pipeline', 'task-diagnosis'],
        createdAt: recordedAt,
        updatedAt: recordedAt,
      },
    }, { upsert: true, timestamps: false });
    return result.upsertedCount === 1;
  } catch (err) {
    // A second Core instance may win the unique fingerprint insert.
    if (err.code === 11000) return false;
    throw err;
  }
}

// Runs on the existing alert sweep, never on a diagnosis GET. Re-reading each
// candidate avoids recording a key that cleared between the page and write.
// This service never resolves by absence: a concurrent Core scan may observe
// older task state, and an operator owns acknowledgment and resolution.
async function reconcilePipelineTaskEscalations({ now = new Date() } = {}) {
  const activeKeys = new Set();
  let after = null;
  let created = 0;
  do {
    const page = await readEscalationPage({ after, now });
    for (const candidate of page.items) {
      const current = await readTaskDiagnosis(candidate.pipelineId);
      if (!current?.escalation || current.escalation.key !== candidate.escalation.key) continue;
      activeKeys.add(current.escalation.key);
      if (await recordEscalation(current)) created += 1;
    }
    after = page.next;
  } while (after);

  return { observed: activeKeys.size, created };
}

module.exports = { RULE_ID, reconcilePipelineTaskEscalations };
