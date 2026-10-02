'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildSshArgs } = require('./openclaw/agentInventory');

const execFileAsync = promisify(execFile);
const PIPELINE_ID_PATTERN = /^\d{4}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_REPOSITORY = 'WindriderQc/AgentX';
const PRODUCT_REPOSITORY = 'WindriderQc/AgentX-Ecosystem';
const DEFAULT_REMOTE_ROOT = '/srv/agentx/AgentX';
const DEFAULT_PROMOTION_RECEIPT_ROOT = '/home/agentx/.local/state/agentx/coding-promotions';
const DEFAULT_TIMEOUT_MS = 15_000;
const REQUIRED_PR_CI_JOBS = Object.freeze(['tests (core)', 'tests (benchmark)', 'tests (rag)', 'tests (data)', 'compose']);
const PROMOTION_MARKER = 'agentx.coding-promotion/v1';
const PRE_REVIEW_MARKER = '<!-- agentx.coding-team-pre-review/v1 -->';
const TRUSTED_GITHUB_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const STAGE_RANK = Object.freeze({
  pr_ready_to_merge: 0,
  review_ready: 1,
  ci_failed: 2,
  receipt_mismatch: 3,
  merge_blocked: 4,
  correction_requested: 5,
  deployment_failed: 6,
  deployment_rolled_back: 7,
  deployment_verification_failed: 8,
  delivery_unavailable: 9,
  accepted_waiting_pr: 10,
  product_review: 10,
  ci_running: 11,
  ci_pending: 12,
  deployment_pending: 13,
  deployment_in_progress: 14,
  deployed: 15
});

class CodingDeliveryControlError extends Error {
  constructor(message, { code = 'CODING_DELIVERY_ERROR', statusCode = 409, data = null } = {}) {
    super(message);
    this.name = 'CodingDeliveryControlError';
    this.code = code;
    this.statusCode = statusCode;
    this.data = data;
  }
}

function exactPipelineId(value) {
  const pipelineId = String(value || '').trim();
  if (!PIPELINE_ID_PATTERN.test(pipelineId)) {
    throw new CodingDeliveryControlError('pipelineId must be an exact four-digit task id.', {
      code: 'CODING_DELIVERY_INVALID_TASK', statusCode: 400
    });
  }
  return pipelineId;
}

function exactSha(value, field = 'SHA') {
  const sha = String(value || '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new CodingDeliveryControlError(`${field} must be an exact lowercase 40-character commit SHA.`, {
      code: 'CODING_DELIVERY_INVALID_SHA', statusCode: 400
    });
  }
  return sha;
}

function exactPullRequestNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CodingDeliveryControlError('pullRequestNumber must be a positive integer.', {
      code: 'CODING_DELIVERY_INVALID_PULL_REQUEST', statusCode: 400
    });
  }
  return number;
}

function exactRepository(value) {
  const repository = String(value || DEFAULT_REPOSITORY).trim();
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new CodingDeliveryControlError('The coding delivery repository is invalid.', {
      code: 'CODING_DELIVERY_CONFIGURATION_INVALID', statusCode: 503
    });
  }
  return repository;
}

function exactRemoteRoot(value) {
  const root = String(value || DEFAULT_REMOTE_ROOT).trim().replace(/\/$/, '');
  if (!/^\/[A-Za-z0-9._/-]+$/.test(root) || root.includes('/../') || root.endsWith('/..')) {
    throw new CodingDeliveryControlError('The coding delivery production root is invalid.', {
      code: 'CODING_DELIVERY_CONFIGURATION_INVALID', statusCode: 503
    });
  }
  return root;
}

function mergeConfirmation(pullRequestNumber, headSha) {
  return `MERGE PR #${exactPullRequestNumber(pullRequestNumber)} @ ${exactSha(headSha, 'head SHA')}`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function trustedSupersession(comments) {
  return safeArray(comments).slice().reverse().find((comment) => (
    TRUSTED_GITHUB_ASSOCIATIONS.has(String(comment?.author_association || '').toUpperCase())
    && /^\s*Superseded by\b/i.test(String(comment?.body || ''))
  )) || null;
}

function latestAttempt(task) {
  return safeArray(task?.automationAttempts).slice().reverse().find((attempt) => attempt?.attempt) || null;
}

function acceptedAttempt(task) {
  return safeArray(task?.automationAttempts).slice().reverse().find((attempt) => (
    attempt?.reviewOutcome === 'accepted'
    && attempt?.evidence?.verification?.status === 'passed'
    && safeArray(attempt?.evidence?.failureCodes).length === 0
    && /^[0-9a-f]{64}$/.test(String(attempt?.evidence?.workerReceiptFingerprint || ''))
  )) || null;
}

function promotionFromTask(task, repository = DEFAULT_REPOSITORY) {
  const expectedRepository = exactRepository(repository).toLowerCase();
  for (const entry of safeArray(task?.feedback).slice().reverse()) {
    const text = String(entry?.text || '');
    const marker = text.match(/agentx\.coding-promotion\/v1 task=(\d{4}) attempt=(\d+)/);
    const pull = text.match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/);
    if (!marker || !pull || marker[1] !== String(task?.pipelineId || '')) continue;
    if (pull[1].toLowerCase() !== expectedRepository) continue;
    return {
      pipelineId: marker[1],
      attempt: Number(marker[2]),
      pullRequestNumber: Number(pull[2]),
      url: `https://github.com/${repository}/pull/${Number(pull[2])}`,
      recordedAt: entry?.at || null
    };
  }
  return null;
}

