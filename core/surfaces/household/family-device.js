'use strict';

// A device pinned to the family (child-safe) profile (#826).
//
// The owner pins a child's tablet once, from the parent page opened on that
// tablet. The tablet then carries an opaque token cookie; Core keeps only its
// hash. While pinned, the device reaches the family pages and the APIs they use,
// and nothing else: no personal pack, owner memory, owner settings or Core
// operator pages. Only another device can unpin it, from the parent page.
//
// Limit: clearing the tablet's site data removes the cookie and the pin with it.
// The owner unlocks full access for a few minutes with a spoken phrase
// (owner-unlock.js); that unlock is a server record bound to this pin.

const crypto = require('crypto');

const COOKIE = 'agentx_family_device';
const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const CACHE_MS = 30 * 1000;

const FAMILY_PAGES = new Set(['/panel', '/kids', '/kids/sounds', '/kids/plants', '/lecture', '/voice-lab/devices']);
const STATIC_PATHS = [
  /^\/(?:js|css|dist|vendor|img|assets\/household|psyx\/assets)\//,
  /^\/(?:favicon\.(?:ico|svg)|styles\.css)$/
];
// Measured from the family pages (panel, kids, sounds, reading, family voice
// settings). Private persona routes, memory, audit and alerts are parent tools.
const FAMILY_APIS = [
  /^\/api\/voice-personas\/(?:catalog|packs|sounds|knowledge\/status|sessions|family)(?:\/|$)/,
  /^\/api\/voix\//,
  /^\/api\/family\//,
  /^\/api\/panel\/status$/,
  /^\/api\/household\/(?:avatar\/|device-acceptance|family-device(?:\/relock)?$)/
];

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** True when a pinned device may use this request. */
function allowedForFamilyDevice(req) {
  const path = req.path;
  if (STATIC_PATHS.some((pattern) => pattern.test(path))) return true;
  if (FAMILY_APIS.some((pattern) => pattern.test(path))) return true;
  if (req.method !== 'GET') return false;
  if (FAMILY_PAGES.has(path)) return true;
  // Children may change their own voice settings (owner decision), only in the family scope.
  return path === '/voice-lab' && req.query?.scope === 'family';
}

function createModel(mongoose) {
  const name = 'AgentXHouseholdFamilyDevice';
  if (mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    label: { type: String, default: 'Family device', maxlength: 80, trim: true },
    lastSeenAt: { type: Date, default: null }
  }, { timestamps: true }), 'household_family_devices');
}

