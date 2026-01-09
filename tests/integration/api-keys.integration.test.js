const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../../src/app');
const APIKey = require('../../models/APIKey');
const AuditLog = require('../../models/AuditLog');
const { apiKeyAuthV2 } = require('../../src/middleware/auth');

describe('API Key Integration Tests', () => {
  let testUser; 

  beforeAll(async () => {
    testUser = new mongoose.Types.ObjectId();
    // Mount test route for verification
    app.post('/api/test-protected', apiKeyAuthV2, (req, res) => {
      res.json({ status: 'ok', user: res.locals.user });
    });

    // HACK: Move the test route higher in the stack to bypass the 404 catch-all
    if (app._router && app._router.stack) {
        const lastLayer = app._router.stack.pop();
        // Insert after initial middleware (usually body parsers) but before routes/404
        app._router.stack.splice(10, 0, lastLayer);
    }
  });

  afterEach(async () => {
    await APIKey.deleteMany({});
    await AuditLog.deleteMany({});
  });

  describe('Key Lifecycle', () => {
    it('should create a new API key manually', async () => {
      const { key, doc } = await APIKey.createKey({
        userId: testUser,
        name: 'Integration Test Key',
        scopes: ['chat:read']
      });

      expect(key).toMatch(/^agx_/);
      expect(doc.name).toBe('Integration Test Key');
    });
  });

  describe('Authentication Flow & Usage', () => {
    let validKeyStr;

    beforeEach(async () => {
      const result = await APIKey.createKey({
        userId: testUser,
        name: 'Valid Key',
        scopes: ['chat:read', 'models:read']
      });
      validKeyStr = result.key;
    });

    it('should allow access with valid API Key header', async () => {
      const res = await request(app)
        .post('/api/test-protected')
        .set('X-API-Key', validKeyStr);

      expect(res.status).toBe(200);
    });

    it('should reject access with invalid API Key', async () => {
      const res = await request(app)
        .post('/api/test-protected')
        .set('X-API-Key', 'agx_invalid_key_12345');

      expect(res.status).toBe(401);
    });

    it('should track usage on successful request', async () => {
      const { key, doc } = await APIKey.createKey({
        userId: testUser,
        name: 'Usage Key',
        scopes: ['models:read']
      });

      await request(app)
        .post('/api/test-protected')
        .set('X-API-Key', key);

      const updatedKey = await APIKey.findById(doc._id);
      expect(updatedKey.usageCount).toBe(1);
    });
  });

  describe('API Key Rotation', () => {
    it('should rotate key (revoke old, create new)', async () => {
      // Create initial key
      const { key: key1Str, doc: key1Doc } = await APIKey.createKey({
        userId: testUser,
        name: 'Original Key',
        scopes: ['chat:read']
      });

      // Use key1 successfully
      let res = await request(app)
        .post('/api/test-protected')
        .set('X-API-Key', key1Str);
      expect(res.status).toBe(200);

      // Rotate: revoke old, create new
      const { key: key2Str } = await APIKey.rotateKey(key1Doc._id, testUser);

      // Old key rejected
      res = await request(app)
        .post('/api/test-protected')
        .set('X-API-Key', key1Str);
      expect(res.status).toBe(401);

      // New key works
      res = await request(app)
        .post('/api/test-protected')
        .set('X-API-Key', key2Str);
      expect(res.status).toBe(200);
    });
  });

  describe('API Key Expiration', () => {
    it('should reject expired keys', async () => {
      const { key: expiredKeyStr } = await APIKey.createKey({
        userId: testUser,
        name: 'Expired Key',
        scopes: ['chat:read'],
        expiresAt: new Date(Date.now() - 1000) // Expired 1s ago
      });

      const res = await request(app)
        .post('/api/test-protected')
        .set('X-API-Key', expiredKeyStr);

      expect(res.status).toBe(401);
    });
  });
});