function changeSummary(task, attempt) {
  const changes = attempt?.evidence?.changes || {};
  const files = Number.isFinite(Number(changes.filesChanged)) ? Number(changes.filesChanged) : null;
  const bytes = Number.isFinite(Number(changes.bytesChanged)) ? Number(changes.bytesChanged) : null;
  const scope = safeArray(task?.automation?.scope).filter((value) => typeof value === 'string').slice(0, 4);
  const measured = files == null || bytes == null
    ? 'Change size unavailable'
    : `${files} file${files === 1 ? '' : 's'} · ${bytes.toLocaleString()} B`;
  return scope.length ? `${measured} · ${scope.join(', ')}` : measured;
}

function testSummary(attempt) {
  const verification = attempt?.evidence?.verification || {};
  const status = String(verification.status || 'unknown');
  const passed = verification.testsPassed;
  const failed = verification.testsFailed;
  if (passed == null && failed == null) return `Independent verification: ${status}; exact totals unavailable`;
  return `Independent verification: ${status} · ${passed ?? '?'} passed · ${failed ?? '?'} failed`;
}

function riskSummary(task, attempt) {
  const risk = String(task?.risk || 'unknown');
  const failures = safeArray(attempt?.evidence?.failureCodes);
  return failures.length
    ? `${risk} declared risk · ${failures.length} guarded failure code${failures.length === 1 ? '' : 's'}`
    : `${risk} declared risk · no guarded failure code in the selected receipt`;
}

function baseItem(task, attempt, stage, overrides = {}) {
  const humanActionRequired = overrides.humanActionRequired === true;
  const recommendation = overrides.recommendation === 'CORRECT' ? 'CORRECT' : 'MERGE';
  return {
    pipelineId: exactPipelineId(task.pipelineId),
    title: String(task.title || 'Untitled task'),
    stage,
    rank: STAGE_RANK[stage] ?? 99,
    humanActionRequired,
    updatedAt: task.updatedAt || task.createdAt || null,
    attempt: attempt?.attempt || null,
    summary: {
      change: changeSummary(task, attempt),
      tests: testSummary(attempt),
      risks: riskSummary(task, attempt),
      recommendation,
      nextAction: String(overrides.nextAction || '')
    },
    receipt: attempt?.evidence?.workerReceiptFingerprint ? { fingerprint: String(attempt.evidence.workerReceiptFingerprint), verification: String(attempt.evidence?.verification?.status || 'unknown') } : null,
    pullRequest: overrides.pullRequest || null,
    ci: overrides.ci || null,
    deployment: overrides.deployment || null,
    // PR <-> sealed receipt binding outlives the merge; null means never proven (e.g. Product PRs).
    receiptBinding: overrides.gate ? { exactPullRequest: overrides.gate.exactPullRequest === true, exactHead: overrides.gate.exactHead === true, sealedReceipt: overrides.gate.sealedReceipt === true } : null,
    // Merge eligibility is no longer actionable once GitHub confirms the merge.
    gate: overrides.pullRequest?.state === 'merged' ? null : overrides.gate || null
  };
}

function localItem(task, repository) {
  const attempt = latestAttempt(task);
  if (!attempt) return null;
  const reviewOutcome = String(attempt.reviewOutcome || 'pending');
  if (task.status === 'review' && reviewOutcome === 'pending') {
    const clean = attempt?.evidence?.verification?.status === 'passed'
      && safeArray(attempt?.evidence?.failureCodes).length === 0;
    return baseItem(task, attempt, 'review_ready', {
      humanActionRequired: true,
      recommendation: clean ? 'MERGE' : 'CORRECT',
      nextAction: clean
        ? 'Open the dossier and explicitly accept the exact attempt, or request a correction.'
        : 'Open the dossier and request a correction against the recorded failure evidence.'
    });
  }
  if (['requeued', 'rejected'].includes(reviewOutcome) && ['queued', 'blocked'].includes(task.status)) {
    return baseItem(task, attempt, 'correction_requested', {
      recommendation: 'CORRECT',
      nextAction: task.status === 'queued'
        ? 'Wait for the corrected bounded attempt; no merge is eligible.'
        : 'Resolve the recorded blocker before allowing another bounded attempt.'
    });
  }
  const accepted = acceptedAttempt(task);
  if (!accepted || task.status !== 'done') return null;
  const promotion = promotionFromTask(task, repository);
  if (!promotion) {
    return baseItem(task, accepted, 'accepted_waiting_pr', {
      nextAction: 'Wait for the existing guarded publisher to create the deterministic PR and dispatch exact-branch CI.'
    });
  }
  return { task, attempt: accepted, promotion };
}

