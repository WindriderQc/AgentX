'use strict';
const { getUserId } = require('../src/helpers/userHelpers');
const service = require('../src/services/chat/playgroundAttachments');

function register(router) {
  const wrap = action => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await action(req, res); }
    catch (error) {
      res.status(error.statusCode || 503).json({ status: 'error', code: error.code,
        message: error.statusCode ? error.message : 'The attachment could not be accessed.' });
    }
  };
  router.post('/attachments', wrap(async (req, res) => {
    const data = await service.upload(getUserId(res), req.body);
    res.json({ status: 'success', data });
  }));
  router.get('/:id/attachments/:attachmentId', wrap(async (req, res) => {
    const file = await service.storeFor(req.params.id, getUserId(res)).download(req.params.attachmentId);
    res.set('Content-Type', file.mimeType).set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `${file.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.send(file.data);
  }));
}
module.exports = { register };
