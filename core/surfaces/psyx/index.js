'use strict';
const { createApp } = require('./src/app');
const { loadConfig } = require('./src/config');
const { createStateRepository } = require('../../src/domains/psyx/stateRepository');
const { createConversationAdapter } = require('./src/conversations');
const { createCoreProvider } = require('./src/provider');
const { createOpenClawAgentClient } = require('../../src/services/frontier/openclawAgentClient');
const { createAuth } = require('./src/auth');
const { createSources } = require('./src/sources');

function register({ app, mongoose, runtimeServices, conversationLifecycle, logger, parentalAccess }) {
  const collection = mongoose.connection.collection('psyxstates');
  const domain = createStateRepository({ collection, logger });
  let stateIndex;
  const ensureStateIndex = () => stateIndex ||= collection.createIndex({ userId: 1 },
    { unique: true, name: 'psyx_state_user_unique' }).catch(error => { stateIndex = null; throw error; });
  // Never run the legacy duplicate-merge/delete helper during application startup.
  // Imported conflicts must be reviewed before a unique owner index can be built.
  const stateRepository = Object.fromEntries(['read', 'addItem', 'updateItem', 'deleteItem', 'addExperiment', 'updateExperiment', 'reset',
    'recordReview', 'forgetConversation', 'acceptProposal', 'rejectProposal', 'addCheckIn', 'updateSettings', 'updateProfile',
    'recordDream', 'undoDream', 'rejectPortraitStatement', 'clearPortrait', 'dreamUserIds']
    .map(name => [name, async (...args) => { await ensureStateIndex(); return domain[name](...args); }]));
  const database = {
    stateRepository,
    conversationRepository: createConversationAdapter({ conversationLifecycle }),
    async ping() { await mongoose.connection.db.command({ ping: 1 }); return true; }
  };
  const config = loadConfig();
  let accessAuth;
  if (parentalAccess) {
    const native = createAuth(config);
    config.accessToken = parentalAccess.accessToken || config.accessToken;
    config.sessionTtlMs = parentalAccess.sessionTtlMs;
    const select = req => parentalAccess.isEntry(req) ? parentalAccess.auth : native;
    accessAuth = {
      isLoopback: native.isLoopback,
      // Through the gateway, a parental code stored from the host counts too.
      configured: req => parentalAccess.isEntry(req) && parentalAccess.code.configured(),
      current: req => select(req).current(req),
      unlock: (req, res, code) => select(req).unlock(req, res, code),
      lock: (req, res) => select(req).lock(req, res),
      requireSession(req, res, next) {
        const session = select(req).current(req);
        if (!session) return res.status(401).json({ ok: false, code: 'PSYX_LOCKED', message: 'Entre le code parental pour ouvrir cet espace.' });
        res.locals.psyxUserId = session.userId;
        return next();
      }
    };
  }
  // The dream reads the owner's other information in-process and read-only (ADR 0002).
  const sources = createSources({ runtimeServices, mailJournal: require('../../src/services/mailJournalService'), logger });
  const psyx = createApp({ config, database, provider: createCoreProvider(runtimeServices, { frontier: createOpenClawAgentClient(), config, logger }), logger, accessAuth, sources, productApp: app });
  psyx.locals.dreamer.start();
  app.use((req, res, next) => /^\/(?:psyx(?:\/|$)|api\/psyx(?:\/|$))/i.test(req.path)
    ? psyx(req, res, next) : next());
}

module.exports = { register };
