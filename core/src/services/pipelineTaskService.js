/**
 * Product-owned Mongo task queue. Environment-specific boards may consume the
 * bounded /api/pipeline contract from a separately deployed adapter.
 */
const crypto = require('crypto');
const PipelineTask = require('../../models/PipelineTask');
const PipelineAutomationSlot = require('../../models/PipelineAutomationSlot');
const Counter = require('../../models/Counter');
const workerTaskScope = require('../helpers/workerTaskScope');
const { taskEligibilityReasons } = require('./pipelineTaskEligibility');
const { validateRequest, validateSpec, renderTodo } = require('./todoAuthoringService');
const {
  normalizePipelineAutomationIntent,
} = require('../../../shared/pipelineAutomationContract');
const logger = require('../../config/logger');
const { attemptLogReference, exactRequestId } = require('./pipelineEvidenceReferences');
const { buildTransition, recordTransition, initialTransition } = require('./pipelineTaskTransitions');
const codingCapacity = require('./pipelineCodingCapacity');

const VALID_RISKS = new Set(['', 'low', 'medium', 'high', 'critical']);
const PIPELINE_ID_RE = /^\d{3,4}$/;
const AUTOMATION_SLOT_ID = 'coding-dispatcher-v1';

function pipelineInputError(message, code = 'INVALID_TASK_METADATA') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

/**
 * Three-way result, because "leave it alone" and "clear it" are different
 * intents and collapsing them hides a gate. `undefined` means the caller did
 * not mention the field; `null` means the caller explicitly cleared it.
 */
function parseOptionalDate(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw pipelineInputError(`${field} must be an ISO date/time`, 'INVALID_TASK_DATE');
  }
  return date;
}

/** `notBefore` with its `surface_after` alias, without letting an explicit null fall through to the alias. */
function pickNotBeforeInput(input = {}) {
  if (input.notBefore !== undefined) return input.notBefore;
  if (input.surface_after !== undefined) return input.surface_after;
  return undefined;
}

function normalizeTaskRoutingMetadata(input = {}) {
  const metadata = {};

  if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
    const priority = Number(input.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      throw pipelineInputError('priority must be an integer from 1 (highest) to 5', 'INVALID_TASK_PRIORITY');
    }
    metadata.priority = priority;
  }

  if (input.dependsOn !== undefined) {
    if (!Array.isArray(input.dependsOn)) {
      throw pipelineInputError('dependsOn must be an array of pipeline ids', 'INVALID_TASK_DEPENDENCIES');
    }
    const dependsOn = [...new Set(input.dependsOn.map((id) => String(id || '').trim()).filter(Boolean))];
    if (dependsOn.some((id) => !PIPELINE_ID_RE.test(id))) {
      throw pipelineInputError('dependsOn entries must be 3- or 4-digit pipeline ids', 'INVALID_TASK_DEPENDENCIES');
    }
    metadata.dependsOn = dependsOn;
  }

  const notBefore = parseOptionalDate(pickNotBeforeInput(input), 'notBefore');
  const dueAt = parseOptionalDate(input.dueAt, 'dueAt');
  if (notBefore !== undefined) metadata.notBefore = notBefore;
  if (dueAt !== undefined) metadata.dueAt = dueAt;

  if (input.risk !== undefined && input.risk !== null) {
    const risk = String(input.risk).trim().toLowerCase();
    if (!VALID_RISKS.has(risk)) {
      throw pipelineInputError(`risk must be one of ${[...VALID_RISKS].join('|')}`, 'INVALID_TASK_RISK');
    }
    metadata.risk = risk;
  }

  if (input.automation !== undefined && input.automation !== null) {
    metadata.automation = normalizePipelineAutomationIntent(input.automation);
  }

  if (input.planningItemIds !== undefined) {
    if (!Array.isArray(input.planningItemIds) || input.planningItemIds.length > 30
      || input.planningItemIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))) {
      throw pipelineInputError('planningItemIds must contain at most 30 roadmap item ids', 'INVALID_PLANNING_LINKS');
    }
    metadata.planningItemIds = [...new Set(input.planningItemIds)];
  }

  return metadata;
}