async function productDelivery(task, github, production) {
  const attempt = acceptedAttempt(task);
  const promotion = promotionFromTask(task, PRODUCT_REPOSITORY);
  if (!promotion) return baseItem(task, attempt, 'product_review', {
    humanActionRequired: true,
    nextAction: 'Publish the accepted patch in AgentX-Ecosystem for review. The AIOps-only publisher does not publish Product changes.'
  });
  if (promotion.attempt !== attempt.attempt) return baseItem(task, attempt, 'receipt_mismatch', {
    humanActionRequired: true, recommendation: 'CORRECT', nextAction: 'The Product PR link belongs to another attempt. Review the current result before publishing.'
  });
  if (github.configured !== true) throw githubError('Product delivery observation is unavailable.');
  const pr = await github.getPull(promotion.pullRequestNumber);
  if (Number(pr.number) !== promotion.pullRequestNumber) throw githubError('Product PR identity changed.');
  const pullRequest = publicPullRequest(pr);
  if (pr.merged !== true) return baseItem(task, attempt, pr.state === 'closed' ? 'merge_blocked' : 'product_review', {
    pullRequest, humanActionRequired: true,
    recommendation: pr.state === 'closed' ? 'CORRECT' : 'MERGE',
    nextAction: pr.state === 'closed' ? 'The Product PR closed without merge. Request a correction from this ticket.'
      : 'Review the Product PR and its CI in AgentX-Ecosystem, then merge through that repository.'
  });
  const present = await productionContainsMerge(github, {
    available: production?.available, checkoutSha: production?.productRevision
  }, exactSha(pr.merge_commit_sha));
  const deployed = present && production?.healthy === true && production?.clean === true;
  return baseItem(task, attempt, deployed ? 'deployed' : 'deployment_pending', {
    pullRequest, humanActionRequired: !deployed,
    deployment: publicDeployment(null, production, deployed ? 'succeeded' : 'pending'),
    nextAction: deployed ? 'The healthy production Product image contains this reviewed merge.'
      : 'Publish the Product images, update the AIOps digest set, and verify the running Product revision.'
  });
}

function githubError(message, statusCode = 503) {
  return new CodingDeliveryControlError(message, {
    code: 'CODING_DELIVERY_GITHUB_UNAVAILABLE', statusCode
  });
}

class GitHubRepositoryClient {
  constructor(options = {}) {
    this.repository = exactRepository(options.repository || process.env.CODING_DELIVERY_GITHUB_REPOSITORY);
    this.token = String(options.token || process.env.CODING_DELIVERY_GITHUB_TOKEN || '').trim();
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get configured() {
    return Boolean(this.token && typeof this.fetchImpl === 'function');
  }

  async request(method, path, body) {
    if (!this.configured) throw githubError('Coding delivery GitHub access is not configured.');
    let response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}/${String(path).replace(/^\//, '')}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'agentx-coding-delivery',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body == null ? {} : { 'Content-Type': 'application/json' })
        },
        body: body == null ? undefined : JSON.stringify(body)
      });
      if (response.status === 204) return null;
      if (!response.ok) {
        throw githubError('GitHub rejected the coding delivery request.', response.status === 404 ? 404 : 503);
      }
      try {
        return await response.json();
      } catch {
        throw githubError('GitHub returned an invalid coding delivery response.');
      }
    } catch (error) {
      if (error instanceof CodingDeliveryControlError) throw error;
      throw githubError(controller.signal.aborted
        ? 'GitHub coding delivery request timed out.'
        : 'GitHub did not answer the coding delivery request.');
    } finally {
      clearTimeout(timer);
    }
  }

  getPull(number) { return this.request('GET', `pulls/${exactPullRequestNumber(number)}`); }
  getCommit(sha) { return this.request('GET', `commits/${exactSha(sha, 'commit SHA')}`); }
  getRunJobs(runId) { return this.request('GET', `actions/runs/${Number(runId)}/jobs?per_page=100`); }
  getIssueComments(number) {
    return this.request('GET', `issues/${exactPullRequestNumber(number)}/comments?per_page=100`);
  }
  compareCommits(base, head) {
    return this.request('GET', `compare/${exactSha(base, 'base SHA')}...${exactSha(head, 'head SHA')}`);
  }

  getWorkflowRuns(workflow, query = {}) {
    const params = new URLSearchParams({ per_page: '50', ...query });
    return this.request('GET', `actions/workflows/${encodeURIComponent(workflow)}/runs?${params}`);
  }

  mergePull(number, sha) {
    return this.request('PUT', `pulls/${exactPullRequestNumber(number)}/merge`, {
      sha: exactSha(sha, 'head SHA'),
      merge_method: 'merge'
    });
  }
}

// Only shared reads within one status observation are reused. A later status
// or consequential merge always reads fresh task, receipt, GitHub and production
// evidence. This wrapper deliberately exposes no mutation method.
function observationGitHub(github) {
  const reads = new Map();
  const client = { configured: github.configured };
  for (const method of ['getPull', 'getCommit', 'getRunJobs', 'getIssueComments', 'compareCommits', 'getWorkflowRuns']) {
    client[method] = (...args) => {
      const key = JSON.stringify([method, args]);
      if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => github[method](...args)));
      return reads.get(key);
    };
  }
  return client;
}

async function mapConcurrent(items, concurrency, project) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await project(items[index]);
    }
  }));
  return results;
}

function selectExactRun(payload, predicate) {
  return safeArray(payload?.workflow_runs)
    .filter(predicate)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] || null;
}

function ciProjection(run, jobsPayload) {
  if (!run) return {
    status: 'pending', conclusion: null, green: false, runId: null, url: null, requiredJobs: REQUIRED_PR_CI_JOBS
  };
  const jobs = safeArray(jobsPayload?.jobs);
  const byName = new Map(jobs.map((job) => [String(job.name || ''), job]));
  const requiredGreen = REQUIRED_PR_CI_JOBS.every((name) => {
    const job = byName.get(name);
    return job?.status === 'completed' && job?.conclusion === 'success';
  });
  return {
    status: String(run.status || 'unknown'),
    conclusion: run.conclusion || null,
    green: run.status === 'completed' && run.conclusion === 'success' && requiredGreen,
    runId: Number(run.id) || null,
    url: run.html_url || null,
    requiredJobs: REQUIRED_PR_CI_JOBS.map((name) => ({
      name,
      status: byName.get(name)?.status || 'missing',
      conclusion: byName.get(name)?.conclusion || null
    }))
  };
}

