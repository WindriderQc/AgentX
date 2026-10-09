'use strict';

// The surface translates HTTP only. Core owns profiles, task IDs, persistence
// and the family check-in / approval / recurrence workflow.
const { shoppingList: defaultShoppingList } = require('../../src/services/shoppingListService');
const defaultIdeaInbox = require('../../src/services/ideaInboxService');
const { mathSceneFor } = require('./math-scene');

function registerFamilyRoutes({ app, express, familyTasks, standardJsonParser, shoppingList = defaultShoppingList, ideaInbox = defaultIdeaInbox, conversations = null }) {
  const router = express.Router();
  const reply = async (res, status, operation) => {
    try { return res.status(status).json({ ok: true, status: 'success', data: await operation() }); }
    catch (error) {
      return res.status(error.status || 500).json({ ok: false, status: 'error',
        code: error.code || 'FAMILY_IDEA_FAILED', message: error.message });
    }
  };
  router.use(standardJsonParser);
  // One household shopping list, the same one Nestor keeps. Children may read
  // and add; crossing items off is an explicit household review action.
  const shopping = [['get', '/shopping', 'list'], ['post', '/shopping/add', 'add'], ['post', '/shopping/bought', 'bought']];
  for (const [method, path, action] of shopping) {
    router[method](path, async (req, res) => {
      try {
        const data = await shoppingList({ action, items: req.body?.items, addedBy: 'household' });
        return res.json({ ok: true, status: 'success', data });
      } catch (error) {
        return res.status(error.status || 500).json({ ok: false, status: 'error',
          code: error.code || 'SHOPPING_LIST_FAILED', message: error.message });
      }
    });
  }
  const endpoints = [
    ['get', '/profiles', 'listProfiles', 200],
    // Profile management is available on the private LAN.
    // The page choice does not attest who is performing the update.
    ['get', '/profiles/details', 'listProfileDetails', 200],
    ['post', '/profiles/birth-date', 'setProfileBirthDate', 200],
    ['post', '/profiles', 'addProfile', 201],
    ['post', '/launch', 'launch', 201],
    ['post', '/profiles/archive', 'archiveProfile', 200],
    ['get', '/room', 'room', 200],
    ['get', '/chores', 'list', 200],
    ['post', '/chores', 'create', 201],
    ['post', '/chores/check-in', 'checkIn', 200],
    ['post', '/chores/approve', 'approve', 200],
    ['post', '/chores/reopen', 'reopen', 200],
    ['post', '/chores/cancel', 'cancel', 200]
  ];
  for (const [method, path, operation, status] of endpoints) {
    router[method](path, async (req, res) => {
      try {
        const data = await familyTasks[operation]((method === 'get' ? req.query : req.body) || {});
        return res.status(status).json({ ok: true, status: 'success', data });
      } catch (error) {
        return res.status(error.status || 500).json({ ok: false, status: 'error',
          code: error.code || 'FAMILY_OPERATION_FAILED', message: error.message });
      }
    });
  }
  // Ideas and reminders children and Nestor captured (#13). Explicit review
  // remains required; LAN access does not authenticate the human reviewer.
  router.get('/ideas', (req, res) => reply(res, 200, () => ideaInbox.listIdeas(req.query)));
  router.post('/ideas/:id/promote', (req, res) => reply(res, 201,
    () => ideaInbox.promoteToExecution(req.params.id, { ...req.body, by: 'household-dad-desk' })));
  router.post('/ideas/:id/set-aside', (req, res) => reply(res, 200,
    () => ideaInbox.setAside(req.params.id, { action: req.body?.action, by: 'household-dad-desk' })));
  // The docked mask's receipt for a counting or addition picture (#131).
  router.post('/math-receipts', (req, res) => reply(res, 200, () => recordMathReceipt(conversations, req.body)));
  app.use('/api/family', router);
  return router;
}

const receiptFailure = (status, code, message) => Object.assign(new Error(message), { status, code });
const RECEIPT_ID = /^[A-Za-z0-9-]{8,80}$/;

// The picture is recomputed from the recorded question, never taken from the
// browser: the receipt only says whether the mask showed it. It is kept on the
// family turn once, in the same field LLMx uses for its scene receipts.
async function recordMathReceipt(conversations, body = {}) {
  if (!conversations) throw receiptFailure(503, 'MATH_RECEIPT_UNAVAILABLE', 'Conversation storage is unavailable');
  const { sessionId, traceId, status, reason } = body || {};
  if (!RECEIPT_ID.test(sessionId || '') || !RECEIPT_ID.test(traceId || '') || !['applied', 'rejected'].includes(status)
    || (reason !== undefined && !/^[a-z-]{1,40}$/.test(reason))) {
    throw receiptFailure(400, 'MATH_RECEIPT_INVALID', 'A session, a turn and an applied or rejected status are required');
  }
  const query = { sessionId, traceId, scopeId: 'family' };
  const turn = await conversations.getTurn(query);
  if (!turn) throw receiptFailure(404, 'MATH_RECEIPT_TURN_NOT_FOUND', 'No family turn matches this receipt');
  const scene = mathSceneFor(turn.inputText);
  if (!scene) throw receiptFailure(409, 'MATH_RECEIPT_NO_PICTURE', 'This turn did not ask for a math picture');
  const receipt = { ...scene, status, ...(reason ? { reason } : {}) };
  const same = stored => stored && Object.keys(receipt).every(key => stored[key] === receipt[key]) && stored.reason === receipt.reason;
  if (turn.sceneReceipt) {
    if (same(turn.sceneReceipt)) return { receipt: turn.sceneReceipt, duplicate: true };
    throw receiptFailure(409, 'MATH_RECEIPT_CONFLICT', 'This turn already has a different receipt');
  }
  const written = await conversations.updateTurn({ ...query, sceneReceipt: null },
    { $set: { sceneReceipt: { ...receipt, receivedAt: new Date().toISOString() } } });
  if (written) return { receipt: written.sceneReceipt, duplicate: false };
  const stored = (await conversations.getTurn(query))?.sceneReceipt;
  if (same(stored)) return { receipt: stored, duplicate: true };
  throw receiptFailure(409, 'MATH_RECEIPT_CONFLICT', 'This turn already has a different receipt');
}

module.exports = { registerFamilyRoutes, recordMathReceipt };
