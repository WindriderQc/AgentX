const mongoose = require('mongoose');
const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const { normalizeModelName } = require('./modelContextResolver');

async function persistProbeSnapshot(data, { signal, checkpoint } = {}) {
  const payload = { _id: new mongoose.Types.ObjectId(), ...data };
  checkpoint?.();
  let saved = null;
  try {
    const created = await ModelContextProbeSnapshot.create(
      [payload],
      signal ? { signal } : undefined
    );
    saved = Array.isArray(created) ? created[0] : created;
    checkpoint?.();
    return saved;
  } catch (error) {
    try {
      await ModelContextProbeSnapshot.updateOne(
        { _id: payload._id },
        {
          $setOnInsert: {
            modelName: payload.modelName,
            hostUrl: payload.hostUrl,
            hostId: payload.hostId,
            artifactDigest: payload.artifactDigest,
            runtimeFingerprint: payload.runtimeFingerprint,
            status: 'failed'
          },
          $set: {
            authorityStatus: 'rejected',
            authorityError: 'probe snapshot persistence raced profiler claim loss'
          }
        },
        { upsert: true }
      );
      error.authorityCompensated = true;
    } catch (compensationError) {
      error.compensationError = compensationError;
      error.retainAdmission = true;
      error.code = 'CONTEXT_PROBE_SNAPSHOT_RECONCILIATION_PENDING';
    }
    throw error;
  }
}

async function getProbeStatus(modelName, options = {}) {
  const filter = {
    modelName: normalizeModelName(modelName)
  };
  if (options.hostUrl) {
    filter.hostUrl = normalizeHostUrl(options.hostUrl);
  }
  return ModelContextProbeSnapshot.findOne(filter).sort({ testedAt: -1 }).lean();
}

module.exports = { persistProbeSnapshot, getProbeStatus };