function receiptGate(task, attempt, promotion, pr, commit, promotionReceipt) {
  const fingerprint = String(attempt?.evidence?.workerReceiptFingerprint || '');
  const headSha = String(pr?.head?.sha || '').toLowerCase();
  const branch = `agentx/coding-task-${task.pipelineId}-attempt-${attempt.attempt}`;
  const body = String(pr?.body || '');
  const commitMessage = String(commit?.commit?.message || '');
  const exactPullRequest = Number(pr?.number) === promotion.pullRequestNumber
    && pr?.base?.ref === 'main'
    && pr?.head?.ref === branch;
  const exactHead = SHA_PATTERN.test(headSha) && String(commit?.sha || '').toLowerCase() === headSha;
  const ownerOnlyReceipt = Boolean(
    promotionReceipt
    && promotionReceipt.schema === PROMOTION_MARKER
    && promotionReceipt.state === 'complete'
    && promotionReceipt.pipelineId === task.pipelineId
    && Number(promotionReceipt.attempt) === Number(attempt.attempt)
    && promotionReceipt.workerReceiptFingerprint === fingerprint
    && promotionReceipt.branch === branch
    && String(promotionReceipt.commit || '').toLowerCase() === headSha
    && Number(promotionReceipt.pullRequest?.number) === Number(pr?.number)
    && promotionReceipt.pullRequest?.url === pr?.html_url
  );
  const sealedReceipt = Boolean(
    ownerOnlyReceipt
    && fingerprint
    && body.includes(`Pipeline task: \`${task.pipelineId}\``)
    && body.includes(`Attempt: \`${attempt.attempt}\``)
    && body.includes(`Worker receipt: \`${fingerprint}\``)
    && body.includes(PRE_REVIEW_MARKER)
    && commitMessage.includes(`AgentX-Pipeline-Task: ${task.pipelineId}`)
    && commitMessage.includes(`AgentX-Attempt: ${attempt.attempt}`)
    && commitMessage.includes(`AgentX-Worker-Receipt: ${fingerprint}`)
  );
  return { exactPullRequest, exactHead, sealedReceipt, ownerOnlyReceipt, branch, headSha };
}

function publicPullRequest(pr) {
  return {
    number: Number(pr.number),
    url: pr.html_url,
    state: pr.merged ? 'merged' : String(pr.state || 'unknown'),
    headSha: String(pr.head?.sha || '').toLowerCase(),
    baseSha: String(pr.base?.sha || '').toLowerCase(),
    mergeCommitSha: pr.merge_commit_sha || null,
    mergeable: pr.mergeable === true,
    mergeableState: String(pr.mergeable_state || 'unknown'),
    updatedAt: pr.updated_at || null
  };
}

function publicDeployment(run, production, status, rollbackProven = false) {
  return {
    status,
    runId: Number(run?.id) || null,
    url: run?.html_url || null,
    conclusion: run?.conclusion || null,
    targetSha: run?.head_sha || null,
    rollbackProven,
    production: production || null
  };
}

async function productionContainsMerge(github, production, mergeSha) {
  const checkoutSha = String(production?.checkoutSha || '').toLowerCase();
  if (production?.available !== true || !SHA_PATTERN.test(checkoutSha)) return false;
  if (checkoutSha === mergeSha) return true;
  try {
    const comparison = await github.compareCommits(mergeSha, checkoutSha);
    return ['ahead', 'identical'].includes(String(comparison?.status || '').toLowerCase())
      && String(comparison?.base_commit?.sha || '').toLowerCase() === mergeSha
      && String(comparison?.merge_base_commit?.sha || '').toLowerCase() === mergeSha;
  } catch {
    return false;
  }
}

