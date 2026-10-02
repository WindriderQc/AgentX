'use strict';

const crypto = require('crypto');
const { cleanBaseUrl } = require('../common');

const COOKIE_NAME = 'agentx_dsh_access';
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 12 * 60 * 60;

function configuredIsolation() {
  return String(process.env.DSH_STUDIO_ISOLATION || 'bubblewrap').trim().toLowerCase();
}

function sessionTtlSeconds() {
  return Number(process.env.DSH_STUDIO_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
}

function dshStudioConfig() {
  const rawPublicUrl = String(process.env.DSH_STUDIO_PUBLIC_URL || '').trim();
  if (!rawPublicUrl) return Object.freeze({ configured: false, isolation: configuredIsolation() });
  const publicUrl = cleanBaseUrl(rawPublicUrl);
  const parsed = new URL(publicUrl);
  return Object.freeze({
    configured: true,
    publicUrl,
    hostname: parsed.hostname,
    isolation: configuredIsolation(),
    model: String(process.env.DSH_STUDIO_MODEL || '').trim(),
    sessionTtlSeconds: sessionTtlSeconds(),
  });
}

function validateDshStudioEnvironment() {
  const isolation = configuredIsolation();
  if (!['bubblewrap', 'host'].includes(isolation)) {
    throw new Error('DSH_STUDIO_ISOLATION must be bubblewrap or host');
  }
  const ttl = sessionTtlSeconds();
  if (!Number.isInteger(ttl) || ttl < 300 || ttl > MAX_SESSION_TTL_SECONDS) {
    throw new Error(`DSH_STUDIO_SESSION_TTL_SECONDS must be an integer from 300 to ${MAX_SESSION_TTL_SECONDS}`);
  }

  const config = dshStudioConfig();
  if (!config.configured) return config;
  const parsed = new URL(config.publicUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw new Error('DSH_STUDIO_PUBLIC_URL must use HTTPS except on loopback');
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('DSH_STUDIO_PUBLIC_URL must be an origin without a path, query, or fragment');
  }
  const corePublic = String(process.env.CORE_PUBLIC_URL || '').trim();
  if (corePublic && new URL(cleanBaseUrl(corePublic)).hostname !== parsed.hostname) {
    throw new Error('DSH_STUDIO_PUBLIC_URL must use the same hostname as CORE_PUBLIC_URL');
  }
  if (String(process.env.DSH_STUDIO_ACCESS_SECRET || '').length < 32) {
    throw new Error('DSH_STUDIO_ACCESS_SECRET must contain at least 32 characters when DSH Studio is configured');
  }
  return config;
}

function tokenSignature(unsigned, secret = process.env.DSH_STUDIO_ACCESS_SECRET || '') {
  if (String(secret).length < 32) return '';
  return crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
}

function issueAccessToken({ now = Date.now(), randomBytes = crypto.randomBytes } = {}) {
  const issuedAt = Math.floor(Number(now) / 1000);
  const unsigned = `v1.${issuedAt}.${randomBytes(18).toString('base64url')}`;
  const signature = tokenSignature(unsigned);
  if (!signature) throw new Error('DSH Studio access secret is unavailable');
  return `${unsigned}.${signature}`;
}

function accessTokenValid(token, { now = Date.now(), ttlSeconds = sessionTtlSeconds() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
  const issuedAt = Number(parts[1]);
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > ttlSeconds) return false;
  const signature = tokenSignature(parts.slice(0, 3).join('.'));
  if (!signature) return false;
  const expected = Buffer.from(signature);
  const presented = Buffer.from(parts[3]);
  return expected.length === presented.length && expected.length > 0 && crypto.timingSafeEqual(expected, presented);
}

function cookieToken(req) {
  if (req.cookies && typeof req.cookies[COOKIE_NAME] === 'string') return req.cookies[COOKIE_NAME];
  const cookie = String(req.get?.('cookie') || '');
  for (const field of cookie.split(';')) {
    const [name, ...value] = field.trim().split('=');
    if (name === COOKIE_NAME) {
      try { return decodeURIComponent(value.join('=')); } catch { return ''; }
    }
  }
  return '';
}

function accessCookie(token, ttlSeconds) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function registerDshStudioOperations({ express }) {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    const config = dshStudioConfig();
    res.set('Cache-Control', 'no-store');
    return res.json({
      status: config.configured ? 'unknown' : 'unavailable',
      configured: config.configured,
      configurationStatus: config.configured ? 'configured' : 'disabled',
      liveState: 'unverified',
      isolation: config.isolation,
      model: config.model || null,
      launchUrl: config.configured ? '/api/dsh/control-launch' : null,
      authority: 'aio-ops-dsh-studio-config',
    });
  });

  router.get('/control-launch', (req, res) => {
    const config = dshStudioConfig();
    if (!config.configured) {
      return res.status(503).json({
        status: 'error', code: 'DSH_STUDIO_NOT_CONFIGURED', message: 'DSH Studio is not configured.'
      });
    }
    const token = issueAccessToken();
    res.set({
      'Set-Cookie': accessCookie(token, config.sessionTtlSeconds),
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
    });
    return res.redirect(302, config.publicUrl);
  });

  // Caddy calls this exact endpoint through forward_auth. The route accepts
  // only the signed, short-lived, host-only cookie minted by control-launch.
  router.get('/access-check', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!dshStudioConfig().configured || !accessTokenValid(cookieToken(req))) {
      return res.status(401).json({
        status: 'error', code: 'DSH_STUDIO_ACCESS_REQUIRED', message: 'Launch DSH Studio from AgentX.'
      });
    }
    return res.status(204).end();
  });

  return router;
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  accessCookie,
  accessTokenValid,
  configuredIsolation,
  dshStudioConfig,
  issueAccessToken,
  registerDshStudioOperations,
  sessionTtlSeconds,
  validateDshStudioEnvironment,
};
