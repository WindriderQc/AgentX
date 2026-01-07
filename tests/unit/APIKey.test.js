const mongoose = require('mongoose');
const APIKey = require('../../models/APIKey');

afterEach(async () => {
  await APIKey.deleteMany({});
  jest.clearAllMocks();
});

describe('API Key Management', () => {
  describe('Static Methods', () => {
    it('generateKey - should return a key with "agx_" prefix and 48 hex chars', () => {
      const key = APIKey.generateKey();
      expect(key).toMatch(/^agx_[a-f0-9]{48}$/);
    });

    it('hashKey - should return SHA-256 hash', () => {
      const key = 'agx_0123456789abcdef0123456789abcdef0123456789abcdef';
      const hash = APIKey.hashKey(key);
      expect(hash).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it('getPrefix - should return last 8 characters', () => {
      const key = 'agx_0123456789abcdef0123456789abcdef0123456789abcdef';
      const prefix = APIKey.getPrefix(key);
      expect(prefix).toBe('89abcdef');
    });

    it('createKey - should create a new key document correctly', async () => {
      const data = {
        userId: new mongoose.Types.ObjectId(),
        name: 'Test Key',
        scopes: ['chat:read']
      };

      const result = await APIKey.createKey(data);

      expect(result).toHaveProperty('key');
      expect(result).toHaveProperty('doc');
      expect(result.key).toMatch(/^agx_/);
      expect(result.doc.name).toBe(data.name);
      expect(result.doc.userId).toEqual(data.userId);
      expect(result.doc.scopes).toEqual(['chat:read']);
      expect(result.doc.keyHash).toBeDefined();
      expect(result.doc.keyPrefix).toBe(result.key.slice(-8));

      // Verify hashing
      const expectedHash = APIKey.hashKey(result.key);
      expect(result.doc.keyHash).toBe(expectedHash);
    });
  });

  describe('Instance Methods', () => {
    let testKeyDoc;
    let rawTestKey;

    beforeEach(async () => {
      const result = await APIKey.createKey({
        userId: new mongoose.Types.ObjectId(),
        name: 'Instance Test Key',
        scopes: ['chat:read', 'models:read', 'models:write'],
        expiresAt: new Date(Date.now() + 100000) // Future
      });
      testKeyDoc = result.doc;
      rawTestKey = result.key;
    });

    it('verifyKey - should return true for correct key', () => {
      expect(testKeyDoc.verifyKey(rawTestKey)).toBe(true);
    });

    it('verifyKey - should return false for incorrect key', () => {
      expect(testKeyDoc.verifyKey('agx_wrongkey')).toBe(false);
    });

    it('isValid - should return true for active key', () => {
      expect(testKeyDoc.isValid()).toBe(true);
    });

    it('isValid - should return false if revoked', async () => {
      await testKeyDoc.revoke('Reason');
      expect(testKeyDoc.revokedAt).toBeDefined();
      expect(testKeyDoc.isValid()).toBe(false);
    });

    it('isValid - should return false if expired', async () => {
        testKeyDoc.expiresAt = new Date(Date.now() - 1000); // Past
        await testKeyDoc.save();
        expect(testKeyDoc.isValid()).toBe(false);
    });

    it('hasScope - should validate permissions correctly', () => {
        // Exact match
        expect(testKeyDoc.hasScope('chat:read')).toBe(true);
        // Missing scope
        expect(testKeyDoc.hasScope('chat:write')).toBe(false);
        // Wildcard match
        expect(testKeyDoc.hasScope('models:read')).toBe(true);
        expect(testKeyDoc.hasScope('models:write')).toBe(true);
        // Admin check (should fail)
        expect(testKeyDoc.hasScope('admin:read')).toBe(false);
    });

    it('hasScope - *:* wildcard should grant all', async () => {
        const { doc } = await APIKey.createKey({
            userId: new mongoose.Types.ObjectId(),
            name: 'Super Key',
            scopes: ['*:*']
        });
        expect(doc.hasScope('admin:write')).toBe(true);
        expect(doc.hasScope('anything:else')).toBe(true);
    });

    it('hasScope - admin:* wildcard logic', async () => {
        const { doc } = await APIKey.createKey({
            userId: new mongoose.Types.ObjectId(),
            name: 'Admin Key',
            scopes: ['admin:*']
        });
        expect(doc.hasScope('admin:read')).toBe(true);
        // Should NOT grant non-admin scopes automatically unless logic says so?
        // Code says: if (this.scopes.includes('admin:*') && requiredScope.startsWith('admin:')) return true;
        // So it only grants admin:* scopes.
        expect(doc.hasScope('chat:read')).toBe(false); 
    });

    it('recordUsage - should update lastUsedAt and increment count', async () => {
        const initialCount = testKeyDoc.usageCount;
        await testKeyDoc.recordUsage();
        
        const updated = await APIKey.findById(testKeyDoc._id);
        expect(updated.usageCount).toBe(initialCount + 1);
        expect(updated.lastUsedAt).not.toBeNull();
    });
  });

  describe('Key Rotation & Retrieval', () => {
    it('findByKey - should return document for valid key', async () => {
        const { key } = await APIKey.createKey({
            userId: new mongoose.Types.ObjectId(),
            name: 'Lookup Key',
            scopes: []
        });

        const found = await APIKey.findByKey(key);
        expect(found).not.toBeNull();
        expect(found.name).toBe('Lookup Key');
    });

    it('findByKey - should return null for invalid key', async () => {
        const found = await APIKey.findByKey('agx_nonexistent');
        expect(found).toBeNull();
    });

    it('findByKey - should return null for revoked key', async () => {
        const { key, doc } = await APIKey.createKey({
            userId: new mongoose.Types.ObjectId(),
            name: 'Revoked Key',
            scopes: []
        });
        await doc.revoke();
        
        const found = await APIKey.findByKey(key);
        expect(found).toBeNull();
    });

    it('rotateKey - should revoke old key and create new one', async () => {
        const userId = new mongoose.Types.ObjectId();
        const { doc: oldDoc } = await APIKey.createKey({
            userId,
            name: 'Rotatable Key',
            scopes: ['chat:read']
        });

        const { key: newKey, doc: newDoc } = await APIKey.rotateKey(oldDoc._id, userId);

        // Verify old key is revoked
        const refreshedOld = await APIKey.findById(oldDoc._id);
        expect(refreshedOld.revokedAt).toBeDefined();
        expect(refreshedOld.revokedReason).toBe('Rotated');

        // Verify new key properties
        expect(newDoc.name).toBe(oldDoc.name);
        expect(newDoc.userId).toEqual(userId);
        expect(newDoc.scopes).toEqual(oldDoc.scopes);
        expect(newDoc._id).not.toEqual(oldDoc._id);
        expect(newKey).toMatch(/^agx_/);
    });

    it('rotateKey - should throw error if key not found or unauthorized', async () => {
        const otherUser = new mongoose.Types.ObjectId();
        const { doc } = await APIKey.createKey({
            userId: new mongoose.Types.ObjectId(),
            name: 'Other Key',
            scopes: []
        });

        await expect(APIKey.rotateKey(doc._id, otherUser))
            .rejects.toThrow('API key not found or unauthorized');
    });
  });
});