async function assertPlanningLinksExist(ids = [], previous = []) {
  const added = ids.filter(id => !previous.map(String).includes(id));
  if (!added.length) return;
  const PlanningItem = require('../../models/PlanningItem');
  const count = await PlanningItem.countDocuments({ _id: { $in: added }, status: { $ne: 'archived' } });
  if (count !== added.length) throw pipelineInputError('A selected roadmap item is missing or archived', 'INVALID_PLANNING_LINKS');
}

async function assertDependenciesExist(dependsOn = []) {
  if (!dependsOn.length) return;
  const rows = await PipelineTask.find({ pipelineId: { $in: dependsOn } })
    .select('pipelineId')
    .lean();
  const found = new Set(rows.map((row) => row.pipelineId));
  const missing = dependsOn.filter((id) => !found.has(id));
  if (missing.length) {
    throw pipelineInputError(`unknown dependency pipeline id(s): ${missing.join(', ')}`, 'UNKNOWN_TASK_DEPENDENCY');
  }
}

/**
 * Reject a dependency set that would make `pipelineId` permanently unclaimable.
 *
 * `dependenciesAreDone` requires every dependency to be `done`, so a task that
 * reaches itself through the graph can never become eligible — and nothing
 * reports it. `findNextEligibleTask` just skips it forever, which reads as "no
 * work available" rather than "this card is stuck".
 *
 * Creation points at existing tasks; the task editor also calls this before
 * replacing dependencies on an existing task.
 */
async function assertNoDependencyCycle(pipelineId, dependsOn = []) {
  if (!pipelineId || !dependsOn.length) return;
  if (dependsOn.includes(pipelineId)) {
    throw pipelineInputError(
      `task ${pipelineId} cannot depend on itself`,
      'TASK_DEPENDENCY_CYCLE'
    );
  }

  const visited = new Set(dependsOn);
  let frontier = [...dependsOn];
  while (frontier.length) {
    const rows = await PipelineTask.find({ pipelineId: { $in: frontier } })
      .select('pipelineId dependsOn')
      .lean();
    const nextFrontier = [];
    for (const row of rows) {
      for (const dependency of row.dependsOn || []) {
        if (dependency === pipelineId) {
          throw pipelineInputError(
            `dependency cycle: ${pipelineId} is reachable from its own dependencies via ${row.pipelineId}`,
            'TASK_DEPENDENCY_CYCLE'
          );
        }
        if (!visited.has(dependency)) {
          visited.add(dependency);
          nextFrontier.push(dependency);
        }
      }
    }
    frontier = nextFrontier;
  }
}

function buildEligibleQueueQuery(_params = {}, now = new Date()) {
  return {
    ...workerTaskScope(),
    status: 'queued',
    assignee: null,
    $or: [
      { notBefore: null },
      { notBefore: { $exists: false } },
      { notBefore: { $lte: now } },
    ],
  };
}

function compareEligibleTasks(left, right) {
  const leftPriority = Number.isInteger(left.priority) ? left.priority : 3;
  const rightPriority = Number.isInteger(right.priority) ? right.priority : 3;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;

  const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  return String(left.pipelineId).localeCompare(String(right.pipelineId));
}

async function loadDependencyStatuses(tasks = []) {
  const ids = [...new Set(tasks.flatMap((task) => task.dependsOn || []))];
  if (!ids.length) return new Map();
  const rows = await PipelineTask.find({ pipelineId: { $in: ids } })
    .select('pipelineId status')
    .lean();
  return new Map(rows.map((row) => [row.pipelineId, row.status]));
}

async function findNextEligibleTask(params = {}, now = new Date()) {
  const candidates = await PipelineTask.find(buildEligibleQueueQuery(params, now)).lean();
  candidates.sort(compareEligibleTasks);
  const dependencyStatuses = await loadDependencyStatuses(candidates);
  const automationRequested = ['1', 'true', 'yes', 'on', 'review_only']
    .includes(String(params.automation || '').toLowerCase());
  return candidates.find((task) => {
    return taskEligibilityReasons(task, { dependencyStatuses, now, automated: automationRequested }).length === 0;
  }) || null;
}