function register({ app, mongoose, standardJsonParser, envelope, fail, logger, ownerUnlock = null }) {
  const Device = createModel(mongoose);
  const cache = new Map();
  const unlock = ownerUnlock || require('./owner-unlock').createOwnerUnlock({ mongoose, logger });

  // An unlock Core cannot read while its store is down does not exist: the device stays locked.
  async function unlockedUntil(tokenHash) {
    try { return await unlock.activeUntil(tokenHash); }
    catch (error) {
      logger?.warn?.('Owner unlock lookup failed; keeping the device locked', { error: error.message });
      return null;
    }
  }

  // Resolves the pinned device behind a token; a token Core cannot check while
  // its store is down is treated as pinned, so an outage never unlocks a tablet.
  async function deviceFor(token) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const cached = cache.get(tokenHash);
    if (cached && cached.until > Date.now()) return cached.device;
    let device;
    try {
      device = await Device.findOneAndUpdate({ tokenHash }, { $set: { lastSeenAt: new Date() } }, { new: true }).lean();
    } catch (error) {
      logger?.warn?.('Family device lookup failed; keeping the device pinned', { error: error.message });
      return { label: 'Family device', unverified: true };
    }
    cache.set(tokenHash, { device, until: Date.now() + CACHE_MS });
    return device;
  }

  app.use(async (req, res, next) => {
    const token = req.cookies?.[COOKIE];
    res.locals.familyDevicePinned = false;
    if (!token) return next();
    const device = await deviceFor(token).catch(() => ({ label: 'Family device', unverified: true }));
    if (!device) return next(); // unpinned elsewhere: the stale cookie grants nothing and blocks nothing
    req.familyDevice = { ...device, tokenHash: hashToken(token) };
    res.locals.familyDevicePinned = true;
    if (STATIC_PATHS.some((pattern) => pattern.test(req.path))) return next();
    const until = device.unverified ? null : await unlockedUntil(req.familyDevice.tokenHash);
    if (until) {
      // Full owner access until the unlock ends; every page shows it and offers Relock.
      req.familyDevice.unlockedUntil = until;
      res.locals.familyUnlock = { until: new Date(until).toISOString() };
      return next();
    }
    if (allowedForFamilyDevice(req)) return next();
    if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.redirect(302, '/panel');
    return fail(res, 403, 'This device is pinned to the family profile.', 'FAMILY_DEVICE_PINNED');
  });

  app.get('/api/household/family-device', (req, res) => envelope(res, {
    pinned: Boolean(req.familyDevice), label: req.familyDevice?.label || null,
    unlockedUntil: req.familyDevice?.unlockedUntil ? new Date(req.familyDevice.unlockedUntil).toISOString() : null
  }));

  app.post('/api/household/family-device/relock', async (req, res) => {
    if (!req.familyDevice?.tokenHash) return envelope(res, { pinned: false, relocked: false });
    try { await unlock.relock(req.familyDevice.tokenHash, req.familyDevice.label); }
    catch (error) { return fail(res, 503, 'The device could not be relocked; try again.', 'FAMILY_DEVICE_RELOCK_FAILED'); }
    return envelope(res, { pinned: true, relocked: true });
  });

  app.post('/api/household/family-device/pin', standardJsonParser, async (req, res) => {
    if (req.familyDevice) return envelope(res, { pinned: true, label: req.familyDevice.label });
    const token = crypto.randomBytes(32).toString('base64url');
    const label = String(req.body?.label || '').trim().slice(0, 80) || 'Family device';
    try {
      await Device.create({ tokenHash: hashToken(token), label });
    } catch (error) {
      return fail(res, 500, 'The device could not be pinned.', 'FAMILY_DEVICE_PIN_FAILED');
    }
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'strict', path: '/', maxAge: COOKIE_MAX_AGE_MS,
      secure: req.secure || req.get('x-forwarded-proto') === 'https'
    });
    logger?.info?.('Device pinned to the family profile', { label });
    return envelope(res, { pinned: true, label }, 201);
  });

  // Parent tools: a pinned device never reaches these (not in the family allowlist).
  app.get('/api/household/family-devices', async (_req, res) => {
    let devices;
    try {
      devices = await Device.find({}, { tokenHash: 0 }).sort({ createdAt: -1 }).limit(50).lean();
    } catch (error) {
      return fail(res, 503, 'Family devices are unavailable.', 'FAMILY_DEVICES_UNAVAILABLE');
    }
    return envelope(res, { devices: devices.map((d) => ({ id: String(d._id), label: d.label, pinnedAt: d.createdAt, lastSeenAt: d.lastSeenAt })) });
  });

  app.delete('/api/household/family-devices/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Unknown device.', 'FAMILY_DEVICE_INVALID');
    let removed;
    try { removed = await Device.findByIdAndDelete(req.params.id).lean(); }
    catch (error) { return fail(res, 503, 'Family devices are unavailable.', 'FAMILY_DEVICES_UNAVAILABLE'); }
    if (!removed) return fail(res, 404, 'Unknown device.', 'FAMILY_DEVICE_NOT_FOUND');
    cache.delete(removed.tokenHash);
    await unlock.forget(removed.tokenHash).catch(() => {});
    logger?.info?.('Family device unpinned', { label: removed.label });
    return envelope(res, { unpinned: true });
  });

  return { ownerUnlock: unlock };
}

module.exports = { COOKIE, allowedForFamilyDevice, hashToken, register };
