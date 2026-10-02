'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildSshArgs } = require('./openclaw/agentInventory');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 45000;
const BACKLOG_TTL_MS = 5 * 60 * 1000;
const CATCHUP_TTL_MS = 60 * 1000;
const LABELS = Object.freeze(['urgent', 'needs-reply']);
const THREAD_ID = /^[0-9a-f]{10,32}$/;

class SecretaryMailError extends Error {
  constructor(message, { code = 'SECRETARY_MAIL_FAILED', statusCode = 503 } = {}) {
    super(message);
    this.name = 'SecretaryMailError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function remoteRoot(value) {
  const root = String(value || '').trim().replace(/\/$/, '');
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(root) || root.includes('/../') || root.endsWith('/..')) {
    throw new SecretaryMailError('The Secretary mail remote root is invalid.', { code: 'SECRETARY_MAIL_CONFIGURATION_INVALID' });
  }
  return root;
}

function exactLabel(value) {
  const label = String(value || '').trim().toLowerCase();
  if (!LABELS.includes(label)) {
    throw new SecretaryMailError('label must be urgent or needs-reply', { code: 'SECRETARY_MAIL_BAD_LABEL', statusCode: 400 });
  }
  return label;
}

function exactThreadId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!THREAD_ID.test(id)) {
    throw new SecretaryMailError('threadId must be a Gmail thread id', { code: 'SECRETARY_MAIL_BAD_THREAD', statusCode: 400 });
  }
  return id;
}

async function defaultSshRunner(target, command, options = {}) {
  return execFileAsync(options.sshBin || process.env.OPENCLAW_INVENTORY_SSH_BIN || 'ssh', buildSshArgs(target, command, options), {
    timeout: Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true
  });
}

// The Secretary's Gmail authorization lives in the OpenClaw host keyring, never
// in the Core container. Every argument reaching the remote shell is validated
// against a closed vocabulary first.
class SecretaryMailControl {
  constructor(options = {}) {
    this.contractVersion = 1;
    this.target = String(options.sshTarget || process.env.OPENCLAW_INVENTORY_SSH_TARGET || '').trim();
    // Same deployed checkout as the coding dispatcher host scripts.
    this.root = options.remoteRoot || process.env.SECRETARY_MAIL_REMOTE_ROOT || process.env.CODING_DISPATCHER_REMOTE_ROOT || '';
    if (this.root) this.root = remoteRoot(this.root);
    this.runner = options.sshRunner || defaultSshRunner;
    this.sshOptions = options.sshOptions || {};
    this.now = options.now || (() => Date.now());
    this.cachedBacklog = null;
    this.pendingBacklog = null;
    this.cachedCatchup = null;
    this.pendingCatchup = null;
  }

  get available() { return Boolean(this.target && this.root); }

  async call(args) {
    if (!this.available) {
      throw new SecretaryMailError('The OpenClaw host is not configured for Secretary mail.', { code: 'SECRETARY_MAIL_UNAVAILABLE' });
    }
    let payload;
    try {
      const result = await this.runner(this.target, `/usr/bin/python3 ${this.root}/integrations/secretary/secretary_mail_desk.py ${args}`, this.sshOptions);
      payload = JSON.parse(typeof result === 'string' ? result : result.stdout);
    } catch {
      throw new SecretaryMailError('The OpenClaw host did not answer the Secretary mail request.', { code: 'SECRETARY_MAIL_HOST_UNAVAILABLE' });
    }
    if (payload?.status === 'error') {
      throw new SecretaryMailError(String(payload.message || 'Secretary mail failed'), { code: payload.code, statusCode: Number(payload.statusCode) || 503 });
    }
    if (payload?.status !== 'success' || !payload.data) {
      throw new SecretaryMailError('The OpenClaw host answer was incomplete.', { code: 'SECRETARY_MAIL_HOST_UNAVAILABLE' });
    }
    return payload.data;
  }

  async threads(label) {
    return this.call(`threads --label ${exactLabel(label)}`);
  }

  async handled({ threadId, label } = {}) {
    return this.call(`handled --label ${exactLabel(label)} --thread ${exactThreadId(threadId)}`);
  }

  // Senders the triage most often leaves in Review, as rule candidates.
  async senders() {
    return this.call('senders');
  }

  // The desk refreshes often; one Gmail count every five minutes is enough to
  // show that mail is piling up unlabelled.
  async backlog({ refresh = false } = {}) {
    const now = this.now();
    if (!refresh && this.cachedBacklog && now - this.cachedBacklog.at < BACKLOG_TTL_MS) return this.cachedBacklog.data;
    // Concurrent desk loads share one host request; a caller that stops waiting
    // still lets it finish and fill the cache.
    if (!this.pendingBacklog) {
      this.pendingBacklog = this.call('backlog')
        .then((counted) => {
          const data = { ...counted, checkedAt: new Date(now).toISOString() };
          this.cachedBacklog = { at: now, data };
          return data;
        })
        .finally(() => { this.pendingBacklog = null; });
    }
    return this.pendingBacklog;
  }

  // Counts of the archive catch-up job (no Gmail call); one host read a minute.
  async catchup() {
    const now = this.now();
    if (this.cachedCatchup && now - this.cachedCatchup.at < CATCHUP_TTL_MS) return this.cachedCatchup.data;
    if (!this.pendingCatchup) {
      this.pendingCatchup = this.call('catchup')
        .then((data) => { this.cachedCatchup = { at: now, data }; return data; })
        .finally(() => { this.pendingCatchup = null; });
    }
    return this.pendingCatchup;
  }
}

module.exports = { LABELS, SecretaryMailControl, SecretaryMailError };
