'use strict';

const ACTION_CATEGORIES = Object.freeze(['Urgent', 'Needs Reply', 'Waiting']);
const DEFAULT_EMAIL_ACTION_PROJECT_NAME = 'Secretary — Email Actions';
const DEFAULT_LEANTIME_RPC_TIMEOUT_MS = 15000;
const inFlightByThread = new Map();

class EmailActionError extends Error {
  constructor(message, { code = 'EMAIL_ACTION_ERROR', status = 400 } = {}) {
    super(message);
    this.name = 'EmailActionError';
    this.code = code;
    this.status = status;
  }
}

function compactText(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function configuredPositiveInteger(env, name) {
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EmailActionError(`${name} must be a positive integer`, {
      code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED',
      status: 503
    });
  }
  return value;
}

function emailActionConfig(env = process.env) {
  let baseUrl;
  try {
    baseUrl = new URL(env.LEANTIME_BASE_URL);
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new Error('Invalid URL');
  } catch {
    throw new EmailActionError('LEANTIME_BASE_URL must be a configured HTTP(S) URL', {
      code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED', status: 503
    });
  }
  return {
    leantimeBaseUrl: baseUrl.href.replace(/\/+$/, ''),
    leantimeProjectId: configuredPositiveInteger(env, 'LEANTIME_EMAIL_ACTION_PROJECT_ID'),
    leantimeUserId: configuredPositiveInteger(env, 'LEANTIME_EMAIL_ACTION_USER_ID')
  };
}

function positiveId(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function targetState(overrides = {}) {
  return {
    readOnly: true,
    configured: true,
    projectAccessible: false,
    projectIdentityVerified: false,
    projectRestricted: false,
    userExists: false,
    userAssigned: false,
    ticketReadAccessible: false,
    ...overrides
  };
}

async function inspectEmailActionTarget(rpc, config) {
  const project = await rpc('leantime.rpc.Projects.getProject', {
    id: config.leantimeProjectId
  });
  const projectId = project && typeof project === 'object'
    ? positiveId(project.id ?? project.projectId)
    : null;
  const projectName = compactText(project?.name, 160);
  const projectSetting = String(project?.psettings || '').trim().toLowerCase();
  if (projectId !== config.leantimeProjectId
    || projectName !== DEFAULT_EMAIL_ACTION_PROJECT_NAME
    || projectSetting !== 'restricted') {
    return targetState({
      projectAccessible: projectId === config.leantimeProjectId,
      projectRestricted: projectSetting === 'restricted',
      code: 'EMAIL_ACTION_PROJECT_IDENTITY_MISMATCH'
    });
  }

  const user = await rpc('leantime.rpc.Users.getUser', {
    id: config.leantimeUserId
  });
  const userId = user && typeof user === 'object'
    ? positiveId(user.id ?? user.userId)
    : null;
  if (userId !== config.leantimeUserId) {
    return targetState({
      projectAccessible: true,
      projectIdentityVerified: true,
      projectRestricted: true,
      code: 'EMAIL_ACTION_USER_UNAVAILABLE'
    });
  }

  const assignedProjects = await rpc('leantime.rpc.Projects.getProjectIdAssignedToUser', {
    userId: config.leantimeUserId
  });
  if (!Array.isArray(assignedProjects)) {
    return targetState({
      projectAccessible: true,
      projectIdentityVerified: true,
      projectRestricted: true,
      userExists: true,
      code: 'EMAIL_ACTION_USER_ASSIGNMENT_INVALID'
    });
  }
  const userAssigned = assignedProjects.some((entry) => {
    const value = entry && typeof entry === 'object'
      ? (entry.projectId ?? entry.id)
      : entry;
    return positiveId(value) === config.leantimeProjectId;
  });
  if (!userAssigned) {
    return targetState({
      projectAccessible: true,
      projectIdentityVerified: true,
      projectRestricted: true,
      userExists: true,
      code: 'EMAIL_ACTION_USER_NOT_ASSIGNED'
    });
  }

  return targetState({
    projectAccessible: true,
    projectIdentityVerified: true,
    projectRestricted: true,
    userExists: true,
    userAssigned: true,
    code: 'EMAIL_ACTION_TARGET_VERIFIED'
  });
}

async function verifyEmailActionTarget(rpc, config) {
  const proof = await inspectEmailActionTarget(rpc, config);
  if (proof.code !== 'EMAIL_ACTION_TARGET_VERIFIED') {
    throw new EmailActionError('Leantime email-action target verification failed', {
      code: proof.code || 'EMAIL_ACTION_TARGET_VERIFICATION_FAILED',
      status: 503
    });
  }
  return proof;
}

function parseDueAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new EmailActionError('dueAt must be an ISO date or datetime', {
      code: 'EMAIL_ACTION_BAD_DUE_DATE'
    });
  }
  return parsed;
}

