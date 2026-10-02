'use strict';

const path = require('node:path');
const logger = require('../../config/logger');
const { createFaceUnlock, FaceUnlockError } = require('../services/faceUnlockService');

const SUBJECT = 'default';

function mongoStore() {
  const FaceEnrollment = require('../../models/FaceEnrollment');
  return {
    load: async () => (await FaceEnrollment.findOne({ subject: SUBJECT }).lean())?.descriptors || [],
    save: descriptors => FaceEnrollment.updateOne({ subject: SUBJECT }, { $set: { descriptors } }, { upsert: true }),
    erase: () => FaceEnrollment.deleteOne({ subject: SUBJECT })
  };
}

function maxDistanceFrom(env) {
  const value = Number(env.AGENTX_FACE_UNLOCK_MAX_DISTANCE || 0.4);
  if (!Number.isFinite(value) || value < 0.3 || value > 0.5) throw new Error('Invalid face unlock distance');
  return value;
}

// Camera recognition of the enrolled adult, next to the parental code. These
// routes sit before the adult gate: status, challenge and frame are how a
// locked browser unlocks; enrollment and the setup page need a session.
function registerFaceUnlock({ app, auth, env, configured, root, safeNext, recognizer, store }) {
  // The parental code may be set from the host after startup; camera unlock
  // follows it, since the code always remains the fallback.
  const enabled = env.AGENTX_FACE_UNLOCK_ENABLED === 'true';
  const json = (res, data) => res.set('Cache-Control', 'private, no-store').json({ ok: true, status: 'success', data });
  const fail = (res, status, code, message) => res.status(status).set('Cache-Control', 'no-store')
    .json({ ok: false, status: 'error', code, message });
  if (!enabled) {
    app.get('/api/access/face/status', (_req, res) => json(res, { enabled: false, ready: false }));
    return null;
  }
  const face = createFaceUnlock({
    recognizer: recognizer || require('../services/faceRecognizer').createFaceRecognizer(),
    store: store || mongoStore(),
    maxDistance: maxDistanceFrom(env)
  });
  const handle = fn => async (req, res) => {
    try { return await fn(req, res); } catch (error) {
      if (error instanceof FaceUnlockError) return fail(res, error.status, error.code, error.message);
      logger.warn('Face unlock unavailable', { error: error.message });
      return fail(res, 503, 'FACE_UNAVAILABLE', 'La reconnaissance faciale est indisponible. Utilise le code parental.');
    }
  };
  const unlockAllowed = (req, res) => {
    if (!configured()) {
      fail(res, 503, 'ADULT_ACCESS_NOT_CONFIGURED', 'Le code parental n’est pas encore défini.');
      return false;
    }
    if (!auth.blocked(req)) return true;
    fail(res, 429, 'ADULT_UNLOCK_RATE_LIMIT', 'Trop de tentatives. Réessaie dans quelques minutes.');
    return false;
  };

  app.get('/api/access/face/status', handle(async (_req, res) => json(res, { enabled: configured(), ready: configured() && (await face.status()).ready })));
  app.post('/api/access/face/challenge', handle(async (req, res) => {
    if (unlockAllowed(req, res)) return json(res, await face.challenge());
    return undefined;
  }));
  app.post('/api/access/face/frame', handle(async (req, res) => {
    if (!unlockAllowed(req, res)) return undefined;
    const result = await face.submit(req.body?.challengeId, req.body?.image);
    if (result.rejected) {
      auth.recordFailure(req);
      return fail(res, 403, 'FACE_NOT_RECOGNIZED', 'Visage non reconnu. Utilise le code parental.');
    }
    if (!result.done) return json(res, { unlocked: false, ...result });
    const session = auth.grant(req, res);
    return json(res, { unlocked: true, expiresAt: session.expiresAt, next: safeNext(req.body?.next) });
  }));

  app.get('/api/access/face/enrollment', auth.requireSession, handle(async (_req, res) => json(res, await face.status())));
  app.post('/api/access/face/enrollment/samples', auth.requireSession,
    handle(async (req, res) => json(res, await face.addSample(req.body?.image))));
  app.delete('/api/access/face/enrollment', auth.requireSession, handle(async (_req, res) => {
    await face.erase();
    return json(res, await face.status());
  }));
  app.get('/access/face', (req, res) => {
    if (!auth.current(req)) return res.redirect(302, '/unlock?next=' + encodeURIComponent('/access/face'));
    return res.set('Cache-Control', 'no-store').sendFile('face.html', { root: path.resolve(root) });
  });
  return face;
}

module.exports = { registerFaceUnlock };
