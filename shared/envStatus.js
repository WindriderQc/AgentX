'use strict';

/**
 * Configuration status of one service, from shared/envCatalog.json and the
 * process environment. Read-only and value-safe: a secret (catalog flag, or a
 * credential-looking name) is reported only as set or not set, and URLs lose
 * any embedded credentials.
 *
 * State of each variable:
 *   custom  — set to a value that differs from its default
 *   default — not set, or set to its default; the compose default or the
 *             documented code fallback applies
 *   off     — not set and no default: the feature it gates is off
 */

const path = require('path');

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE|CREDENTIAL|ACCESS_CODE|PARENTAL_CODE|_KEY$|AUTH$)/;
const MAX_VALUE = 240;

let cachedCatalog = null;

function loadCatalog(file = path.join(__dirname, 'envCatalog.json')) {
  if (!cachedCatalog) cachedCatalog = require(file);
  return cachedCatalog;
}

function redactValue(value) {
  const text = String(value).replace(/(\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1***@');
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

function describeVariable(name, entry, env) {
  const raw = env[name];
  const set = typeof raw === 'string' && raw.trim() !== '';
  const secret = entry.secret === true || SECRET_NAME.test(name);
  const hasDefault = entry.default !== null && entry.default !== undefined && String(entry.default) !== '';
  // `fallback` names what the code does when the variable is unset, for
  // settings that have no compose default but are not an off switch either.
  const fallback = typeof entry.fallback === 'string' && entry.fallback.trim() ? entry.fallback.trim() : null;
  let state;
  if (set && !(hasDefault && raw === String(entry.default))) state = 'custom';
  else if (hasDefault || fallback || set) state = 'default';
  else state = 'off';
  return {
    name,
    category: entry.category || 'other',
    description: entry.description || '',
    forwarded: entry.forwarded === true,
    secret,
    state,
    set,
    value: set ? (secret ? null : redactValue(raw)) : null,
    default: hasDefault && !secret ? redactValue(entry.default) : null,
    fallback,
  };
}

function buildEnvStatus({ service, env = process.env, catalog = loadCatalog() } = {}) {
  const variables = Object.entries(catalog.variables || {})
    .filter(([, entry]) => (entry.services || []).includes(service))
    .map(([name, entry]) => describeVariable(name, entry, env));
  const count = (state) => variables.filter((v) => v.state === state).length;
  return {
    schema: 'agentx.env-status/v1',
    service,
    reported: true,
    summary: {
      total: variables.length,
      custom: count('custom'),
      default: count('default'),
      off: count('off'),
      undocumented: variables.filter((v) => !v.description).length,
    },
    variables,
  };
}

/** Catalog entries of a service that does not report its environment. */
function buildCatalogOnlyStatus({ service, catalog = loadCatalog(), reason = 'not reported' } = {}) {
  const variables = Object.entries(catalog.variables || {})
    .filter(([, entry]) => (entry.services || []).includes(service))
    .map(([name, entry]) => ({
      ...describeVariable(name, entry, {}),
      state: 'unknown',
    }));
  return {
    schema: 'agentx.env-status/v1',
    service,
    reported: false,
    reason,
    summary: { total: variables.length, custom: 0, default: 0, off: 0, undocumented: variables.filter((v) => !v.description).length },
    variables,
  };
}

/** One startup line: how many settings are customized, default or off. */
function summarizeForLog(status) {
  const s = status.summary;
  const offForwarded = status.variables.filter((v) => v.state === 'off' && v.forwarded).map((v) => v.name);
  return `Configuration (${status.service}): ${s.custom} customized, ${s.default} default, ${s.off} not configured`
    + (offForwarded.length ? `; instance-env options left unset: ${offForwarded.join(', ')}` : '');
}

module.exports = { buildCatalogOnlyStatus, buildEnvStatus, describeVariable, loadCatalog, redactValue, summarizeForLog, SECRET_NAME };
