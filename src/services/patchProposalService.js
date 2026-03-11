const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const logger = require('../../config/logger');
const AutomationTask = require('../../models/AutomationTask');
const AutomationRun = require('../../models/AutomationRun');
const PatchProposal = require('../../models/PatchProposal');
const { routeRequest } = require('./modelRouter');
const { handleChatRequest } = require('./chatService');

const DEFAULT_REPO_PATH = process.env.REPO_WATCHER_PATH || process.cwd();
const SPECIALX_SYSTEM_USER = process.env.SPECIALX_SYSTEM_USER || 'specialx-system';
const PATCH_PROPOSAL_TTL_HOURS = Number.parseInt(process.env.PATCH_PROPOSAL_TTL_HOURS || '72', 10);
const PATCH_PROPOSAL_DEFAULT_LIMIT = Number.parseInt(process.env.PATCH_PROPOSAL_MAX_ITEMS || '5', 10);

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeRepoPath(repoPath) {
  return path.resolve(repoPath || DEFAULT_REPO_PATH);
}

function normalizeTargetFile(targetFile) {
  return String(targetFile || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isDocsOnlyPath(targetFile) {
  const normalized = normalizeTargetFile(targetFile).toLowerCase();
  return normalized.startsWith('docs/') || normalized.endsWith('.md');
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function stripCodeFence(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : raw;
}

function normalizeContentForCompare(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function getRunnerService() {
  const { getAutomationRunnerService } = require('./automationRunnerService');
  if (typeof getAutomationRunnerService !== 'function') {
    throw new Error('Automation runner service is unavailable');
  }
  return getAutomationRunnerService();
}

function buildFindingKey(finding) {
  if (finding?.key) {
    return String(finding.key);
  }

  return crypto
    .createHash('sha1')
    .update(JSON.stringify({
      type: finding?.type || 'doc_staleness',
      path: finding?.path || finding?.metadata?.path || null,
      title: finding?.title || null,
      evidence: finding?.evidence || null,
      metadata: finding?.metadata || null
    }))
    .digest('hex');
}

function normalizeFinding(finding) {
  return {
    _id: finding?._id || null,
    key: buildFindingKey(finding),
    type: finding?.type || 'doc_staleness',
    title: finding?.title || finding?.path || 'Documentation drift finding',
    path: finding?.path || finding?.filePath || finding?.metadata?.path || null,
    evidence: typeof finding?.evidence === 'string'
      ? finding.evidence
      : finding?.description || JSON.stringify(finding?.evidence || finding?.metadata || {}),
    metadata: finding?.metadata || {}
  };
}

function isSubPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTargetFilePath(repoPath, targetFile) {
  const normalizedTarget = normalizeTargetFile(targetFile);
  if (!normalizedTarget) {
    throw createHttpError('Finding is missing a target file path', 400);
  }

  const resolvedRepoPath = normalizeRepoPath(repoPath);
  const resolvedTargetPath = path.resolve(resolvedRepoPath, normalizedTarget);
  if (!isSubPath(resolvedRepoPath, resolvedTargetPath)) {
    throw createHttpError(`Target file escapes repo root: ${normalizedTarget}`, 400);
  }

  return {
    repoPath: resolvedRepoPath,
    targetFile: path.relative(resolvedRepoPath, resolvedTargetPath).replace(/\\/g, '/'),
    targetPath: resolvedTargetPath
  };
}

async function readFileIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function buildPatchPrompt({ repoPath, targetFile, finding, originalContent }) {
  return [
    'You are generating a documentation-only patch proposal for AgentX.',
    'Return only the full updated file contents. No explanations. No code fences.',
    'Preserve unrelated content. Do not invent code changes or modify non-documentation behavior.',
    `Repository root: ${repoPath}`,
    `Target file: ${targetFile}`,
    `Finding type: ${finding.type}`,
    `Finding title: ${finding.title}`,
    `Finding evidence: ${finding.evidence || 'n/a'}`,
    `Finding metadata: ${JSON.stringify(finding.metadata || {})}`,
    'Current file contents:',
    '<<<CURRENT_FILE',
    originalContent || '',
    'CURRENT_FILE'
  ].join('\n\n');
}

async function generateProposedContent({ task, specialX, repoPath, targetFile, finding, originalContent }) {
  const prompt = buildPatchPrompt({ repoPath, targetFile, finding, originalContent });
  const routing = await routeRequest(prompt, {
    autoRoute: true,
    taskType: specialX?.modelPolicy?.preferredTaskType || 'analysis'
  });

  const chat = await handleChatRequest({
    userId: SPECIALX_SYSTEM_USER,
    model: routing.model,
    target: routing.target,
    message: prompt,
    persona: specialX?.promptProfile?.persona || 'default_chat',
    options: { temperature: 0.1, num_predict: 1800 },
    autoRoute: false,
    useRag: false,
    workspaceId: task.workspaceId || null
  });

  return {
    content: stripCodeFence(chat.response || ''),
    routing
  };
}

async function getDocsDriftSource(task, repoPath) {
  if (task.input?.docsDriftTaskId) {
    const sourceTask = await AutomationTask.findById(task.input.docsDriftTaskId)
      .select('_id input resultRunId')
      .lean();

    let run = sourceTask?.resultRunId
      ? await AutomationRun.findById(sourceTask.resultRunId)
        .select('output artifacts')
        .lean()
      : null;

    if (!run && sourceTask?._id) {
      run = await AutomationRun.findOne({
        taskId: sourceTask._id,
        status: 'completed'
      })
        .sort({ finishedAt: -1, createdAt: -1 })
        .select('output artifacts')
        .lean();
    }

    if (!sourceTask || !run) {
      throw createHttpError('Referenced docs_drift_check task has no completed run', 400);
    }

    return { task: sourceTask, run };
  }

  const query = {
    type: 'docs_drift_check',
    status: 'completed'
  };
  if (task.workspaceId) {
    query.workspaceId = task.workspaceId;
  } else {
    query.workspaceId = null;
  }

  const candidates = await AutomationTask.find(query)
    .sort({ completedAt: -1, createdAt: -1 })
    .limit(25)
    .select('_id input resultRunId')
    .lean();

  const matched = candidates.find((candidate) => normalizeRepoPath(candidate.input?.repoPath) === repoPath);
  if (!matched?._id) {
    throw createHttpError(`No completed docs_drift_check task found for ${repoPath}`, 404);
  }

  let run = matched.resultRunId
    ? await AutomationRun.findById(matched.resultRunId)
      .select('output artifacts')
      .lean()
    : null;

  if (!run) {
    run = await AutomationRun.findOne({
      taskId: matched._id,
      status: 'completed'
    })
      .sort({ finishedAt: -1, createdAt: -1 })
      .select('output artifacts')
      .lean();
  }

  if (!run) {
    throw createHttpError('Latest docs_drift_check run not found', 404);
  }

  return { task: matched, run };
}

function extractDocsDriftFindings(run, taskInput) {
  if (Array.isArray(taskInput?.findings) && taskInput.findings.length > 0) {
    return taskInput.findings.map(normalizeFinding);
  }

  if (Array.isArray(run?.output?.newFindings) && run.output.newFindings.length > 0) {
    return run.output.newFindings.map(normalizeFinding);
  }

  const snapshotArtifact = Array.isArray(run?.artifacts)
    ? run.artifacts.find((artifact) => artifact.name === 'docs_drift_snapshot')
    : null;
  const snapshotFindings = Array.isArray(snapshotArtifact?.content?.findings)
    ? snapshotArtifact.content.findings
    : [];

  return snapshotFindings.map(normalizeFinding);
}

async function runPatchProposalTask(task, specialX) {
  const blastRadius = task.input?.blastRadius || 'docs_only';
  if (blastRadius !== 'docs_only') {
    throw createHttpError('patch_proposal supports docs_only only in v1', 400);
  }

  const repoPath = normalizeRepoPath(task.input?.repoPath);
  const proposalLimit = clampInt(task.input?.maxProposals, PATCH_PROPOSAL_DEFAULT_LIMIT, 1, 20);
  const expiresAt = new Date(Date.now() + (PATCH_PROPOSAL_TTL_HOURS * 60 * 60 * 1000));
  const docsDriftSource = await getDocsDriftSource(task, repoPath);
  const findings = extractDocsDriftFindings(docsDriftSource.run, task.input);

  const eligible = findings
    .filter((finding) => Boolean(finding.path))
    .filter((finding) => isDocsOnlyPath(finding.path))
    .slice(0, proposalLimit);

  if (!eligible.length) {
    return {
      summary: 'Patch proposal run found no eligible docs-only findings',
      output: {
        repoPath,
        blastRadius,
        proposalIds: [],
        proposalsCreated: 0,
        skipped: findings.length
      },
      artifacts: [{
        name: 'patch_proposals',
        kind: 'json',
        content: {
          repoPath,
          blastRadius,
          findingsSeen: findings.length,
          proposals: []
        }
      }],
      metrics: {
        localCalls: 0,
        cloudCalls: 0
      },
      execution: {
        routed: false
      }
    };
  }

  const created = [];
  const skipped = [];
  let localCalls = 0;
  let cloudCalls = 0;

  for (const finding of eligible) {
    const resolvedTarget = resolveTargetFilePath(repoPath, finding.path);
    const originalContent = await readFileIfPresent(resolvedTarget.targetPath);
    const generated = await generateProposedContent({
      task,
      specialX,
      repoPath,
      targetFile: resolvedTarget.targetFile,
      finding,
      originalContent
    });

    if (generated.routing?.target && String(generated.routing.target).toLowerCase().includes('cloud')) {
      cloudCalls += 1;
    } else {
      localCalls += 1;
    }

    if (!generated.content.trim()) {
      skipped.push({ targetFile: resolvedTarget.targetFile, reason: 'empty_response' });
      continue;
    }

    if (normalizeContentForCompare(generated.content) === normalizeContentForCompare(originalContent)) {
      skipped.push({ targetFile: resolvedTarget.targetFile, reason: 'no_material_change' });
      continue;
    }

    const payload = {
      workspaceId: task.workspaceId || null,
      specialXId: task.specialXId || specialX?._id || null,
      sourceTaskId: task._id,
      docsDriftTaskId: docsDriftSource.task?._id || null,
      findingId: mongoose.Types.ObjectId.isValid(finding._id) ? finding._id : null,
      findingKey: finding.key,
      findingSnapshot: finding,
      repoPath,
      targetFile: resolvedTarget.targetFile,
      originalContent,
      proposedContent: generated.content,
      diffSummary: `Update ${resolvedTarget.targetFile} to address ${finding.title}`,
      blastRadius,
      status: 'pending',
      expiresAt
    };

    const proposal = await PatchProposal.findOneAndUpdate(
      {
        sourceTaskId: task._id,
        targetFile: resolvedTarget.targetFile,
        findingKey: finding.key
      },
      { $set: payload },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    created.push({
      _id: proposal._id,
      targetFile: proposal.targetFile,
      diffSummary: proposal.diffSummary,
      status: proposal.status,
      expiresAt: proposal.expiresAt
    });
  }

  return {
    summary: `Patch proposals created ${created.length} • skipped ${skipped.length}`,
    output: {
      repoPath,
      blastRadius,
      docsDriftTaskId: docsDriftSource.task?._id || null,
      proposalIds: created.map((proposal) => proposal._id),
      proposalsCreated: created.length,
      skipped
    },
    artifacts: [{
      name: 'patch_proposals',
      kind: 'json',
      content: {
        repoPath,
        blastRadius,
        findingsSeen: findings.length,
        proposals: created,
        skipped
      }
    }],
    metrics: {
      localCalls,
      cloudCalls
    },
    execution: {
      routed: created.length > 0
    }
  };
}

async function approvePatchProposal(proposalId, options = {}) {
  const {
    actorSource = 'api',
    actorUserId = null,
    workspaceId = null
  } = options;

  const query = { _id: proposalId };
  if (workspaceId) {
    query.workspaceId = workspaceId;
  }

  const proposal = await PatchProposal.findOne(query);
  if (!proposal) {
    throw createHttpError('Patch proposal not found', 404);
  }

  const now = new Date();
  if (proposal.status !== 'pending') {
    throw createHttpError(`Patch proposal is already ${proposal.status}`, 409);
  }

  if (proposal.expiresAt && proposal.expiresAt <= now) {
    proposal.status = 'expired';
    await proposal.save();
    throw createHttpError('Patch proposal has expired', 409);
  }

  const service = getRunnerService();
  const applyTask = await service.enqueueTask({
    type: 'patch_apply',
    source: actorSource === 'telegram' ? 'webhook' : 'manual',
    priority: 4,
    input: {
      proposalId: String(proposal._id),
      repoPath: proposal.repoPath
    },
    runAt: new Date(Date.now() + 2000),
    specialXId: proposal.specialXId || null,
    idempotencyKey: `patch_apply:${proposal._id}`
  }, {
    workspaceId: proposal.workspaceId || null,
    userId: actorUserId,
    authSource: actorSource
  });

  proposal.status = 'approved';
  proposal.approvedBy = actorSource;
  proposal.approvedByUserId = actorUserId;
  proposal.approvedAt = now;
  proposal.applyTaskId = applyTask._id;
  await proposal.save();

  return {
    proposal,
    applyTask
  };
}

async function rejectPatchProposal(proposalId, options = {}) {
  const {
    actorSource = 'api',
    actorUserId = null,
    workspaceId = null
  } = options;

  const query = { _id: proposalId };
  if (workspaceId) {
    query.workspaceId = workspaceId;
  }

  const proposal = await PatchProposal.findOne(query);
  if (!proposal) {
    throw createHttpError('Patch proposal not found', 404);
  }

  const now = new Date();
  if (proposal.status !== 'pending') {
    throw createHttpError(`Patch proposal is already ${proposal.status}`, 409);
  }

  if (proposal.expiresAt && proposal.expiresAt <= now) {
    proposal.status = 'expired';
    await proposal.save();
    throw createHttpError('Patch proposal has expired', 409);
  }

  proposal.status = 'rejected';
  proposal.rejectedBy = actorSource;
  proposal.rejectedByUserId = actorUserId;
  proposal.rejectedAt = now;
  await proposal.save();

  return proposal;
}

async function applyPatchProposalTask(task) {
  const proposalId = task.input?.proposalId;
  if (!proposalId) {
    throw createHttpError('patch_apply requires input.proposalId', 400);
  }

  const proposal = await PatchProposal.findById(proposalId);
  if (!proposal) {
    throw createHttpError('Patch proposal not found', 404);
  }

  if (proposal.status !== 'approved') {
    throw createHttpError(`Patch proposal must be approved before apply (current: ${proposal.status})`, 409);
  }

  const now = new Date();
  if (proposal.expiresAt && proposal.expiresAt <= now) {
    proposal.status = 'expired';
    await proposal.save();
    throw createHttpError('Patch proposal expired before apply', 409);
  }

  if (proposal.blastRadius !== 'docs_only' || !isDocsOnlyPath(proposal.targetFile)) {
    throw createHttpError('patch_apply only supports docs-only proposals in v1', 400);
  }

  const resolvedTarget = resolveTargetFilePath(proposal.repoPath, proposal.targetFile);
  const currentContent = await readFileIfPresent(resolvedTarget.targetPath);
  if (currentContent !== proposal.originalContent) {
    throw createHttpError('Target file changed since proposal generation; refusing to apply stale patch', 409);
  }

  await fs.mkdir(path.dirname(resolvedTarget.targetPath), { recursive: true });
  await fs.writeFile(resolvedTarget.targetPath, proposal.proposedContent, 'utf8');

  proposal.status = 'applied';
  proposal.appliedAt = now;
  await proposal.save();

  return {
    summary: `Applied patch proposal to ${proposal.targetFile}`,
    output: {
      proposalId: proposal._id,
      targetFile: proposal.targetFile,
      blastRadius: proposal.blastRadius
    },
    artifacts: [{
      name: 'patch_apply',
      kind: 'json',
      content: {
        proposalId: proposal._id,
        targetFile: proposal.targetFile,
        appliedAt: now.toISOString()
      }
    }],
    metrics: {
      localCalls: 0,
      cloudCalls: 0
    },
    execution: {
      routed: false
    }
  };
}

async function expirePendingPatchProposalsTask(task) {
  const now = new Date();
  const query = {
    status: 'pending',
    expiresAt: { $lt: now }
  };
  if (task.workspaceId) {
    query.workspaceId = task.workspaceId;
  }

  const result = await PatchProposal.updateMany(query, {
    $set: { status: 'expired' }
  });

  const expiredCount = result.modifiedCount || 0;
  logger.info('Patch proposal expiry sweep completed', {
    workspaceId: task.workspaceId ? String(task.workspaceId) : null,
    expiredCount
  });

  return {
    summary: `Proposal expiry sweep expired ${expiredCount} proposal(s)`,
    output: {
      expiredCount
    },
    artifacts: [{
      name: 'proposal_expiry_sweep',
      kind: 'json',
      content: {
        expiredCount,
        sweptAt: now.toISOString()
      }
    }],
    metrics: {
      localCalls: 0,
      cloudCalls: 0
    },
    execution: {
      routed: false
    }
  };
}

module.exports = {
  applyPatchProposalTask,
  approvePatchProposal,
  expirePendingPatchProposalsTask,
  isDocsOnlyPath,
  normalizeRepoPath,
  rejectPatchProposal,
  resolveTargetFilePath,
  runPatchProposalTask
};
