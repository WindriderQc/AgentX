'use strict';

/**
 * Client of the runtime topology host actuator (#360, phases 3 and 4).
 *
 * The actuator (`integrations/topology-actuator/`) runs on a GPU host and
 * accepts four commands: status, activate <mode>, confirm, rollback. Core
 * reaches it over SSH with a dedicated key whose authorized_keys entry forces
 * the actuator, so Core never holds a shell on the host.
 *
 * `AGENTX_TOPOLOGY_ACTUATORS_JSON` names, per topology group, the SSH target,
 * the key and the known_hosts file (host keys are always checked). The
 * declaration names private hosts: errors never echo it.
 *
 * A transport failure during a mutating command leaves the host state unknown.
 * The caller reconciles by reading `status --request-id`; it never repeats a
 * command blindly.
 */

const { execFile } = require('child_process');

const RECEIPT_SCHEMA = 'agentx.runtime-topology-actuation/v1';
const GROUP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;
const MODE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const REASON = /^[a-z][a-z0-9_]{0,39}$/;
const SSH_TARGET = /^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9.\-:[\]]{1,253}$/;
const MAX_OUTPUT = 512 * 1024;

const DEFAULT_TIMEOUTS = Object.freeze({
  status: 30_000,
  activate: 15 * 60_000,
  confirm: 2 * 60_000,
  rollback: 15 * 60_000
});

function invalid() {
  return Object.assign(new Error('Topology actuator configuration is invalid'), {
    code: 'topology_actuator_configuration_invalid'
  });
}

function absolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 400 && !value.includes('\0');
}

/**
 * @returns {Map<string, {sshTarget, keyPath, knownHostsPath, port, timeouts}>}
 *   empty when unset. Throws a typed error when invalid.
 */
function parseActuators(raw = process.env.AGENTX_TOPOLOGY_ACTUATORS_JSON) {
  const result = new Map();
  if (raw === undefined || raw === null || raw === '') return result;
  if (typeof raw !== 'string' || raw.length > 16 * 1024) throw invalid();
  let doc;
  try { doc = JSON.parse(raw); } catch { throw invalid(); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw invalid();
  const entries = Object.entries(doc);
  if (entries.length > 8) throw invalid();
  for (const [groupId, spec] of entries) {
    if (!GROUP_ID.test(groupId) || !spec || typeof spec !== 'object' || Array.isArray(spec)) throw invalid();
    const allowed = ['sshTarget', 'keyPath', 'knownHostsPath', 'port', 'timeoutsMs'];
    if (!Object.keys(spec).every(key => allowed.includes(key))) throw invalid();
    if (typeof spec.sshTarget !== 'string' || !SSH_TARGET.test(spec.sshTarget)) throw invalid();
    if (!absolutePath(spec.keyPath) || !absolutePath(spec.knownHostsPath)) throw invalid();
    let port = 22;
    if (spec.port !== undefined) {
      if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) throw invalid();
      port = spec.port;
    }
    const timeouts = { ...DEFAULT_TIMEOUTS };
    if (spec.timeoutsMs !== undefined) {
      if (!spec.timeoutsMs || typeof spec.timeoutsMs !== 'object') throw invalid();
      for (const [command, value] of Object.entries(spec.timeoutsMs)) {
        if (!(command in DEFAULT_TIMEOUTS) || !Number.isInteger(value) || value < 5000 || value > 60 * 60_000) {
          throw invalid();
        }
        timeouts[command] = value;
      }
    }
    result.set(groupId, {
      sshTarget: spec.sshTarget, keyPath: spec.keyPath, knownHostsPath: spec.knownHostsPath, port, timeouts
    });
  }
  return result;
}

function sshArgs(target, remoteCommand) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${target.knownHostsPath}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'LogLevel=ERROR',
    '-i', target.keyPath,
    '-p', String(target.port),
    target.sshTarget,
    remoteCommand
  ];
}

