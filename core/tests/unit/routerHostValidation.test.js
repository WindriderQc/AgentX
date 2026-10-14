'use strict';
const config = require('../../src/services/modelRouterConfig');

describe('task routing host validation', () => {
  it('refuses a host key whose URL is not configured', async () => {
    const saved = config.HOSTS.secondary;
    config.HOSTS.secondary = '';
    try {
      await expect(config.saveTaskModelOverride('quick_chat', { model: 'qwen3.5:9b', host: 'secondary' }))
        .rejects.toMatchObject({ statusCode: 400, message: 'Unknown host: secondary' });
    } finally {
      config.HOSTS.secondary = saved;
    }
  });
});
