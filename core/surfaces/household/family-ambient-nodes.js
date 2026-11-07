'use strict';

// The graph belongs to the instance. Product code ships no machine inventory.
function readNodeHints(env = process.env, logger = null) {
  const raw = env.HOUSEHOLD_ECOSYSTEM_NODE_HINTS_JSON;
  if (!raw) return [];
  try {
    if (raw.length > 16384) throw new Error('oversized mapping');
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('expected object');
    const entries = Object.entries(value);
    if (entries.length > 64) throw new Error('too many nodes');
    return entries.map(([node, hints]) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(node)
        || !Array.isArray(hints) || hints.length < 1 || hints.length > 16
        || hints.some(hint => typeof hint !== 'string' || !hint.trim() || hint.length > 200)) {
        throw new Error('invalid node or hints');
      }
      return [node, [...new Set([node.toLowerCase(), ...hints.map(hint => hint.trim().toLowerCase())])]];
    });
  } catch {
    logger?.warn?.('HOUSEHOLD_ECOSYSTEM_NODE_HINTS_JSON is invalid; ecosystem machine links are disabled.');
    return [];
  }
}

function nodeFor(key, nodeHints = readNodeHints()) {
  const text = String(key || '').toLowerCase();
  return nodeHints.find(([, hints]) => hints.some(hint => text.includes(hint)))?.[0] || null;
}

// Only node IDs reach the family screen; names, addresses and alert text do not.
function alertView(report, nodeHints = readNodeHints()) {
  if (!report) return null;
  const findings = (Array.isArray(report.findings) ? report.findings : [])
    .filter(finding => finding?.severity === 'critical' || nodeFor(finding?.key, nodeHints));
  const nodes = [...new Set(findings.map(finding => nodeFor(finding?.key, nodeHints)).filter(Boolean))].slice(0, 3);
  return {
    at: report.at || null,
    fingerprint: report.fingerprint || null,
    count: findings.length,
    critical: findings.filter(finding => finding?.severity === 'critical').length,
    nodes
  };
}

module.exports = { readNodeHints, nodeFor, alertView };
