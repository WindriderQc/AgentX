'use strict';

const service = require('../../src/services/conversationScreenCapture');
function registerScreenCaptureRoutes(router, { envelope, fail }) {
  const base = '/private/sessions/:sessionId/screen-capture';
  const wrap = action => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return envelope(res, await action(req)); }
    catch (error) { return fail(res, error.statusCode || 503, error.statusCode ? error.message : 'Screen capture unavailable.', error.code || 'SCREEN_CAPTURE_UNAVAILABLE'); }
  };
  router.get(base, wrap(req => service.read({ sessionId: req.params.sessionId })));
  // Browser responses cannot create a request, change its scope or supply bytes.
  router.post(base, wrap(req => {
    if (!req.body || Object.keys(req.body).some(key => !['requestId', 'status', 'attachmentId'].includes(key))) {
      throw Object.assign(new Error('Invalid capture response.'), { statusCode: 400 });
    }
    return service.resolve({ ...req.body, sessionId: req.params.sessionId });
  }));
}
module.exports = { registerScreenCaptureRoutes };
