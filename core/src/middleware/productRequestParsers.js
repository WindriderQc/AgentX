'use strict';
module.exports = function productRequestParsers(app, express) {
  // Two bounded reference images can exceed the normal product body limit.
  // The owned parser must run before the default consumes the request.
  app.use('/api/images', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
};
