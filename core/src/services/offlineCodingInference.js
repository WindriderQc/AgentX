'use strict';

async function open(options) {
  require('dotenv').config({ quiet: true });
  for (const transport of require('../../config/logger').transports) if (transport.name === 'console') transport.silent = true;
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx');
  try {
    await require('./inferenceHostRegistry').load();
    const router = require('./modelRouterConfig');
    await router.ensureTaskModelOverridesLoaded({ force: true });
    await router.refreshPinCache();
    const check = require('../helpers/ollamaHostConfig').validateHostUrl(options.hostUrl);
    if (!check.valid) throw new Error(check.message || 'the inference host is not configured');
    const preferences = require('./hostPreferenceService');
    const { modelsMatch } = require('../helpers/modelNameNormalization');
    const pins = preferences.getPinnedModelNames(await preferences.getByHost(check.host));
    if (!pins.some(pin => modelsMatch(pin, options.model))) throw new Error('the selected model is not pinned on that host');
    const inference = require('../extensions/trustedRuntimeServices').createTrustedRuntimeServices().inference;
    return {
      target: { model: options.model, hostUrl: check.host },
      async infer(messages) {
        let result;
        try {
          result = await inference.execute({ mode: 'chat', model: options.model, messages, stream: false,
            think: false, temperature: 0, max_tokens: options.outputTokens, timeoutMs: options.timeoutMs,
            callerDetail: 'completed-coding-replay' }, { hostUrl: check.host, consumerContract: 'completed-coding-replay' });
        } catch (error) {
          const { refusedBeforeDispatch } = require('./routing/taskFallbackLadder');
          error.replay = refusedBeforeDispatch(error) ? 'busy' : 'stop';
          throw error;
        }
        const body = result?.body;
        if (!result?.ok || body?.done !== true || !body?.model || !modelsMatch(body.model, options.model)) {
          throw Object.assign(new Error('inference has no verified terminal response for the selected model'),
            { code: 'UNVERIFIED_INFERENCE', replay: 'stop', body });
        }
        return body;
      },
      async close() {
        await new Promise(resolve => setTimeout(resolve, 500));
        await mongoose.disconnect();
      }
    };
  } catch (error) { await mongoose.disconnect(); throw error; }
}

module.exports = { open };
