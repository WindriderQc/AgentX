'use strict';
const { randomBytes } = require('node:crypto');
const { pinnedFamilyDevice } = require('./family-album-access');
const TTL_MS = 120000;
const LIMIT = 256;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
function createFamilyAlbumReceipts({ now = Date.now } = {}) {
  const issued = new Map();
  return {
    issue(device, sessionId, assetId) {
      if (!pinnedFamilyDevice(device) || typeof sessionId !== 'string' || !sessionId) return null;
      for (const [key, row] of issued) if (row.until <= now()) issued.delete(key);
      if (issued.size >= LIMIT) issued.delete(issued.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      issued.set(token, { assetId, sessionId, deviceHash: device.tokenHash, until: now() + TTL_MS });
      return '/api/photos/frame/album/' + token + '/image';
    },
    claim(device, token) {
      if (!pinnedFamilyDevice(device) || typeof token !== 'string' || !TOKEN.test(token)) return null;
      const row = issued.get(token);
      if (!row || row.deviceHash !== device.tokenHash) return null;
      if (row.until <= now()) { issued.delete(token); return null; }
      return { assetId: row.assetId, sessionId: row.sessionId };
    }
  };
}
module.exports = { createFamilyAlbumReceipts, familyAlbumReceipts: createFamilyAlbumReceipts() };