function pipelineConflict(message, code) {
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  return err;
}

async function acquireAutomationSlot({ leaseId, pipelineId, assignee, lockKeys, now, expiresAt }) {
  try {
    const slot = await PipelineAutomationSlot.findOneAndUpdate(
      {
        _id: AUTOMATION_SLOT_ID,
        $or: [
          { leaseId: null },
          { leaseId: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $exists: false } },
          { expiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          leaseId,
          pipelineId,
          assignee,
          lockKeys,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    if (!slot || slot.leaseId !== leaseId) {
      throw pipelineConflict('the autonomous coding slot is already occupied', 'AUTOMATION_SLOT_OCCUPIED');
    }
    return slot;
  } catch (err) {
    if (err?.code === 11000) {
      throw pipelineConflict('the autonomous coding slot is already occupied', 'AUTOMATION_SLOT_OCCUPIED');
    }
    throw err;
  }
}

async function extendAutomationSlot({ leaseId, pipelineId, assignee, now, expiresAt }) {
  const slot = await PipelineAutomationSlot.findOneAndUpdate(
    {
      _id: AUTOMATION_SLOT_ID,
      leaseId,
      pipelineId,
      assignee,
      expiresAt: { $gt: now },
    },
    { $set: { heartbeatAt: now, expiresAt } },
    { new: true }
  );
  if (!slot) {
    throw pipelineConflict('the autonomous coding slot is missing, expired, or reassigned', 'AUTOMATION_SLOT_MISMATCH');
  }
  return slot;
}

async function releaseAutomationSlot({ leaseId, pipelineId, assignee } = {}) {
  if (!leaseId) return false;
  if (pipelineId) {
    const terminal = await PipelineTask.findOne({ pipelineId, status: { $ne: 'in_progress' },
      'codingCapacity.admissionId': { $exists: true } }).lean();
    if (terminal) {
      await codingCapacity.release(terminal.codingCapacity);
      await PipelineTask.updateOne({ pipelineId, status: { $ne: 'in_progress' },
        'codingCapacity.admissionId': terminal.codingCapacity.admissionId,
        'codingCapacity.generation': terminal.codingCapacity.generation }, { $unset: { codingCapacity: 1 } });
    }
  }
  const result = await PipelineAutomationSlot.updateOne(
    {
      _id: AUTOMATION_SLOT_ID,
      leaseId,
      ...(pipelineId ? { pipelineId } : {}),
      ...(assignee ? { assignee } : {}),
    },
    {
      $set: {
        leaseId: null,
        pipelineId: null,
        assignee: null,
        lockKeys: [],
        acquiredAt: null,
        heartbeatAt: null,
        expiresAt: null,
      },
    }
  );
  return result.modifiedCount === 1;
}

function assertLeaseMutationAllowed(task, { assignee, leaseId, now = new Date() } = {}) {
  const lease = task?.automationLease;
  const normalizedLeaseId = String(leaseId || '').trim();
  // A caller naming a lease speaks for that attempt only. Once the attempt is
  // closed, requeued or decided, its late result must not act as unleased input.
  if (!lease?.leaseId && !normalizedLeaseId) return null;
  if (!lease?.leaseId || task.status !== 'in_progress') {
    throw pipelineConflict('automation lease is no longer active', 'TASK_LEASE_INACTIVE');
  }
  const normalizedAssignee = String(assignee || '').trim();
  if (!normalizedLeaseId || normalizedLeaseId !== String(lease.leaseId)) {
    throw pipelineConflict('automation lease identity is missing or stale', 'TASK_LEASE_MISMATCH');
  }
  if (!normalizedAssignee || normalizedAssignee !== String(lease.assignee || task.assignee || '')) {
    throw pipelineConflict('automation lease assignee does not match the active claim', 'TASK_LEASE_ASSIGNEE_MISMATCH');
  }
  if (!lease.expiresAt || new Date(lease.expiresAt).getTime() <= now.getTime()) {
    throw pipelineConflict('automation lease has expired', 'TASK_LEASE_EXPIRED');
  }
  return {
    leaseId: normalizedLeaseId,
    assignee: normalizedAssignee,
    attempt: Number(lease.attempt),
    durationMs: Number(lease.durationMs),
  };
}

async function heartbeatClaim(pipelineId, identity = {}, now = new Date()) {
  const current = await PipelineTask.findOne({ pipelineId }).lean();
  if (!current) {
    const err = new Error('Task not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  const lease = assertLeaseMutationAllowed(current, { ...identity, now });
  if (!lease) {
    return PipelineTask.findOneAndUpdate(
      { pipelineId },
      { $set: { heartbeatAt: now } },
      { new: true }
    );
  }

  const expiresAt = new Date(now.getTime() + lease.durationMs);
  await codingCapacity.heartbeat(current.codingCapacity, lease.durationMs);
  await extendAutomationSlot({
    leaseId: lease.leaseId,
    pipelineId,
    assignee: lease.assignee,
    now,
    expiresAt,
  });
  const task = await PipelineTask.findOneAndUpdate(
    {
      pipelineId,
      status: 'in_progress',
      assignee: lease.assignee,
      'automationLease.leaseId': lease.leaseId,
      'automationLease.expiresAt': { $gt: now },
    },
    {
      $set: {
        heartbeatAt: now,
        'automationLease.heartbeatAt': now,
        'automationLease.expiresAt': expiresAt,
        'automationAttempts.$[attempt].heartbeatAt': now,
        'automationAttempts.$[attempt].expiresAt': expiresAt,
      },
    },
    {
      new: true,
      arrayFilters: [{ 'attempt.leaseId': lease.leaseId }],
    }
  );
  if (!task) {
    await releaseAutomationSlot({
      leaseId: lease.leaseId,
      pipelineId,
      assignee: lease.assignee,
    });
    throw pipelineConflict('automation lease changed before heartbeat was recorded', 'TASK_LEASE_MISMATCH');
  }
  return task;
}

function currentPlanBinding(task) {
  if (task.planRevision == null) return null;
  const revision = Number(task.planRevision);
  const plan = Array.isArray(task.planRevisions)
    ? task.planRevisions.find(item => Number(item.revision) === revision)
    : null;
  if (!Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(String(plan?.fingerprint || ''))) {
    throw pipelineConflict('the current plan revision is unavailable for this claim', 'PLAN_REVISION_UNAVAILABLE');
  }
  return { revision, fingerprint: plan.fingerprint };
}

async function claimEligibleTask(pipelineId, assignee, now = new Date(), options = {}) {
  const current = await PipelineTask.findOne({ pipelineId, ...workerTaskScope() }).lean();
  if (!current) {
    const err = new Error('Task not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  const dependencyStatuses = await loadDependencyStatuses([current]);
  const baseReasons = taskEligibilityReasons(current, { dependencyStatuses, now });
  if (baseReasons.length) {
    const reason = baseReasons[0];
    const errors = {
      task_unavailable: ['Task not available (already claimed or not queued)', 'TASK_UNAVAILABLE'],
      not_before: [`Task is not eligible before ${reason.notBefore}`, 'TASK_NOT_READY'],
      dependencies_incomplete: ['Task dependencies are not complete', 'TASK_DEPENDENCIES_BLOCKED'],
    };
    throw pipelineConflict(...errors[reason.code]);
  }

  if (options.automated) {
    const reasons = taskEligibilityReasons(current, {
      automated: true,
      dependencyStatuses,
      now,
      activeLockKeys: options.activeLockKeys,
      protectedPathPrefixes: options.protectedPathPrefixes,
    });
    if (reasons.length) {
      const err = new Error(`Task is not eligible for autonomous dispatch: ${reasons.map((reason) => reason.code).join(', ')}`);
      err.status = 409;
      err.code = 'AUTOMATION_INELIGIBLE';
      err.reasons = reasons;
      throw err;
    }
  }

  let automatedUpdate = null;
  if (options.automated) {
    const planBinding = currentPlanBinding(current);
    const automation = normalizePipelineAutomationIntent(current.automation);
    const requestedDuration = Number(options.leaseDurationMs || Math.min(900_000, automation.budgets.maxDurationMs));
    if (!Number.isSafeInteger(requestedDuration) || requestedDuration < 10_000 || requestedDuration > automation.budgets.maxDurationMs) {
      throw pipelineInputError(
        'leaseDurationMs must be an integer from 10000 through automation.budgets.maxDurationMs',
        'INVALID_LEASE_DURATION'
      );
    }
    const dispatchRequestId = options.dispatchRequestId == null ? null : exactRequestId(options.dispatchRequestId);
    if (options.dispatchRequestId != null && !dispatchRequestId) {
      throw pipelineInputError('dispatchRequestId must be the exact launch request UUID', 'INVALID_DISPATCH_REQUEST');
    }
    const attempt = Number(current.automationAttemptCount || 0) + 1;
    const leaseId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + requestedDuration);
    const lease = {
      leaseId,
      assignee,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      durationMs: requestedDuration,
      attempt,
      ...(dispatchRequestId ? { dispatchRequestId } : {}),
    };
    automatedUpdate = {
      attempt,
      expectedAttemptCount: attempt - 1,
      lease,
      update: {
        $set: { assignee, status: 'in_progress', heartbeatAt: now, automationLease: lease },
        $inc: { automationAttemptCount: 1 },
        $push: { automationAttempts: { ...lease, finalState: 'active',
          ...(planBinding ? { planRevision: planBinding.revision, planFingerprint: planBinding.fingerprint } : {}) } },
      },
    };
  }

  const claimQuery = {
    ...workerTaskScope(),
    pipelineId,
    assignee: null,
    status: 'queued',
    $or: [
      { notBefore: null },
      { notBefore: { $exists: false } },
      { notBefore: { $lte: now } },
    ],
  };
  if (automatedUpdate) {
    claimQuery['automation.mode'] = 'review_only';
    claimQuery.planRevision = current.planRevision || null;
    if (automatedUpdate.expectedAttemptCount === 0) {
      claimQuery.$and = [{
        $or: [
          { automationAttemptCount: 0 },
          { automationAttemptCount: { $exists: false } },
        ],
      }];
    } else {
      claimQuery.automationAttemptCount = automatedUpdate.expectedAttemptCount;
    }
  }

  const claimUpdate = automatedUpdate?.update || { $set: { assignee, status: 'in_progress', heartbeatAt: now } };
  const lease = automatedUpdate?.lease;


  if (automatedUpdate) {
    await acquireAutomationSlot({
      leaseId: automatedUpdate.lease.leaseId,
      pipelineId,
      assignee,
      lockKeys: current.automation.lockKeys,
      now,
      expiresAt: automatedUpdate.lease.expiresAt,
    });
  }

  let task;
  let reservedCapacity;
  try {
    if (automatedUpdate && (options.capacityTaskType || current.codingCapacity)) {
      reservedCapacity = await codingCapacity.reserve(current, {
        taskType: options.capacityTaskType || current.codingCapacity.taskType, assignee,
        requestId: automatedUpdate.lease.dispatchRequestId, ttl: automatedUpdate.lease.durationMs,
      });
      claimQuery['codingCapacity.requestId'] = reservedCapacity.requestId;
      claimQuery['codingCapacity.cancelled'] = { $ne: true };
      claimQuery['automation.fingerprint'] = current.automation.fingerprint;
      claimQuery.updatedAt = reservedCapacity.observedUpdatedAt;
      delete reservedCapacity.observedUpdatedAt;
      claimUpdate.$set.codingCapacity = reservedCapacity;
      const acquiredAt = new Date();
      const expiresAt = new Date(acquiredAt.getTime() + lease.durationMs);
      await extendAutomationSlot({ leaseId: lease.leaseId, pipelineId, assignee, now: acquiredAt, expiresAt });
      Object.assign(lease, { acquiredAt, heartbeatAt: acquiredAt, expiresAt });
      Object.assign(claimUpdate.$push.automationAttempts, { acquiredAt, heartbeatAt: acquiredAt, expiresAt });
      claimUpdate.$set.heartbeatAt = acquiredAt;
    }
  recordTransition(claimQuery, claimUpdate, current, buildTransition(current, {
    to: 'in_progress',
    kind: 'claimed',
    channel: lease ? 'automation_lease' : 'worker_api',
    declaredActor: assignee,
    attempt: lease?.attempt,
    leaseId: lease?.leaseId,
    dispatchRequestId: lease?.dispatchRequestId,
    at: lease?.acquiredAt || now,
  }));
    task = await PipelineTask.findOneAndUpdate(
      claimQuery,
      claimUpdate,
      { new: true },
    );
  } catch (err) {
    if (reservedCapacity) await codingCapacity.release(reservedCapacity);
    if (automatedUpdate) {
      await releaseAutomationSlot({
        leaseId: automatedUpdate.lease.leaseId,
        pipelineId,
        assignee,
      });
    }
    throw err;
  }
  if (!task) {
    if (reservedCapacity) await codingCapacity.release(reservedCapacity);
    if (automatedUpdate) {
      await releaseAutomationSlot({
        leaseId: automatedUpdate.lease.leaseId,
        pipelineId,
        assignee,
      });
    }
    const err = new Error('Task not available (eligibility changed or another worker claimed it)');
    err.status = 409;
    err.code = 'TASK_UNAVAILABLE';
    throw err;
  }
  if (automatedUpdate) {
    logger.info('Pipeline automation attempt claimed', attemptLogReference({ pipelineId, ...automatedUpdate.lease }));
  }
  return task;
}

/**
 * Create a task directly in Mongo (the membrane). Atomic id via Counter — no
 * git file, no ROADMAP append, no id race. Every supplied task field follows
 * the same authoring path, including lightweight and partially structured tasks.
 */
async function createTaskInMongo(input = {}) {
  const req = validateRequest(input);
  const source = String(input.source || 'api').slice(0, 80);
  const sourceKey = input.sourceKey == null ? null : String(input.sourceKey).trim().slice(0, 200);
  if (sourceKey) {
    const existing = await PipelineTask.findOne({ source, sourceKey }).lean();
    if (existing) {
      return {
        id: existing.pipelineId,
        pipelineId: existing.pipelineId,
        title: existing.title,
        service: existing.service || '',
        status: existing.status,
        alreadyExisting: true,
      };
    }
  }
  const routingMetadata = normalizeTaskRoutingMetadata(input);
  await assertDependenciesExist(routingMetadata.dependsOn || []);
  await assertPlanningLinksExist(routingMetadata.planningItemIds || []);
  const suppliedSpec = input.spec === undefined ? undefined : validateSpec(input.spec);
  const seq = await Counter.next('pipelineTask');
  const pipelineId = String(seq).padStart(4, '0');
  await assertNoDependencyCycle(pipelineId, routingMetadata.dependsOn || []);
  const spec = suppliedSpec === undefined ? renderTodo({ id: pipelineId, ...req }) : suppliedSpec;
  try {
    await PipelineTask.create({
      pipelineId, title: req.title, spec, service: req.service || '',
      status: 'queued', epic: input.epic || 'MCP Inbox', source, sourceKey,
      ...routingMetadata,
      ...initialTransition(pipelineId),
    });
  } catch (err) {
    if (sourceKey && err?.code === 11000) {
      const existing = await PipelineTask.findOne({ source, sourceKey }).lean();
      if (existing) {
        return {
          id: existing.pipelineId,
          pipelineId: existing.pipelineId,
          title: existing.title,
          service: existing.service || '',
          status: existing.status,
          alreadyExisting: true,
        };
      }
    }
    throw err;
  }
  return {
    id: pipelineId,
    pipelineId,
    title: req.title,
    service: req.service || '',
    status: 'queued',
    ...routingMetadata,
  };
}

module.exports = {
  AUTOMATION_SLOT_ID,
  loadDependencyStatuses,
  createTaskInMongo,
  normalizeTaskRoutingMetadata,
  assertDependenciesExist,
  assertPlanningLinksExist,
  assertNoDependencyCycle,
  buildEligibleQueueQuery,
  compareEligibleTasks,
  findNextEligibleTask,
  claimEligibleTask,
  assertLeaseMutationAllowed,
  heartbeatClaim,
  releaseAutomationSlot,
};