function normalizeInput(input = {}, config = emailActionConfig()) {
  const gmailThreadId = compactText(input.gmailThreadId, 256);
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(gmailThreadId)) {
    throw new EmailActionError('gmailThreadId is required and must be an exact Gmail thread id', {
      code: 'EMAIL_ACTION_BAD_THREAD_ID'
    });
  }
  const category = compactText(input.category, 40);
  if (!ACTION_CATEGORIES.includes(category)) {
    throw new EmailActionError(`category must be one of ${ACTION_CATEGORIES.join(', ')}`, {
      code: 'EMAIL_ACTION_BAD_CATEGORY'
    });
  }
  const action = compactText(input.action, 200);
  if (!action) {
    throw new EmailActionError('action is required', { code: 'EMAIL_ACTION_ACTION_REQUIRED' });
  }
  const gmailMessageId = compactText(input.gmailMessageId, 256);
  if (gmailMessageId && !/^[A-Za-z0-9_-]{8,256}$/.test(gmailMessageId)) {
    throw new EmailActionError('gmailMessageId must be an exact Gmail message id', {
      code: 'EMAIL_ACTION_BAD_MESSAGE_ID'
    });
  }
  return {
    gmailThreadId,
    gmailMessageId,
    category,
    action,
    subject: compactText(input.subject, 300),
    sender: compactText(input.sender, 200),
    messageDate: compactText(input.messageDate, 60),
    dueAt: parseDueAt(input.dueAt),
    gmailUrl: `https://mail.google.com/mail/#all/${gmailThreadId}`,
    leantimeProjectId: config.leantimeProjectId
  };
}

async function leantimeRpc(method, params, attempt = 0, deps = {}) {
  const env = deps.env || process.env;
  const key = String(env.LEANTIME_API_KEY || '');
  if (!key) {
    throw new EmailActionError('LEANTIME_API_KEY is not configured', {
      code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED',
      status: 503
    });
  }
  const config = deps.config || emailActionConfig(env);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new EmailActionError('Leantime transport is unavailable', {
      code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED',
      status: 503
    });
  }
  let response;
  try {
    response = await fetchImpl(`${config.leantimeBaseUrl}/api/jsonrpc`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: deps.signal || AbortSignal.timeout(DEFAULT_LEANTIME_RPC_TIMEOUT_MS)
    });
  } catch (_error) {
    throw new EmailActionError(`Leantime RPC ${method} transport failed`, {
      code: 'EMAIL_ACTION_LEANTIME_TRANSPORT',
      status: 502
    });
  }
  if (response.status === 429 && attempt < 4) {
    const sleep = deps.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    await sleep(1000 + attempt * 1000);
    return leantimeRpc(method, params, attempt + 1, { ...deps, config, env, fetchImpl });
  }
  if (!response.ok) {
    throw new EmailActionError(`Leantime RPC ${method} returned HTTP ${response.status}`, {
      code: 'EMAIL_ACTION_LEANTIME_HTTP',
      status: 502
    });
  }
  let body;
  try {
    body = await response.json();
  } catch (_error) {
    throw new EmailActionError(`Leantime RPC ${method} returned invalid JSON`, {
      code: 'EMAIL_ACTION_LEANTIME_RESPONSE_INVALID',
      status: 502
    });
  }
  if (body?.error) {
    throw new EmailActionError(`Leantime RPC ${method} was rejected`, {
      code: 'EMAIL_ACTION_LEANTIME_RPC',
      status: 502
    });
  }
  return body?.result;
}