async function deliveryForPromotedTask({ task, attempt, promotion, github, production, promotionReceipt, deploymentWorkflow = '' }) {
  const pr = await github.getPull(promotion.pullRequestNumber);
  const pullRequest = publicPullRequest(pr);
  if (pr.merged !== true && String(pr.state || '').toLowerCase() === 'closed') {
    const supersession = trustedSupersession(await github.getIssueComments(pr.number));
    if (supersession) return null;
  }
  const commit = await github.getCommit(pullRequest.headSha);
  const receipt = receiptGate(task, attempt, promotion, pr, commit, promotionReceipt);
  const ciRuns = await github.getWorkflowRuns('ci.yml', {
    branch: receipt.branch,
    event: 'pull_request'
  });
  const ciRun = selectExactRun(ciRuns, (run) => String(run?.head_sha || '').toLowerCase() === receipt.headSha);
  const jobsPayload = ciRun ? await github.getRunJobs(ciRun.id) : null;
  const ci = ciProjection(ciRun, jobsPayload);
  const gate = {
    taskAccepted: task.status === 'done' && attempt.reviewOutcome === 'accepted',
    exactPullRequest: receipt.exactPullRequest,
    exactHead: receipt.exactHead,
    sealedReceipt: receipt.sealedReceipt,
    ciGreen: ci.green,
    mergeable: pr.merged === true || pr.mergeable === true,
    ready: false
  };
  gate.ready = Object.values({
    taskAccepted: gate.taskAccepted,
    exactPullRequest: gate.exactPullRequest,
    exactHead: gate.exactHead,
    sealedReceipt: gate.sealedReceipt,
    ciGreen: gate.ciGreen,
    mergeable: gate.mergeable
  }).every(Boolean);

  if (pr.merged === true) {
    const mergeSha = exactSha(pr.merge_commit_sha, 'merge commit SHA');
    if (!deploymentWorkflow) {
      const parity = await productionContainsMerge(github, production, mergeSha)
        && production.clean === true && production.healthy === true && production.runtimeMatchesCheckout === true;
      return baseItem(task, attempt, parity ? 'deployed' : 'deployment_pending', {
        humanActionRequired: !parity, pullRequest, ci, gate,
        deployment: publicDeployment(null, production, parity ? 'succeeded' : 'pending'),
        nextAction: parity
          ? 'The accepted merge is in the clean, healthy AgentX instance and its running service revisions match the checkout.'
          : 'Deploy the accepted AgentX checkout with the existing launcher and external instance configuration, then verify its running revision and health.'
      });
    }
    const deployRuns = await github.getWorkflowRuns(deploymentWorkflow);
    const exactDeployRun = selectExactRun(deployRuns, (run) => (
      String(run?.head_sha || '').toLowerCase() === mergeSha
      || String(run?.display_title || '').includes(mergeSha)
    ));
    const containsMerge = await productionContainsMerge(github, production, mergeSha);
    const productionDeployRun = containsMerge && SHA_PATTERN.test(String(production?.checkoutSha || '').toLowerCase())
      ? selectExactRun(deployRuns, (run) => (
        String(run?.head_sha || '').toLowerCase() === String(production.checkoutSha).toLowerCase()
      ))
      : null;
    const deployRun = productionDeployRun || exactDeployRun;
    if (!deployRun) {
      return baseItem(task, attempt, 'deployment_pending', {
        pullRequest,
        ci,
        gate,
        deployment: publicDeployment(null, production, 'pending'),
        nextAction: 'Inspect the explicitly configured deployment workflow and its exact source revision.'
      });
    }
    if (['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(String(deployRun.status))) {
      return baseItem(task, attempt, 'deployment_in_progress', {
        pullRequest,
        ci,
        gate,
        deployment: publicDeployment(deployRun, production, 'in_progress'),
        nextAction: 'Wait for the protected deployment transaction and production proof.'
      });
    }
    if (deployRun.conclusion === 'success') {
      const parity = containsMerge
        && production.clean === true
        && production.healthy === true;
      return baseItem(task, attempt, parity ? 'deployed' : 'deployment_verification_failed', {
        humanActionRequired: !parity,
        recommendation: parity ? 'MERGE' : 'CORRECT',
        pullRequest,
        ci,
        gate,
        deployment: publicDeployment(deployRun, production, parity ? 'succeeded' : 'verification_failed'),
        nextAction: parity
          ? 'No action: the merge commit is contained in the current tracked-clean, healthy production checkout.'
          : 'Inspect the successful workflow against live checkout ancestry, tracked cleanliness, and health before claiming production.'
      });
    }
    const jobsPayload = await github.getRunJobs(deployRun.id);
    const rollbackProven = safeArray(jobsPayload?.jobs).some((job) => safeArray(job?.steps).some((step) => (
      /rollback/i.test(String(step?.name || '')) && step?.conclusion === 'success'
    )));
    const stage = rollbackProven ? 'deployment_rolled_back' : 'deployment_failed';
    return baseItem(task, attempt, stage, {
      humanActionRequired: true,
      recommendation: 'CORRECT',
      pullRequest,
      ci,
      gate,
      deployment: publicDeployment(deployRun, production, rollbackProven ? 'rolled_back' : 'failed', rollbackProven),
      nextAction: rollbackProven
        ? 'Production was preserved or restored. Inspect the failed deployment gate before retrying the exact SHA.'
        : 'Inspect the protected deployment run and live production parity before deciding whether to retry.'
    });
  }

  if (!receipt.exactPullRequest || !receipt.exactHead || !receipt.sealedReceipt) {
    return baseItem(task, attempt, 'receipt_mismatch', {
      humanActionRequired: true,
      recommendation: 'CORRECT',
      pullRequest, ci, gate,
      nextAction: 'Do not merge. Reconcile the exact task, attempt, branch, head SHA, PR body, commit trailers, and sealed receipt.'
    });
  }
  if (String(pr.state || '').toLowerCase() === 'closed') {
    return baseItem(task, attempt, 'merge_blocked', {
      humanActionRequired: true,
      recommendation: 'CORRECT',
      pullRequest, ci, gate,
      nextAction: `PR #${pr.number} is closed without merge. Reopen the exact sealed PR only if it is still intended; otherwise request a correction so the guarded publisher can create a replacement PR and exact-head CI.`
    });
  }
  if (!ciRun || ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(ci.status)) {
    return baseItem(task, attempt, ciRun ? 'ci_running' : 'ci_pending', {
      pullRequest, ci, gate,
      nextAction: ciRun
        ? 'Wait for the existing required CI jobs to finish on this source revision.'
        : 'Wait for or re-dispatch the existing full PR CI workflow on the exact branch head.'
    });
  }
  if (!ci.green) {
    return baseItem(task, attempt, 'ci_failed', {
      humanActionRequired: true,
      recommendation: 'CORRECT',
      pullRequest, ci, gate,
      nextAction: 'Inspect the failed exact-head CI run and request a correction; this PR is not merge-eligible.'
    });
  }
  if (pr.mergeable !== true) {
    return baseItem(task, attempt, 'merge_blocked', {
      humanActionRequired: true,
      recommendation: 'CORRECT',
      pullRequest, ci, gate,
      nextAction: pr.mergeable === null
        ? 'Wait for GitHub to finish the mergeability calculation, then refresh.'
        : 'Correct the merge conflict or repository gate, rerun exact-head CI, and refresh.'
    });
  }
  return baseItem(task, attempt, 'pr_ready_to_merge', {
    humanActionRequired: true,
    pullRequest, ci, gate,
    nextAction: `Review the bounded diff, then explicitly merge PR #${pr.number} at ${receipt.headSha}.`
  });
}

function productionCommand(root, { projectName = 'agentx', envFile, overrideFile } = {}) {
  const safeRoot = exactRemoteRoot(root);
  if (!envFile || !/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) {
    throw new CodingDeliveryControlError('An explicit production env file and project are required.', { statusCode: 503 });
  }
  const safeEnv = exactRemoteRoot(envFile);
  const override = overrideFile ? ` -f ${exactRemoteRoot(overrideFile)}` : '';
  return [
    'set -eu',
    `root=${safeRoot}`,
    `compose() { docker compose --project-directory "$root" --project-name ${projectName} --env-file ${safeEnv} -f "$root/docker-compose.yml"${override} "$@"; }`,
    'printf "checkout=%s\\n" "$(git -C "$root" rev-parse HEAD)"',
    'if git -C "$root" diff --quiet HEAD -- && git -C "$root" diff --cached --quiet; then printf "clean=yes\\n"; else printf "clean=no\\n"; fi',
    'enabled=$(compose config --services)',
    'for service in core benchmark rag data; do if [ "$service" = data ] && ! printf "%s\\n" "$enabled" | grep -qx data; then printf "data=not-enabled\\n"; continue; fi; container=$(compose ps -q "$service"); state=$(docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" "$container" 2>/dev/null || true); printf "%s=%s\\n" "$service" "$state"; revision=$(docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$container" 2>/dev/null | sed -n "s/^AGENTX_BUILD_REVISION=//p" || true); printf "%sRevision=%s\\n" "$service" "$revision"; done'
  ].join('; ');
}

function promotionReceiptCommand(root, pipelineId, attempt) {
  const safeRoot = exactRemoteRoot(root);
  const safePipelineId = exactPipelineId(pipelineId);
  const safeAttempt = Number(attempt);
  if (!Number.isSafeInteger(safeAttempt) || safeAttempt < 1) {
    throw new CodingDeliveryControlError('Promotion receipt attempt is invalid.', {
      code: 'CODING_DELIVERY_INVALID_RECEIPT', statusCode: 400
    });
  }
  const path = `${safeRoot}/${safePipelineId}-attempt-${safeAttempt}.json`;
  return [
    'set -eu',
    `receipt=${path}`,
    'test -f "$receipt"',
    'test "$(stat -c %U "$receipt")" = "$(id -un)"',
    'test "$(stat -c %a "$receipt")" = "600"',
    'cat -- "$receipt"'
  ].join('; ');
}

async function defaultPromotionReceiptReader({ target, root, pipelineId, attempt, sshOptions = {} }) {
  if (!target) return null;
  const sshBin = sshOptions.sshBin || process.env.OPENCLAW_INVENTORY_SSH_BIN || 'ssh';
  try {
    const { stdout } = await execFileAsync(
      sshBin,
      buildSshArgs(target, promotionReceiptCommand(root, pipelineId, attempt), sshOptions),
      { timeout: Number(sshOptions.timeoutMs) || DEFAULT_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }
    );
    const receipt = JSON.parse(String(stdout || ''));
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
  } catch {
    return null;
  }
}

function parseProductionState(stdout) {
  const values = Object.fromEntries(String(stdout || '').split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : null;
  }).filter(Boolean));
  const checkoutSha = SHA_PATTERN.test(values.checkout || '') ? values.checkout : null;
  const services = Object.fromEntries(['core', 'benchmark', 'rag', 'data'].map((name) => [name, values[name] || 'unknown']));
  const requiredServices = Object.keys(services).filter(name => name !== 'data' || services.data !== 'not-enabled');
  const runtimeMatchesCheckout = Boolean(checkoutSha) && requiredServices.every(name => values[`${name}Revision`] === checkoutSha);
  return {
    available: Boolean(checkoutSha),
    checkoutSha,
    ...(SHA_PATTERN.test(values.productRevision || '') && { productRevision: values.productRevision }),
    clean: values.clean === 'yes',
    healthy: requiredServices.every(name => services[name] === 'healthy'),
    runtimeMatchesCheckout,
    services
  };
}

