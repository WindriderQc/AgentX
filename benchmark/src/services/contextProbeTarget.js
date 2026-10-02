const ModelProfile = require('../../models/ModelProfile');
const { showModel } = require('../clients/ollamaClient');
const { normalizeHostUrl, getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../helpers/ollamaTargetAdmission');
const { normalizeModelName } = require('./modelContextResolver');
const logger = require('../../config/logger');

async function resolveHostUrl(modelName, explicitHostUrl) {
  if (explicitHostUrl) {
    return admitOllamaTargetResolved(explicitHostUrl, { configuredHosts: getConfiguredHosts() });
  }

  const entry = await ModelProfile.findOne({
    $or: [
      { name: normalizeModelName(modelName) }
    ]
  }).lean();

  const hostUrl = normalizeHostUrl(entry?.sourceHost || entry?.host || null);
  if (!hostUrl) {
    throw new Error(`No host URL found for model: ${modelName}`);
  }

  return admitOllamaTargetResolved(hostUrl, { configuredHosts: getConfiguredHosts() });
}

async function fetchModelMetadata(hostUrl, modelName, options = {}) {
  try {
    const data = await showModel(hostUrl, modelName, { signal: options.signal });
    const info = data.model_info || {};
    let theoreticalMax = null;
    for (const key of Object.keys(info)) {
      if (key.includes('context_length') && typeof info[key] === 'number') {
        theoreticalMax = info[key];
        break;
      }
    }
    return {
      theoreticalMax,
      modelInfo: info,
      family: data.details?.family || null,
      families: Array.isArray(data.details?.families) ? data.details.families : [],
      architecture: info['general.architecture'] || data.details?.family || null
    };
  } catch (err) {
    if (options.signal?.aborted) throw (options.signal.reason instanceof Error ? options.signal.reason : err);
    logger.warn('Failed to fetch model theoretical max', { hostUrl, modelName, error: err.message });
    return { theoreticalMax: null, modelInfo: {}, family: null, families: [], architecture: null };
  }
}

async function fetchModelTheoreticalMax(hostUrl, modelName) {
  const metadata = await fetchModelMetadata(hostUrl, modelName);
  return metadata.theoreticalMax;
}

module.exports = { resolveHostUrl, fetchModelMetadata, fetchModelTheoreticalMax };
