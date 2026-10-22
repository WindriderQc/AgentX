'use strict';

const crypto = require('node:crypto');
const Task = require('../../models/PipelineTask');
const policy = require('./pipelineCodingAutonomyPolicy');
const dagDomain = require('./pipelineCodeDagService');
const dagStateDefault = require('./pipelineCodeDagStateService');
const { defaultPipelineCodeStepArtifactService } = require('./pipelineCodeStepArtifactService');
const { fingerprint, validatePlan } = require('../../../shared/codeStepDagContract');

const WC = { w: 1, j: true };
const MANIFEST_SCHEMA = 'agentx.pipeline-code-step-worker-manifest/v1';
const COORDINATION_SCHEMA = 'agentx.pipeline-code-step-coordination/v1';
const ZERO_USAGE = Object.freeze({ workSeconds: 0, testSeconds: 0, modelSeconds: 0, modelCalls: 0 });
const TERMINAL_STEP_STATES = new Set(['verified', 'failed']);

class PipelineCodeDagCoordinatorError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'PipelineCodeDagCoordinatorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new PipelineCodeDagCoordinatorError(code, message, statusCode);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function iso(clock) {
  return new Date(clock()).toISOString();
}

function deterministicUuid(rootRequestId, role) {
  const hex = crypto.createHash('sha256').update(`${rootRequestId}\0${role}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function latestAttempt(step) {
  return step.attempts?.[step.attempts.length - 1] || null;
}

function currentHead(dag) {
  return dag.assembly.adoptions.at(-1)?.adoptedCommit || dag.sourceCommit;
}

function usage(value = {}) {
  const result = {};
  for (const key of dagDomain.BUDGET_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail('CODE_STEP_USAGE_INVALID', `Invalid ${key} usage`, 400);
    result[key] = value[key];
  }
  return result;
}

function availableExecutors(status, coordinatorId) {
  const rows = Array.isArray(status?.executors) ? status.executors : [];
  return rows.filter(row => row && row.id !== coordinatorId && row.enabled !== false
      && row.available !== false && row.busy !== true
      && (!Array.isArray(row.profiles) || row.profiles.includes('autonomous')))
    .sort((left, right) => (left.priority || 0) - (right.priority || 0) || left.id.localeCompare(right.id));
}

function attemptBudget(dag) {
  const remainingSteps = Math.max(1, dag.steps.filter(step => !TERMINAL_STEP_STATES.has(step.state)).length);
  const result = {};
  for (const key of dagDomain.BUDGET_KEYS) {
    const remaining = dag.budget.limit[key] - dag.budget.spent[key] - dag.budget.reserved[key];
    result[key] = Math.max(0, Math.floor(remaining / remainingSteps));
  }
  if (dagDomain.BUDGET_KEYS.every(key => result[key] === 0)) fail('CODE_STEP_BUDGET_EXHAUSTED', 'No aggregate code-step budget remains');
  return result;
}

function publicArtifact(metadata) {
  return { id: metadata.id, sha256: metadata.sha256, sizeBytes: metadata.sizeBytes, format: metadata.format };
}

function signedManifest(value) {
  const unsigned = clone(value);
  return { ...unsigned, manifestFingerprint: fingerprint(unsigned) };
}

function resultForHost(host) {
  return host?.run?.progress?.codeStepResult || host?.run?.codeStepResult || null;
}

function createPipelineCodeDagCoordinator(options = {}) {
  const Model = options.TaskModel || Task;
  const state = options.stateService || dagStateDefault;
  const artifacts = options.artifactService || defaultPipelineCodeStepArtifactService();
  const campaignReader = options.campaignReader || (requestId => require('./heavyWorkQueueService').get(requestId));
  const clock = options.clock || Date.now;
  const uuid = options.randomUUID || crypto.randomUUID;
  let control = options.control || null;

  function configureControl(value) {
    control = value;
  }

  async function task(pipelineId) {
    const query = Model.findOne({ pipelineId });
    const value = query && typeof query.lean === 'function' ? await query.lean() : await query;
    if (!value) fail('TASK_NOT_FOUND', 'Pipeline task not found', 404);
    return value;
  }

  async function activeDagTask(pipelineId, dag) {
    const value = await task(pipelineId);
    const run = value.codingAutonomy?.runs?.at(-1);
    if (!value.codingAutonomy?.authorized || run?.requestId !== dag.rootRequestId || run.finishedAt
      || run.sourceCommit !== dag.sourceCommit || value.codingAutonomy.basis !== dag.authority?.taskBasis
      || value.codingAutonomy.basis !== policy.basis(value)) {
      fail('DAG_ROOT_NOT_ACTIVE', 'The code-step DAG no longer has its exact active root authority');
    }
    return value;
  }

  async function runtimeManifestFields(value) {
    const model = value.codingCapacity?.model;
    const rootLeaseId = value.automationLease?.leaseId;
    const verificationProfile = value.codingAutonomy?.verificationProfile || value.automation?.verificationProfile;
    if (typeof value.title !== 'string' || !value.title || typeof value.spec !== 'string' || !value.spec
      || !model || !rootLeaseId || !verificationProfile) {
      fail('DAG_ROOT_RUNTIME_UNAVAILABLE', 'The active root has no complete lease, model, or verification identity');
    }
    const job = await campaignReader(value.codingAutonomy.queueRequestId);
    const now = iso(clock);
    if (!job || !['dispatching', 'running'].includes(job.state) || job.executor?.mode !== 'operator'
      || job.source?.type !== 'coding' || !job.source.ref || !job.reservation
      || now < job.reservation.start || now >= job.reservation.end
      || (job.startBefore && now >= job.startBefore)) {
      fail('CODING_AUTONOMY_QUEUE_WAIT', 'The approved coding campaign is not within its active queue window');
    }
    return { task: { title: value.title, spec: value.spec }, verificationProfile,
      model, rootLeaseId, queueEndAt: job.reservation.end };
  }

  async function persistExecutorProfile(pipelineId, dag, executor) {
    const profile = { id: executor.id, label: executor.label || executor.id, harness: executor.harness || 'unknown' };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const latest = await state.read(pipelineId);
      const existing = latest.executorProfiles?.[profile.id];
      if (existing) {
        if (fingerprint(existing) !== fingerprint(profile)) fail('EXECUTOR_PROFILE_CHANGED', 'The pinned executor profile changed');
        return latest;
      }
      const next = clone(latest);
      next.executorProfiles ||= {};
      next.executorProfiles[profile.id] = profile;
      next.revision += 1;
      const saved = Model.findOneAndUpdate({ pipelineId, 'codeStepDag.rootRequestId': dag.rootRequestId,
        'codeStepDag.revision': latest.revision }, { $set: { codeStepDag: next } },
      { new: true, writeConcern: WC });
      const updated = saved && typeof saved.lean === 'function' ? await saved.lean() : await saved;
      if (updated?.codeStepDag) return clone(updated.codeStepDag);
    }
    fail('DAG_REVISION_CONFLICT', 'The code-step DAG kept changing while its executor was pinned');
  }

  async function bindSourceCommit(pipelineId, rootRequestId, sourceCommit) {
    let value = await task(pipelineId);
    const runIndex = (value.codingAutonomy?.runs || []).length - 1;
    const run = value.codingAutonomy?.runs?.[runIndex];
    if (!value.codingAutonomy?.authorized || runIndex < 0 || run?.requestId !== rootRequestId || run.finishedAt) {
      fail('DAG_ROOT_NOT_ACTIVE', 'The exact autonomous root run is not active');
    }
    if (run.sourceCommit && run.sourceCommit !== sourceCommit) fail('DAG_SOURCE_CHANGED', 'The root source commit is already different');
    if (run.sourceCommit === sourceCommit) return value;
    if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) fail('INVALID_COMMIT', 'sourceCommit must be a full git commit sha', 400);
    const saved = Model.findOneAndUpdate({ pipelineId, 'codingAutonomy.revision': value.codingAutonomy.revision,
      [`codingAutonomy.runs.${runIndex}.requestId`]: rootRequestId,
      [`codingAutonomy.runs.${runIndex}.finishedAt`]: { $exists: false },
      [`codingAutonomy.runs.${runIndex}.sourceCommit`]: { $exists: false } },
    { $set: { [`codingAutonomy.runs.${runIndex}.sourceCommit`]: sourceCommit }, $inc: { 'codingAutonomy.revision': 1 } },
    { new: true, writeConcern: WC });
    value = saved && typeof saved.lean === 'function' ? await saved.lean() : await saved;
    if (value) return value;
    const current = await task(pipelineId);
    if (current.codingAutonomy?.runs?.[runIndex]?.sourceCommit === sourceCommit) return current;
    fail('DAG_ROOT_CHANGED', 'The autonomous root changed while its source commit was recorded');
  }

  async function ensureCoordination(pipelineId, dag) {
    const value = {
      schema: COORDINATION_SCHEMA,
      assemblyRequestId: deterministicUuid(dag.rootRequestId, 'assembly'),
      requestedAt: null,
    };
    if (dag.coordination) {
      if (fingerprint(dag.coordination) !== fingerprint(value) && dag.coordination.assemblyRequestId !== value.assemblyRequestId) {
        fail('DAG_COORDINATION_CONFLICT', 'The persisted assembly identity changed');
      }
      return dag.coordination;
    }
    const saved = Model.findOneAndUpdate({ pipelineId, 'codeStepDag.rootRequestId': dag.rootRequestId,
      'codeStepDag.coordination': { $exists: false } }, { $set: { 'codeStepDag.coordination': value } },
    { new: true, writeConcern: WC });
    const updated = saved && typeof saved.lean === 'function' ? await saved.lean() : await saved;
    if (updated?.codeStepDag?.coordination) return updated.codeStepDag.coordination;
    const current = await state.read(pipelineId);
    if (current?.coordination?.assemblyRequestId === value.assemblyRequestId) return current.coordination;
    fail('DAG_COORDINATION_CONFLICT', 'The assembly identity could not be persisted');
  }

  async function submitPlan(pipelineId, rootRequestId, input) {
    if (!input || typeof input !== 'object') fail('CODE_STEP_PLAN_INVALID', 'A plan body is required', 400);
    let value = await bindSourceCommit(pipelineId, rootRequestId, input.sourceCommit);
    policy.assertTask(value);
    if (value.codingAutonomy.basis !== policy.basis(value)) fail('DAG_ROOT_CHANGED', 'The reviewed task basis changed');
    const budget = usage(input.budget);
    const remaining = policy.remaining(value);
    for (const key of dagDomain.BUDGET_KEYS) {
      if (budget[key] > remaining[key]) fail('CODE_STEP_BUDGET_EXCEEDED', `${key} exceeds the remaining root budget`, 400);
    }
    const normalized = validatePlan(input.plan, { reviewedScope: value.automation.scope,
      reviewedLockKeys: value.automation.lockKeys });
    let dag = await state.read(pipelineId);
    let replayed = false;
    if (dag) {
      if (dag.rootRequestId !== rootRequestId || dag.sourceCommit !== input.sourceCommit
        || dag.planFingerprint !== normalized.fingerprint || fingerprint(dag.budget.limit) !== fingerprint(budget)) {
        fail('DAG_ALREADY_EXISTS', 'The task already has a different code-step DAG');
      }
      replayed = true;
    } else {
      const created = await state.create(pipelineId, { taskBasis: value.codingAutonomy.basis, rootRequestId,
        sourceCommit: input.sourceCommit, plan: input.plan, reviewedScope: value.automation.scope,
        reviewedLockKeys: value.automation.lockKeys, budget, createdAt: iso(clock) });
      dag = created.dag;
      replayed = created.replayed;
    }
    const coordination = await ensureCoordination(pipelineId, dag);
    return { graphId: rootRequestId, planFingerprint: dag.planFingerprint,
      assemblyRequestId: coordination.assemblyRequestId, codeStepGraph: await state.projection(pipelineId), replayed };
  }

  function findAttempt(dag, requestId) {
    for (const step of dag.steps) {
      const attempt = step.attempts.find(candidate => candidate.requestId === requestId);
      if (attempt) return { step, attempt };
    }
    return null;
  }

  async function manifest(pipelineId, requestId) {
    const dag = await state.read(pipelineId);
    if (!dag) return null;
    const value = await activeDagTask(pipelineId, dag);
    const runtime = await runtimeManifestFields(value);
    const coordination = await ensureCoordination(pipelineId, dag);
    const expectedAttemptCount = value.automationAttemptCount || 0;
    if (requestId === coordination.assemblyRequestId) {
      const order = dagDomain.adoptionOrder(dag);
      const adopted = new Set(dag.assembly.adoptions.map(item => item.stepId));
      const nextId = order.find(id => !adopted.has(id));
      const step = dag.steps.find(candidate => candidate.id === nextId);
      const receipt = step?.state === 'verified' ? step.verifiedReceipt : null;
      const adoptedSteps = dag.assembly.adoptions.map(item => item.stepId);
      const finalReady = !dag.assembly.completion && !receipt
        && dag.steps.every(item => item.state === 'verified') && adoptedSteps.length === order.length;
      return signedManifest({ schema: MANIFEST_SCHEMA, role: 'assembly', pipelineId, graphId: dag.rootRequestId,
        requestId, executorId: dag.authority.coordinator.id, expectedAttemptCount, stepId: null,
        rootRequestId: dag.rootRequestId, sourceCommit: dag.sourceCommit, baseCommit: currentHead(dag),
        planFingerprint: dag.planFingerprint, ...runtime,
        testTargets: [...new Set(dag.steps.flatMap(item => item.testTargets))],
        adoptionOrder: order, adoptedSteps, finalReady,
        readyAdoption: receipt ? { stepId: step.id, requestId: latestAttempt(step).requestId,
          commit: receipt.commit, parent: latestAttempt(step).baseCommit,
          allowedPaths: [...step.paths], effectiveDependsOn: [...step.effectiveDependsOn],
          artifact: publicArtifact(receipt.artifact),
          downloadPath: `/api/pipeline/coding-autonomy/tasks/${pipelineId}/runs/${latestAttempt(step).requestId}/artifacts/${receipt.artifact.id}` } : null,
        adoptionReceiptPath: `/api/pipeline/coding-autonomy/tasks/${pipelineId}/runs/${requestId}/code-step-adoption`,
        finalReceiptPath: `/api/pipeline/coding-autonomy/tasks/${pipelineId}/runs/${requestId}/code-step-assembly`,
      });
    }
    const located = findAttempt(dag, requestId);
    if (!located) return null;
    const { step, attempt } = located;
    return signedManifest({ schema: MANIFEST_SCHEMA, role: 'step', pipelineId, graphId: dag.rootRequestId,
      requestId, executorId: attempt.executorId, expectedAttemptCount, stepId: step.id,
      rootRequestId: dag.rootRequestId, sourceCommit: dag.sourceCommit, baseCommit: attempt.baseCommit,
      planFingerprint: dag.planFingerprint, budget: clone(attempt.budget), ...runtime,
      step: { id: step.id, title: step.title, objective: step.objective, paths: [...step.paths],
        testTargets: [...step.testTargets], dependsOn: [...step.effectiveDependsOn] },
      artifactUploadPath: `/api/pipeline/coding-autonomy/tasks/${pipelineId}/runs/${requestId}/artifacts/${step.id}`,
      terminalResultPath: `/api/pipeline/coding-autonomy/tasks/${pipelineId}/runs/${requestId}/code-step-result`,
    });
  }

  async function storeArtifact(pipelineId, requestId, stepId, bytes) {
    const dag = await state.read(pipelineId);
    if (dag) await activeDagTask(pipelineId, dag);
    const located = dag && findAttempt(dag, requestId);
    if (!located || located.step.id !== stepId || !['running', 'unknown'].includes(located.attempt.state)) {
      fail('CODE_STEP_REQUEST_NOT_ACTIVE', 'The exact code-step request is not active', 409);
    }
    return artifacts.store({ pipelineId, graphId: dag.rootRequestId, stepId, requestId }, bytes);
  }

  async function downloadArtifact(pipelineId, requestId, artifactId) {
    const dag = await state.read(pipelineId);
    if (dag) await activeDagTask(pipelineId, dag);
    const located = dag && findAttempt(dag, requestId);
    if (!located?.step.verifiedReceipt || located.step.verifiedReceipt.artifact.id !== artifactId) {
      fail('CODE_STEP_ARTIFACT_NOT_OWNED', 'The exact verified step does not own this artifact', 404);
    }
    const stored = await artifacts.read(artifactId);
    const owner = stored.metadata.owner;
    if (owner.pipelineId !== pipelineId || owner.graphId !== dag.rootRequestId
      || owner.stepId !== located.step.id || owner.requestId !== requestId) {
      fail('CODE_STEP_ARTIFACT_NOT_OWNED', 'Artifact ownership does not match the verified step', 409);
    }
    return stored;
  }

  async function verifyReceiptArtifact(pipelineId, dag, located, receipt) {
    if (!receipt?.artifact?.id) fail('CODE_STEP_ARTIFACT_REQUIRED', 'A verified step requires its stored Git bundle', 400);
    const stored = await artifacts.read(receipt.artifact.id);
    const owner = stored.metadata.owner;
    if (owner.pipelineId !== pipelineId || owner.graphId !== dag.rootRequestId
      || owner.stepId !== located.step.id || owner.requestId !== located.attempt.requestId
      || fingerprint(publicArtifact(stored.metadata)) !== fingerprint(receipt.artifact)) {
      fail('CODE_STEP_ARTIFACT_MISMATCH', 'The verified receipt does not match its immutable Git bundle', 409);
    }
  }

  async function settleStep(pipelineId, requestId, input) {
    const dag = await state.read(pipelineId);
    if (dag) await activeDagTask(pipelineId, dag);
    const located = dag && findAttempt(dag, requestId);
    if (!located) fail('CODE_STEP_ATTEMPT_NOT_FOUND', 'Code-step attempt not found', 404);
    if (!['verified', 'failed'].includes(input?.outcome)) fail('CODE_STEP_RESULT_INVALID', 'Outcome must be verified or failed', 400);
    if (input.outcome === 'verified') await verifyReceiptArtifact(pipelineId, dag, located, input.receipt);
    const transition = located.attempt.state === 'unknown' ? 'reconcileUnknown' : 'settleAttempt';
    return state[transition](pipelineId, { expectedRevision: dag.revision, requestId,
      outcome: input.outcome, actualUsage: usage(input.actualUsage), receipt: input.receipt });
  }

  async function assertAssemblyIdentity(pipelineId, requestId) {
    const dag = await state.read(pipelineId);
    if (!dag) fail('DAG_NOT_FOUND', 'The task has no code-step DAG', 404);
    await activeDagTask(pipelineId, dag);
    const coordination = await ensureCoordination(pipelineId, dag);
    if (requestId !== coordination.assemblyRequestId) fail('ASSEMBLY_REQUEST_MISMATCH', 'The exact assembly request is required', 409);
    return dag;
  }

  async function recordAdoption(pipelineId, requestId, input) {
    const dag = await assertAssemblyIdentity(pipelineId, requestId);
    return state.recordAdoption(pipelineId, { ...input, expectedRevision: dag.revision });
  }

  async function completeAssembly(pipelineId, requestId, input) {
    const dag = await assertAssemblyIdentity(pipelineId, requestId);
    return state.completeAssembly(pipelineId, { ...input, expectedRevision: dag.revision });
  }

  async function observeAttempt(pipelineId, dag, step) {
    const attempt = latestAttempt(step);
    let host;
    try { host = await control.status({ requestId: attempt.requestId, executorId: attempt.executorId }); }
    catch (error) {
      if (attempt.state === 'running' && error?.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN') {
        return state.settleAttempt(pipelineId, { expectedRevision: dag.revision, requestId: attempt.requestId,
          outcome: 'unknown', actualUsage: clone(ZERO_USAGE), receipt: { reason: 'executor_status_unavailable', observedAt: iso(clock) } });
      }
      return null;
    }
    const phase = host?.run?.phase;
    const terminal = resultForHost(host);
    if (terminal && ['verified', 'failed'].includes(terminal.outcome)) return settleStep(pipelineId, attempt.requestId, terminal);
    if (attempt.state === 'unknown' && phase === 'not_received') {
      return state.reconcileUnknown(pipelineId, { expectedRevision: dag.revision, requestId: attempt.requestId,
        outcome: 'failed', actualUsage: clone(ZERO_USAGE), receipt: { code: 'launch_not_received', finishedAt: iso(clock) } });
    }
    if (attempt.state === 'running' && ['unknown', 'uncertain'].includes(phase)) {
      return state.settleAttempt(pipelineId, { expectedRevision: dag.revision, requestId: attempt.requestId,
        outcome: 'unknown', actualUsage: clone(ZERO_USAGE), receipt: { reason: 'executor_outcome_unknown', observedAt: iso(clock) } });
    }
    if (attempt.state === 'running' && phase === 'not_received') {
      const workerManifest = await manifest(pipelineId, attempt.requestId);
      try {
        await control.launch({ pipelineId, requestId: attempt.requestId, expectedAttemptCount: workerManifest.expectedAttemptCount,
          confirm: true, distributedRole: 'step', executorId: attempt.executorId, graphId: dag.rootRequestId,
          stepId: step.id, manifestFingerprint: workerManifest.manifestFingerprint });
      } catch (error) {
        if (error?.code !== 'CODING_DISPATCH_OUTCOME_UNKNOWN') {
          return state.settleAttempt(pipelineId, { expectedRevision: dag.revision, requestId: attempt.requestId,
            outcome: 'failed', actualUsage: clone(ZERO_USAGE), receipt: { code: error?.code || 'step_launch_failed', finishedAt: iso(clock) } });
        }
      }
    }
    return null;
  }

  async function markAssemblyRequested(pipelineId, dag) {
    if (dag.coordination?.requestedAt) return dag.coordination;
    const order = dagDomain.adoptionOrder(dag);
    const nextId = order[dag.assembly.adoptions.length];
    if (!nextId || dag.steps.find(step => step.id === nextId)?.state !== 'verified') return dag.coordination;
    const requestedAt = iso(clock);
    const saved = Model.findOneAndUpdate({ pipelineId, 'codeStepDag.rootRequestId': dag.rootRequestId,
      'codeStepDag.coordination.assemblyRequestId': dag.coordination.assemblyRequestId,
      'codeStepDag.coordination.requestedAt': null },
    { $set: { 'codeStepDag.coordination.requestedAt': requestedAt } }, { new: true, writeConcern: WC });
    const updated = saved && typeof saved.lean === 'function' ? await saved.lean() : await saved;
    return updated?.codeStepDag?.coordination || { ...dag.coordination, requestedAt };
  }

  async function tick(pipelineId) {
    if (!control) return null;
    let dag = await state.read(pipelineId);
    if (!dag || dag.state === 'verified') return dag;
    await activeDagTask(pipelineId, dag);
    await ensureCoordination(pipelineId, dag);
    dag = await state.read(pipelineId);

    for (const step of dag.steps.filter(candidate => ['running', 'unknown'].includes(candidate.state))) {
      const changed = await observeAttempt(pipelineId, dag, step);
      if (changed) dag = changed.dag;
    }
    await markAssemblyRequested(pipelineId, dag);
    dag = await state.read(pipelineId);

    let fleet;
    try { fleet = await control.status({}); }
    catch { return dag; }
    const executors = availableExecutors(fleet, dag.authority.coordinator.id);
    const assignments = dagDomain.readySet(dag, executors.map(item => item.id));
    for (const assignment of assignments) {
      dag = await persistExecutorProfile(pipelineId, dag,
        executors.find(executor => executor.id === assignment.executorId));
      const requestId = uuid();
      const started = await state.startAttempt(pipelineId, { expectedRevision: dag.revision,
        stepId: assignment.stepId, executorId: assignment.executorId, requestId,
        baseCommit: currentHead(dag), budget: attemptBudget(dag), startedAt: iso(clock) });
      dag = started.dag;
      await observeAttempt(pipelineId, dag, dag.steps.find(step => step.id === assignment.stepId));
      dag = await state.read(pipelineId);
    }
    return dag;
  }

  async function stopChildren(pipelineId) {
    if (!control) return [];
    const dag = await state.read(pipelineId);
    if (!dag) return [];
    return Promise.all(dag.steps.flatMap(step => {
      const attempt = latestAttempt(step);
      if (!attempt || !['running', 'unknown'].includes(attempt.state)) return [];
      return [control.stop({ pipelineId, requestId: attempt.requestId, executorId: attempt.executorId, confirm: true })
        .then(() => ({ requestId: attempt.requestId, accepted: true }))
        .catch(error => ({ requestId: attempt.requestId, accepted: false, code: error?.code || 'CODING_DISPATCH_OUTCOME_UNKNOWN' }))];
    }));
  }

  return Object.freeze({ configureControl, submitPlan, manifest, storeArtifact, downloadArtifact,
    settleStep, recordAdoption, completeAssembly, tick, stopChildren });
}

const shared = createPipelineCodeDagCoordinator();
module.exports = { MANIFEST_SCHEMA, COORDINATION_SCHEMA, PipelineCodeDagCoordinatorError,
  deterministicUuid, createPipelineCodeDagCoordinator, ...shared };