async function defaultProductionReader({ target, root, envFile, projectName, overrideFile, sshOptions = {} }) {
  if (!target || !envFile) return { available: false, checkoutSha: null, clean: null, healthy: null, services: {} };
  const sshBin = sshOptions.sshBin || process.env.OPENCLAW_INVENTORY_SSH_BIN || 'ssh';
  try {
    const { stdout } = await execFileAsync(
      sshBin,
      buildSshArgs(target, productionCommand(root, { envFile, projectName, overrideFile }), sshOptions),
      { timeout: Number(sshOptions.timeoutMs) || DEFAULT_TIMEOUT_MS, maxBuffer: 32 * 1024, windowsHide: true }
    );
    return parseProductionState(stdout);
  } catch {
    return { available: false, checkoutSha: null, clean: null, healthy: null, services: {} };
  }
}

class CodingDeliveryControl {
  constructor(options = {}) {
    this.repository = exactRepository(options.repository || process.env.CODING_DELIVERY_GITHUB_REPOSITORY);
    this.github = options.github || new GitHubRepositoryClient({ repository: this.repository });
    // Historical product task receipts remain inspectable only when explicitly
    // configured; new work belongs to the canonical repository.
    this.productGithub = options.productGithub || (process.env.CODING_DELIVERY_LEGACY_PRODUCT_ENABLED === 'true'
      ? new GitHubRepositoryClient({ repository: PRODUCT_REPOSITORY }) : { configured: false });
    this.deploymentWorkflow = options.deploymentWorkflow ?? process.env.CODING_DELIVERY_DEPLOY_WORKFLOW ?? '';
    this.taskReader = options.taskReader || (async () => []);
    this.productionTarget = String(
      options.productionTarget
      || process.env.CODING_DELIVERY_SSH_TARGET
      || ''
    ).trim();
    this.productionRoot = exactRemoteRoot(
      options.productionRoot || process.env.CODING_DELIVERY_REMOTE_ROOT || DEFAULT_REMOTE_ROOT
    );
    this.productionEnvFile = options.productionEnvFile || process.env.CODING_DELIVERY_ENV_FILE || '';
    this.receiptRoot = exactRemoteRoot(
      options.receiptRoot || process.env.CODING_DELIVERY_PROMOTION_RECEIPT_ROOT || DEFAULT_PROMOTION_RECEIPT_ROOT
    );
    this.productionReader = options.productionReader || (() => defaultProductionReader({
      target: this.productionTarget,
      root: this.productionRoot,
      envFile: this.productionEnvFile,
      projectName: options.productionProject || process.env.CODING_DELIVERY_PROJECT_NAME || 'agentx',
      overrideFile: options.productionOverride || process.env.CODING_DELIVERY_COMPOSE_OVERRIDE || '',
      sshOptions: options.sshOptions || {}
    }));
    this.receiptReader = options.receiptReader || (({ pipelineId, attempt }) => defaultPromotionReceiptReader({
      target: this.productionTarget,
      root: this.receiptRoot,
      pipelineId,
      attempt,
      sshOptions: options.sshOptions || {}
    }));
    this.merging = new Set();
  }