function markerFor(threadId) {
  return `Gmail thread: ${threadId}`;
}

function buildDescription(input) {
  const lines = [
    '<p>Email action captured by Nestor.</p>',
    `<p><strong>Category:</strong> ${escapeHtml(input.category)}<br>`,
    `<strong>Sender:</strong> ${escapeHtml(input.sender || 'unknown')}<br>`,
    `<strong>Message date:</strong> ${escapeHtml(input.messageDate || 'unknown')}<br>`,
    `<strong>Subject:</strong> ${escapeHtml(input.subject || 'not retained')}<br>`,
    `<strong>${escapeHtml(markerFor(input.gmailThreadId))}</strong></p>`,
    `<p><a href="${input.gmailUrl}">Open the Gmail thread</a></p>`,
    '<p>The email body remains in Gmail and is not copied into Leantime.</p>'
  ];
  return lines.join('');
}

async function findExistingTicket(input, rpc, config) {
  const tickets = await rpc('leantime.rpc.Tickets.getAll', {
    searchCriteria: { currentProject: config.leantimeProjectId, status: '' }
  });
  const restrictedTicketRead = Array.isArray(tickets) && tickets.every((ticket) =>
    ticket && typeof ticket === 'object'
      && positiveId(ticket.projectId ?? ticket.project_id) === config.leantimeProjectId);
  if (!restrictedTicketRead) {
    throw new EmailActionError('Leantime ticket read escaped the restricted project', {
      code: 'EMAIL_ACTION_TICKET_READ_INVALID',
      status: 503
    });
  }
  const marker = markerFor(input.gmailThreadId);
  return tickets.find((ticket) => String(ticket.description || '').includes(marker));
}

async function ensureLeantimeTicket(input, rpc, config) {
  await verifyEmailActionTarget(rpc, config);
  const existing = await findExistingTicket(input, rpc, config);
  if (existing?.id) return { ticketId: Number(existing.id), recovered: true };

  const ticketResult = await rpc('leantime.rpc.Tickets.quickAddTicket', {
    params: {
      projectId: config.leantimeProjectId,
      userId: config.leantimeUserId,
      type: 'task',
      headline: input.action,
      description: buildDescription(input),
      ...(input.dueAt ? { dateToFinish: input.dueAt.toISOString() } : {})
    }
  });
  const rawTicketId = ticketResult && typeof ticketResult === 'object'
    ? (ticketResult.id ?? ticketResult.ticketId)
    : ticketResult;
  const numericId = ['number', 'string'].includes(typeof rawTicketId)
    ? Number(rawTicketId)
    : Number.NaN;
  if (!Number.isFinite(numericId) || numericId <= 0) {
    const verified = await findExistingTicket(input, rpc, config);
    if (verified?.id) return { ticketId: Number(verified.id), recovered: true };
  }
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new EmailActionError('Leantime did not return a ticket id', {
      code: 'EMAIL_ACTION_LEANTIME_CREATE_FAILED',
      status: 502
    });
  }
  return { ticketId: numericId, recovered: false };
}

function serialize(record, config, { created = false, recovered = false } = {}) {
  const value = typeof record.toObject === 'function' ? record.toObject() : record;
  return {
    created,
    recovered,
    gmailThreadId: value.gmailThreadId,
    category: value.category,
    action: value.action,
    dueAt: value.dueAt ? new Date(value.dueAt).toISOString() : null,
    leantimeProjectId: value.leantimeProjectId,
    leantimeTicketId: value.leantimeTicketId,
    leantimeUrl: `${config.leantimeBaseUrl}/dashboard/home#/tickets/showTicket/${value.leantimeTicketId}`,
    state: value.state
  };
}

