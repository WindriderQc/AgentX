'use strict';

const fs = require('fs');
const path = require('path');

const CAPABILITIES = Object.freeze([
  ['overview', '/overview'], ['chat', '/chat'], ['agents', '/agents'], ['sessions', '/sessions'],
  ['tasks', '/tasks'], ['cron', '/cron'], ['channels', '/channels'], ['skills', '/skills'],
  ['usage', '/usage'], ['config', '/config'], ['logs', '/logs'], ['debug', '/debug']
]);

class OpenClawControlError extends Error {
  constructor(message, { status = 500, code = 'OPENCLAW_CONTROL_ERROR' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeUrl(value, fallback) {
  const raw = String(value || fallback || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? raw : '';
  } catch { return ''; }
}

function getControlUiConfig() {
  const gatewayUrl = safeUrl(process.env.OPENCLAW_GATEWAY_URL, 'http://127.0.0.1:18789');
  const directBaseUrl = safeUrl(process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL, gatewayUrl);
  const localBaseUrl = safeUrl(process.env.OPENCLAW_CONTROL_UI_LOCAL_URL, 'http://127.0.0.1:18790');
  const mode = ['ssh-tunnel', 'tunnel'].includes(String(process.env.OPENCLAW_CONTROL_UI_MODE || '').toLowerCase())
    ? 'ssh-tunnel'
    : 'direct';
  return {
    authority: 'official-openclaw-control-ui',
    directBaseUrl,
    launchBaseUrl: mode === 'ssh-tunnel' ? localBaseUrl : directBaseUrl,
    localBaseUrl,
    mode,
    nativeCapabilities: CAPABILITIES.map(([id, route]) => ({ id, path: route }))
  };
}

function readGatewayToken() {
  const envToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  if (envToken) return envToken;
  const configPath = process.env.OPENCLAW_CONFIG_PATH
    || path.join(process.env.OPENCLAW_HOME || '/data/openclaw', 'openclaw.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return String(config?.gateway?.auth?.token || '').trim();
  } catch { return ''; }
}

function getControlLaunchUrl(target, query = {}) {
  const config = getControlUiConfig();
  const capability = config.nativeCapabilities.find((item) => item.id === target);
  if (!capability || !config.launchBaseUrl) {
    throw new OpenClawControlError('Unknown OpenClaw Control UI target.', {
      status: 400, code: 'OPENCLAW_CONTROL_TARGET_INVALID'
    });
  }
  const token = readGatewayToken();
  if (!token) {
    throw new OpenClawControlError('OpenClaw gateway token is unavailable.', {
      status: 503, code: 'OPENCLAW_CONTROL_TOKEN_UNAVAILABLE'
    });
  }
  const url = new URL(`${config.launchBaseUrl}${capability.path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

module.exports = { OpenClawControlError, getControlLaunchUrl, getControlUiConfig };
