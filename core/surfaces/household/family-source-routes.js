'use strict';
const registry = require('./family-tool-registry');

// A dedicated family transport, never a proxy to the owner consumer or other tools.
function registerFamilySources(app, { standardJsonParser, envelope, fail }, deps = {}) {
  const handler = name => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await registry.callTool({ name,
        arguments: name === 'source_read' ? req.body : req.query }, deps);
      const data = result.structuredContent;
      if (result.isError) {
        const status = data.error === 'SOURCE_CHANGED' ? 409
          : ['INVALID_ARGUMENTS', 'SOURCE_ARGUMENT_INVALID', 'SOURCE_NOT_AVAILABLE'].includes(data.error) ? 400 : 503;
        return fail(res, status, data.message, data.error, data.retry ? { retry: data.retry } : undefined);
      }
      return envelope(res, data);
    } catch (_) {
      return fail(res, 503, 'The source could not be read right now.', 'SOURCE_READ_UNAVAILABLE');
    }
  };
  app.get('/api/family/sources', handler('source_catalogue'));
  app.post('/api/family/sources/read', standardJsonParser, handler('source_read'));
}
module.exports = { registerFamilySources };