function defaultRunner(args, { timeoutMs }) {
  return new Promise((resolve) => {
    execFile('ssh', args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ exitCode: 0, stdout, stderr, timedOut: false });
      const timedOut = Boolean(error.killed && error.signal);
      const exitCode = typeof error.code === 'number' ? error.code : null;
      resolve({ exitCode, stdout: stdout || '', stderr: stderr || '', timedOut });
    });
  });
}

function lastReceipt(stdout) {
  const lines = String(stdout || '').split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && parsed.schema === RECEIPT_SCHEMA) return parsed;
    } catch { /* not the receipt line */ }
  }
  return null;
}

/**
 * Build a client. `runner(args, {timeoutMs})` is injectable for tests and
 * resolves `{exitCode, stdout, stderr, timedOut}`.
 *
 * Every call resolves (never rejects) to:
 *   { transport: 'ok'|'not_configured'|'unreachable'|'timeout'|'bad_receipt',
 *     exitCode, receipt, outcome }
 * `outcome` is the receipt's outcome, or `unknown` when no receipt came back.
 */
function createActuatorClient({ readRaw = () => process.env.AGENTX_TOPOLOGY_ACTUATORS_JSON, runner = defaultRunner } = {}) {
  function target(groupId) {
    let actuators;
    try { actuators = parseActuators(readRaw()); } catch (error) { return { error: error.code }; }
    const found = actuators.get(groupId);
    return found ? { target: found } : { error: 'topology_actuator_not_configured' };
  }

  async function call(groupId, command, words) {
    const resolved = target(groupId);
    if (!resolved.target) {
      return { transport: 'not_configured', reason: resolved.error, exitCode: null, receipt: null, outcome: 'unknown' };
    }
    const timeoutMs = resolved.target.timeouts[command];
    const result = await runner(sshArgs(resolved.target, words.join(' ')), { timeoutMs });
    const receipt = lastReceipt(result.stdout);
    if (result.timedOut) {
      return { transport: 'timeout', exitCode: result.exitCode, receipt, outcome: receipt?.outcome || 'unknown' };
    }
    if (!receipt) {
      // ssh exits 255 for its own failures; the actuator never does.
      const transport = result.exitCode === 255 ? 'unreachable' : 'bad_receipt';
      return { transport, exitCode: result.exitCode, receipt: null, outcome: 'unknown' };
    }
    return { transport: 'ok', exitCode: result.exitCode, receipt, outcome: receipt.outcome };
  }

  function checkRequestId(requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw Object.assign(new Error('Invalid actuator request id'), { code: 'invalid_request_id' });
    }
  }

  return Object.freeze({
    configured(groupId) {
      return Boolean(target(groupId).target);
    },
    configurationError(groupId) {
      return target(groupId).error || null;
    },
    status(groupId, requestId) {
      if (requestId !== undefined) checkRequestId(requestId);
      return call(groupId, 'status', requestId ? ['status', '--request-id', requestId] : ['status']);
    },
    activate(groupId, mode, requestId) {
      if (typeof mode !== 'string' || !MODE_ID.test(mode)) {
        throw Object.assign(new Error('Invalid mode'), { code: 'invalid_mode' });
      }
      checkRequestId(requestId);
      return call(groupId, 'activate', ['activate', mode, '--request-id', requestId]);
    },
    confirm(groupId, requestId) {
      checkRequestId(requestId);
      return call(groupId, 'confirm', ['confirm', '--request-id', requestId]);
    },
    rollback(groupId, requestId, reason = 'core_rollback') {
      checkRequestId(requestId);
      if (!REASON.test(reason)) throw Object.assign(new Error('Invalid reason'), { code: 'invalid_reason' });
      return call(groupId, 'rollback', ['rollback', '--request-id', requestId, '--reason', reason]);
    }
  });
}

module.exports = {
  RECEIPT_SCHEMA,
  DEFAULT_TIMEOUTS,
  parseActuators,
  createActuatorClient,
  sshArgs,
  lastReceipt
};
