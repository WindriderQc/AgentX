'use strict';
const { createApp } = require('./src/app');
const { loadConfig } = require('./src/config');
const { createStateRepository } = require('../../src/domains/psyx/stateRepository');
const { createConversationAdapter } = require('./src/conversations');
const { createCoreProvider } = require('./src/provider');
const { createOpenClawAgentClient } = require('../../src/services/frontier/openclawAgentClient');
const { createSources } = require('./src/sources');

function register({ app, mongoose, runtimeServices, conversationLifecycle, logger }) {
  const collection = mongoose.connection.collection('psyxstates');
  const domain = createStateRepository({ collection, logger });
  let stateIndex;
  const ensureStateIndex = () => stateIndex ||= collection.createIndex({ userId: 1 },
    { unique: true, name: 'psyx_state_user_unique' }).catch(error => { stateIndex = null; throw error; });
  // Never run the legacy duplicate-merge/delete helper during application startup.
  // Imported conflicts must be reviewed before a unique owner index can be built.
  const stateRepository = Object.fromEntries(['read', 'addItem', 'updateItem', 'deleteItem', 'addExperiment', 'updateExperiment', 'reset',
    'recordReview', 'forgetConversation', 'acceptProposal', 'rejectProposal', 'addCheckIn', 'addAssessment', 'updateSettings', 'updateProfile',
    'recordDream', 'undoDream', 'rejectPortraitStatement', 'clearPortrait', 'dreamUserIds']
    .map(name => [name, async (...args) => { await ensureStateIndex(); return domain[name](...args); }]));
  const database = {
    stateRepository,
    conversationRepository: createConversationAdapter({ conversationLifecycle }),
    recapForUser: userId => runtimeServices.conversationRecaps.forOwner({ userId: `surface:psyx:${userId}`, promptName: 'psyx' }),
    preferencesForUser: userId => runtimeServices.conversationPreferences.forOwner({ ownerId: `surface:psyx:${userId}`, surface: 'psyx' }),
    preferencesChanged: userId => collection.updateOne({ userId }, { $inc: { revision: 1 } }),
    generateRecap: require('../../src/services/conversationRecapService').localRecapGenerator(runtimeServices.inference, 'psyx'),
    async ping() { await mongoose.connection.db.command({ ping: 1 }); return true; }
  };
  const config = loadConfig();
  // Human Core access follows the private LAN; native bearer credentials stay independent.
  config.accessMode = 'trusted-network';
  // The dream reads the owner's other information in-process and read-only (ADR 0002).
  const sources = createSources({ runtimeServices, mailJournal: require('../../src/services/mailJournalService'), logger });
  const psyx = createApp({ config, database, provider: createCoreProvider(runtimeServices, { frontier: createOpenClawAgentClient(), config, logger }), logger, sources, productApp: app });
  psyx.locals.dreamer.start();
  app.use((req, res, next) => /^\/(?:psyx(?:\/|$)|api\/psyx(?:\/|$))/i.test(req.path)
    ? psyx(req, res, next) : next());
}

module.exports = { register };
