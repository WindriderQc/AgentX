'use strict';
// Use the production image preparation contract with an isolated synthetic row.
// Scope and storage are exercised separately by playground-attachments.test.js.
module.exports = function playgroundAttachmentFixture() {
  const service = require('../../src/services/conversationAttachmentService');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
  const reference = { id: '111111111111111111111111', name: 'synthetic-screen.png', kind: 'image', mimeType: 'image/png', size: Buffer.from(png, 'base64').length };
  const row = { ...reference, _id: reference.id, data: Buffer.from(png, 'base64') };
  const spy = jest.spyOn(service, 'forPlayground').mockReturnValue({
    references: async () => [reference],
    prepare: (messages, backend) => service.prepareWithLoader(messages, backend, async () => [row])
  });
  return { reference, png, restore: () => spy.mockRestore() };
};