  configuration() {
    return {
      contractVersion: 1,
      authority: 'aio-ops.coding-delivery',
      repository: this.repository,
      githubConfigured: this.github.configured === true,
      productionProbeConfigured: Boolean(this.productionTarget && this.productionEnvFile),
      mergeMode: 'explicit-operator-click',
      autoMerge: false,
      deployment: this.deploymentWorkflow ? `workflow:${this.deploymentWorkflow}` : 'manual-agentx-launcher',
      secretsExposedToBrowser: false
    };
  }

  async status() {
    const startedAt = Date.now();
    const github = observationGitHub(this.github);
    const productGithub = observationGitHub(this.productGithub);
    const [tasks, production] = await Promise.all([this.taskReader(), this.productionReader()]);
    const projectedItems = await mapConcurrent(safeArray(tasks), 3, async (task) => {
      let projected;
      try {
        if (String(task.automation?.policyRef || '').startsWith('product.') && task.status === 'done' && acceptedAttempt(task)) {
          try { return await productDelivery(task, productGithub, production); }
          catch { return baseItem(task, acceptedAttempt(task), 'delivery_unavailable', {
            humanActionRequired: true, recommendation: 'CORRECT', nextAction: 'Product delivery could not be verified. Refresh its repository and production evidence.'
          }); }
        }
        projected = localItem(task, this.repository);
      } catch {
        return null;
      }
      if (!projected) return null;
      if (projected.stage) {
        return projected;
      }
      if (this.github.configured !== true) {
        return baseItem(projected.task, projected.attempt, 'delivery_unavailable', {
          humanActionRequired: true,
          recommendation: 'CORRECT',
          pullRequest: {
            number: projected.promotion.pullRequestNumber,
            url: projected.promotion.url,
            state: 'unknown', headSha: null, baseSha: null,
            mergeCommitSha: null, mergeable: false, mergeableState: 'unknown', updatedAt: null
          },
          nextAction: 'Configure the server-only coding delivery GitHub credential; do not merge from an unverified browser state.'
        });
      }
      try {
        const promotionReceipt = await this.receiptReader({
          pipelineId: projected.task.pipelineId,
          attempt: projected.attempt.attempt
        });
        const item = await deliveryForPromotedTask({ ...projected, github, production, promotionReceipt, deploymentWorkflow: this.deploymentWorkflow });
        return item;
      } catch {
        return baseItem(projected.task, projected.attempt, 'delivery_unavailable', {
          humanActionRequired: true,
          recommendation: 'CORRECT',
          pullRequest: {
            number: projected.promotion.pullRequestNumber,
            url: projected.promotion.url,
            state: 'unknown', headSha: null, baseSha: null,
            mergeCommitSha: null, mergeable: false, mergeableState: 'unknown', updatedAt: null
          },
          nextAction: 'Refresh after GitHub access recovers; do not merge while exact delivery evidence is unavailable.'
        });
      }
    });
    const items = projectedItems.filter(Boolean);
    items.sort((a, b) => (
      Number(b.humanActionRequired) - Number(a.humanActionRequired)
      || a.rank - b.rank
      || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
      || a.pipelineId.localeCompare(b.pipelineId)
    ));
    return {
      ...this.configuration(),
      observedAt: new Date().toISOString(),
      observationDurationMs: Date.now() - startedAt,
      production,
      counts: {
        total: items.length,
        humanActionRequired: items.filter((item) => item.humanActionRequired).length,
        readyToMerge: items.filter((item) => item.stage === 'pr_ready_to_merge').length
      },
      items
    };
  }

