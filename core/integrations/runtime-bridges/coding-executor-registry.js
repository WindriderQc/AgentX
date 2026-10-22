'use strict';

const DEFAULT_ROOT = '/srv/agentx/AgentX';
const DEFAULT_PROFILES = ['code', 'report', 'autonomous'];
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HARNESS = /^[a-z][a-z0-9._-]{0,63}$/;
const TARGET = /^[a-z0-9_.-]+@[a-z0-9_.:-]+$/i;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function invalid(message) {
  const error = new Error(message);
  error.code = 'CODING_EXECUTOR_CONFIGURATION_INVALID';
  error.statusCode = 503;
  return error;
}

function root(value) {
  const result = String(value || DEFAULT_ROOT).trim().replace(/\/$/, '');
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(result) || result.includes('/../') || result.endsWith('/..'))
    throw invalid('A coding executor remote root is invalid.');
  return result;
}

function normalize(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`Coding executor ${index + 1} must be an object.`);
  const id = String(value.id || '').trim();
  const label = String(value.label || id).trim();
  const harness = String(value.harness || '').trim();
  const sshTarget = String(value.sshTarget || '').trim();
  if (!ID.test(id)) throw invalid(`Coding executor ${index + 1} has an invalid id.`);
  if (!LABEL.test(label)) throw invalid(`Coding executor ${id} has an invalid label.`);
  if (!HARNESS.test(harness)) throw invalid(`Coding executor ${id} has an invalid harness.`);
  if (!TARGET.test(sshTarget)) throw invalid(`Coding executor ${id} has an invalid SSH target.`);
  const profiles = value.profiles === undefined ? DEFAULT_PROFILES : value.profiles;
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > DEFAULT_PROFILES.length
    || profiles.some(item => !DEFAULT_PROFILES.includes(item)) || new Set(profiles).size !== profiles.length)
    throw invalid(`Coding executor ${id} has invalid profiles.`);
  const priority = value.priority === undefined ? 100 : value.priority;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 10000) throw invalid(`Coding executor ${id} has an invalid priority.`);
  return Object.freeze({ id, label, harness, sshTarget, remoteRoot: root(value.remoteRoot), profiles: Object.freeze([...profiles]),
    priority, enabled: value.enabled !== false, capacity: 1 });
}

function normalizeAll(values) {
  if (!Array.isArray(values) || values.length > 32) throw invalid('Coding executors must be an array of at most 32 entries.');
  const executors = values.map(normalize);
  if (new Set(executors.map(item => item.id)).size !== executors.length) throw invalid('Coding executor ids must be unique.');
  if (new Set(executors.map(item => item.sshTarget)).size !== executors.length)
    throw invalid('Each coding executor needs a distinct SSH host target.');
  return executors.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function fromEnvironment(env = process.env) {
  const raw = String(env.CODING_EXECUTORS_JSON || '').trim();
  if (raw) {
    let values;
    try { values = JSON.parse(raw); }
    catch { throw invalid('CODING_EXECUTORS_JSON must be valid JSON.'); }
    if (!Array.isArray(values) || !values.length) throw invalid('CODING_EXECUTORS_JSON must contain one to 32 executors.');
    return normalizeAll(values);
  }
  const sshTarget = String(env.CODING_DISPATCHER_SSH_TARGET || '').trim();
  return sshTarget ? [normalize({ id: 'default', harness: 'dsh', sshTarget,
    remoteRoot: env.CODING_DISPATCHER_REMOTE_ROOT || DEFAULT_ROOT }, 0)] : [];
}

function publicExecutor(executor) {
  return { id: executor.id, label: executor.label, harness: executor.harness, profiles: [...executor.profiles], priority: executor.priority,
    capacity: executor.capacity, enabled: executor.enabled };
}

module.exports = { DEFAULT_ROOT, DEFAULT_PROFILES, fromEnvironment, normalize, normalizeAll, publicExecutor, root };