async function writeEmailAction(normalized, deps, config) {
  const model = deps.model;
  if (!model || typeof model.findOne !== 'function' || typeof model.create !== 'function') {
    throw new EmailActionError('Email-action receipt storage is unavailable', {
      code: 'EMAIL_ACTION_STORAGE_UNAVAILABLE',
      status: 503
    });
  }
  const rpc = deps.rpc || ((method, params) => leantimeRpc(method, params, 0, {
    config,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep
  }));
  let record = await model.findOne({ gmailThreadId: normalized.gmailThreadId });
  if (record?.leantimeTicketId) return serialize(record, config);

  let created = false;
  if (!record) {
    try {
      record = await model.create({ ...normalized, state: 'pending' });
      created = true;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      record = await model.findOne({ gmailThreadId: normalized.gmailThreadId });
    }
  }
  if (!record) {
    throw new EmailActionError('Could not create the email-action receipt', {
      code: 'EMAIL_ACTION_RECEIPT_CREATE_FAILED',
      status: 500
    });
  }
  if (record.leantimeTicketId) return serialize(record, config);

  try {
    const result = await ensureLeantimeTicket(normalized, rpc, config);
    Object.assign(record, normalized, {
      leantimeTicketId: result.ticketId,
      state: 'active',
      lastError: ''
    });
    await record.save();
    return serialize(record, config, { created, recovered: result.recovered });
  } catch (error) {
    record.state = 'error';
    record.lastError = compactText(error?.code || 'EMAIL_ACTION_ERROR', 120);
    await record.save();
    throw error;
  }
}

async function checkEmailActionReadiness(deps = {}) {
  const env = deps.env || process.env;
  try {
    const config = deps.config || emailActionConfig(env);
    if (!String(env.LEANTIME_API_KEY || '').trim()) {
      return targetState({
        configured: false,
        code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED'
      });
    }
    const rpc = deps.rpc || ((method, params) => leantimeRpc(method, params, 0, {
      config,
      env,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      signal: deps.signal
    }));

    const target = await inspectEmailActionTarget(rpc, config);
    if (target.code !== 'EMAIL_ACTION_TARGET_VERIFIED') return target;

    try {
      await findExistingTicket({ gmailThreadId: '__readiness_only__' }, rpc, config);
    } catch (error) {
      if (error?.code === 'EMAIL_ACTION_TICKET_READ_INVALID') {
        return targetState({
          projectAccessible: true,
          projectIdentityVerified: true,
          projectRestricted: true,
          userExists: true,
          userAssigned: true,
          code: error.code
        });
      }
      throw error;
    }
    return targetState({
      projectAccessible: true,
      projectIdentityVerified: true,
      projectRestricted: true,
      userExists: true,
      userAssigned: true,
      ticketReadAccessible: true,
      restrictedProjectId: config.leantimeProjectId,
      restrictedUserId: config.leantimeUserId,
      authorities: [
        'leantime.rpc.Projects.getProject',
        'leantime.rpc.Users.getUser',
        'leantime.rpc.Projects.getProjectIdAssignedToUser',
        'leantime.rpc.Tickets.getAll'
      ],
      code: 'EMAIL_ACTION_READY'
    });
  } catch (error) {
    return targetState({
      configured: error?.code !== 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED',
      code: error?.code || 'EMAIL_ACTION_READINESS_FAILED'
    });
  }
}

async function addEmailAction(input = {}, deps = {}) {
  const config = deps.config || emailActionConfig(deps.env || process.env);
  const normalized = normalizeInput(input, config);
  const existing = inFlightByThread.get(normalized.gmailThreadId);
  if (existing) return existing;

  const pending = writeEmailAction(normalized, deps, config);
  inFlightByThread.set(normalized.gmailThreadId, pending);
  try {
    return await pending;
  } finally {
    if (inFlightByThread.get(normalized.gmailThreadId) === pending) {
      inFlightByThread.delete(normalized.gmailThreadId);
    }
  }
}

module.exports = {
  ACTION_CATEGORIES,
  DEFAULT_EMAIL_ACTION_PROJECT_NAME,
  DEFAULT_LEANTIME_RPC_TIMEOUT_MS,
  EmailActionError,
  addEmailAction,
  buildDescription,
  checkEmailActionReadiness,
  emailActionConfig,
  ensureLeantimeTicket,
  inspectEmailActionTarget,
  leantimeRpc,
  markerFor,
  normalizeInput,
  verifyEmailActionTarget
};
