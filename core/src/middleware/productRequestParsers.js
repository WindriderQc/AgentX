'use strict';
module.exports = function productRequestParsers(app, express) {
  // Two bounded reference images can exceed the normal product body limit.
  // The owned parser must run before the default consumes the request.
  app.use(/^\/api\/images\/expert\/sessions\/[a-f0-9-]{36}\/references\/?$/, express.json({ limit: '4mb' }));
  app.use('/api/images/expert', express.json({ limit: '512kb' }));
  app.use('/api/images', express.json({ limit: '8mb' }));
  app.use(/^\/api\/voice-personas\/private\/sessions\/[a-f0-9-]{36}\/images\/?$/, express.json({ limit: '8mb' }));
  // OpenAI clients resend every image of a conversation with each request.
  app.use('/api/llm', express.json({ limit: '32mb' }));
  // Vision requests carry base64 photos (a third larger than the file); Core
  // shrinks them before Ollama, so the limit only has to admit the originals.
  app.use('/api/inference/generate', express.json({ limit: '32mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
};