  async merge(input = {}) {
    const pipelineId = exactPipelineId(input.pipelineId);
    const pullRequestNumber = exactPullRequestNumber(input.pullRequestNumber);
    const expectedHeadSha = exactSha(input.expectedHeadSha, 'expected head SHA');
    if (String(input.confirmation || '') !== mergeConfirmation(pullRequestNumber, expectedHeadSha)) {
      throw new CodingDeliveryControlError('Exact protected merge confirmation is required.', {
        code: 'CODING_DELIVERY_CONFIRMATION_REQUIRED', statusCode: 400
      });
    }
    if (this.github.configured !== true) {
      throw new CodingDeliveryControlError('Server-only GitHub delivery access is unavailable.', {
        code: 'CODING_DELIVERY_GITHUB_UNAVAILABLE', statusCode: 503
      });
    }
    if (this.merging.has(pipelineId)) {
      throw new CodingDeliveryControlError('This exact task merge is already being processed.', {
        code: 'CODING_DELIVERY_ALREADY_MERGING', statusCode: 409
      });
    }

    this.merging.add(pipelineId);
    try {
      const tasks = safeArray(await this.taskReader());
      const task = tasks.find((candidate) => String(candidate?.pipelineId) === pipelineId);
      const attempt = task && acceptedAttempt(task);
      const promotion = task && promotionFromTask(task, this.repository);
      if (!task || !attempt || !promotion || promotion.pullRequestNumber !== pullRequestNumber) {
        throw new CodingDeliveryControlError('The accepted task and deterministic PR identity do not match.', {
          code: 'CODING_DELIVERY_IDENTITY_MISMATCH', statusCode: 409
        });
      }
      const item = await deliveryForPromotedTask({
        deploymentWorkflow: this.deploymentWorkflow,
        task,
        attempt,
        promotion,
        github: this.github,
        production: await this.productionReader(),
        promotionReceipt: await this.receiptReader({ pipelineId, attempt: attempt.attempt })
      });
      if (item.stage !== 'pr_ready_to_merge' || item.gate?.ready !== true || item.pullRequest?.headSha !== expectedHeadSha) {
        throw new CodingDeliveryControlError('The exact PR is not eligible for merge.', {
          code: 'CODING_DELIVERY_NOT_MERGEABLE', statusCode: 409,
          data: { stage: item.stage, gate: item.gate }
        });
      }
      const merged = await this.github.mergePull(pullRequestNumber, expectedHeadSha);
      if (merged?.merged !== true || !SHA_PATTERN.test(String(merged.sha || '').toLowerCase())) {
        throw new CodingDeliveryControlError('GitHub did not confirm the exact PR merge.', {
          code: 'CODING_DELIVERY_MERGE_REJECTED', statusCode: 409
        });
      }
      const mergeCommitSha = String(merged.sha).toLowerCase();
      return {
        merged: true,
        pipelineId,
        pullRequestNumber,
        headSha: expectedHeadSha,
        mergeCommitSha,
        deploymentDispatched: true,
        deploymentTrigger: 'push-to-main',
        deploymentWorkflow: 'deploy.yml'
      };
    } finally {
      this.merging.delete(pipelineId);
    }
  }
}

function sendError(res, error, logger) {
  const statusCode = Number(error?.statusCode) || 500;
  const code = error?.code || 'CODING_DELIVERY_ERROR';
  if (statusCode >= 500) logger?.warn?.('Coding delivery control failed', { code });
  const message = String(error?.message || 'Coding delivery request failed.');
  return res.status(statusCode).json({
    status: 'error',
    message,
    error: { code, message },
    ...(error?.data ? { data: error.data } : {})
  });
}

function registerCodingDeliveryControlRoutes({ express, control, logger }) {
  const router = express.Router();
  router.get('/status', async (_req, res) => {
    try {
      return res.json({ status: 'success', data: await control.status() });
    } catch (error) {
      return sendError(res, error, logger);
    }
  });
  router.post('/merge', async (req, res) => {
    try {
      return res.status(202).json({ status: 'success', data: await control.merge(req.body || {}) });
    } catch (error) {
      return sendError(res, error, logger);
    }
  });
  return router;
}

module.exports = {
  CodingDeliveryControl,
  CodingDeliveryControlError,
  GitHubRepositoryClient,
  REQUIRED_PR_CI_JOBS,
  acceptedAttempt,
  ciProjection,
  deliveryForPromotedTask,
  exactPipelineId,
  localItem,
  mergeConfirmation,
  parseProductionState,
  promotionReceiptCommand,
  productionCommand,
  promotionFromTask,
  receiptGate,
  registerCodingDeliveryControlRoutes
};
