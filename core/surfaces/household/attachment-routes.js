'use strict';

// Personal conversation attachments: upload, download, and the full-quality
// original of an image the browser reduced for the model (kept in the image
// archive when the instance configures one).

const ORIGINAL_LIMIT = '52mb';

function registerAttachmentRoutes(personas, { express, personalAttachments, envelope, fail }) {
  const failWith = (res, error, fallback) => fail(res, error.statusCode || 500, error.statusCode ? error.message : fallback, error.code);
  personas.post('/private/sessions/:sessionId/attachments', async (req, res) => {
    try { return envelope(res, { attachment: await personalAttachments(req.params.sessionId).upload(req.body) }, 201); }
    catch (error) { return failWith(res, error, 'Pièce jointe indisponible.'); }
  });
  personas.get('/private/sessions/:sessionId/attachments/:attachmentId', async (req, res) => {
    try {
      const attachment = await personalAttachments(req.params.sessionId).download(req.params.attachmentId);
      res.set({ 'Content-Type': attachment.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${attachment.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}` });
      return res.send(attachment.data);
    } catch (error) { return failWith(res, error, 'Pièce jointe indisponible.'); }
  });
  // The raw bytes of the photo as the device produced it; the name travels in a header.
  personas.post('/private/sessions/:sessionId/attachments/:attachmentId/original',
    express.raw({ type: () => true, limit: ORIGINAL_LIMIT }), async (req, res) => {
      try {
        let name = null;
        try { name = decodeURIComponent(String(req.get('x-original-name') || '')) || null; } catch { name = null; }
        const attachment = await personalAttachments(req.params.sessionId).attachOriginal(req.params.attachmentId, { bytes: req.body, name });
        return envelope(res, { attachment }, 201);
      } catch (error) { return failWith(res, error, 'Original indisponible.'); }
    });
}

module.exports = { registerAttachmentRoutes };
