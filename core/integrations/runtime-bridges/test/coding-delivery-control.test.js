'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  CodingDeliveryControl,
  deliveryForPromotedTask,
  localItem,
  mergeConfirmation,
  parseProductionState,
  productionCommand,
  promotionReceiptCommand,
  promotionFromTask,
  receiptGate,
  registerCodingDeliveryControlRoutes
} = require('../coding-delivery-control');

const FINGERPRINT = 'b4e1d774f51a1500d8719f1507d0817449ec96a8d9dc0dcb1d8b66494e47e71d';
const HEAD_SHA = '3fb31edc33a5fa1f54161898b389e1e68f6cb85c';
const MERGE_SHA = '4d840d94004c9d0f8f8ea229d608e65e6f22d91c';

function attempt(overrides = {}) {
  return {
    attempt: 3,
    assignee: 'clawdx-worker',
    finalState: 'review',
    reviewOutcome: 'accepted',
    reviewedAt: '2026-09-05T04:13:50.981Z',
    evidence: {
      verification: { status: 'passed', durationMs: 926, testsPassed: 8, testsFailed: 0 },
      changes: { filesChanged: 1, bytesChanged: 2369 },
      failureCodes: [],
      workerReceiptFingerprint: FINGERPRINT
    },
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    pipelineId: '0603',
    title: 'Couple the Pipeline deployment probe to the dossier contract',
    status: 'done',
    risk: 'low',
    updatedAt: '2026-09-05T04:14:54.188Z',
    automation: { mode: 'review_only', scope: ['scripts/tests/rendered-page-gate.test.js'] },
    automationAttempts: [attempt()],
    feedback: [{
      at: '2026-09-05T04:14:54.188Z',
      by: 'coding-promotion',
      text: 'agentx.coding-promotion/v1 task=0603 attempt=3\n'
        + 'Verified worker snapshot published as https://github.com/WindriderQc/AgentX/pull/442. '
        + 'Full PR CI was dispatched. Merge and production remain separate human gates.'
    }],
    ...overrides
  };
}

function pull(overrides = {}) {
  return {
    number: 442,
    html_url: 'https://github.com/WindriderQc/AgentX/pull/442',
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    mergeable: true,
    mergeable_state: 'unstable',
    updated_at: '2026-09-05T04:14:51Z',
    head: { ref: 'agentx/coding-task-0603-attempt-3', sha: HEAD_SHA },
    base: { ref: 'main', sha: 'b5e774c21b4a35292137062ad2c70c3a1e284b10' },
    body: 'Pipeline task: `0603`\nAttempt: `3`\n'
      + `Worker receipt: \`${FINGERPRINT}\`\n`
      + '<!-- agentx.coding-team-pre-review/v1 -->',
    ...overrides
  };
}

function commit(overrides = {}) {
  return {
    sha: HEAD_SHA,
    commit: {
      message: 'chore(coding-team): promote task 0603 attempt 3\n\n'
        + 'AgentX-Pipeline-Task: 0603\nAgentX-Attempt: 3\n'
        + `AgentX-Worker-Receipt: ${FINGERPRINT}`
    },
    ...overrides
  };
}

function promotionReceipt(overrides = {}) {
  return {
    schema: 'agentx.coding-promotion/v1',
    state: 'complete',
    pipelineId: '0603',
    attempt: 3,
    workerReceiptFingerprint: FINGERPRINT,
    branch: 'agentx/coding-task-0603-attempt-3',
    commit: HEAD_SHA,
    pullRequest: {
      number: 442,
      url: 'https://github.com/WindriderQc/AgentX/pull/442'
    },
    ...overrides
  };
}

function ciRun(overrides = {}) {
  return {
    id: 33944038638,
    head_sha: HEAD_SHA,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-05T04:14:53Z',
    html_url: 'https://github.com/WindriderQc/AgentX/actions/runs/33944038638',
    ...overrides
  };
}

function greenJobs() {
  return {
    jobs: [
      { name: 'tests (core)', status: 'completed', conclusion: 'success', steps: [] },
      { name: 'tests (benchmark)', status: 'completed', conclusion: 'success', steps: [] },
      { name: 'tests (rag)', status: 'completed', conclusion: 'success', steps: [] },
      { name: 'tests (data)', status: 'completed', conclusion: 'success', steps: [] },
      { name: 'compose', status: 'completed', conclusion: 'success', steps: [] }
    ]
  };
}

function production(overrides = {}) {
  return {
    available: true,
    checkoutSha: MERGE_SHA,
    clean: true,
    healthy: true,
    runtimeMatchesCheckout: true,
    services: { core: 'healthy', benchmark: 'healthy', rag: 'healthy', data: 'healthy' },
    ...overrides
  };
}

function github(overrides = {}) {
  return {
    configured: true,
    async getPull() { return pull(); },
    async getCommit() { return commit(); },
    async getIssueComments() { return []; },
    async compareCommits(base, head) {
      return {
        status: base === head ? 'identical' : 'diverged',
        base_commit: { sha: base },
        merge_base_commit: { sha: base === head ? base : HEAD_SHA }
      };
    },
    async getWorkflowRuns(workflow) {
      if (workflow === 'ci.yml') return { workflow_runs: [ciRun()] };
      return { workflow_runs: [] };
    },
    async getRunJobs() { return greenJobs(); },
    async mergePull() { return { merged: true, sha: MERGE_SHA }; },
    ...overrides
  };
}

function fakeExpress() {
  return {
    Router() {
      const routes = [];
      return {
        routes,
        use(...handlers) { routes.push({ method: 'use', path: null, handlers }); },
        get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
        post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); }
      };
    }
  };
}

function route(router, method, path) {
  return router.routes.find((entry) => entry.method === method && entry.path === path);
}

class Response {
  constructor() { this.statusCode = 200; this.jsonBody = null; }
  status(code) { this.statusCode = code; return this; }
  json(value) { this.jsonBody = value; return this; }
}

test('promotion and receipt identities bind the exact task, attempt, PR, branch, SHA, and fingerprint', () => {
  const candidate = task();
  const promotion = promotionFromTask(candidate, 'WindriderQc/AgentX');
  assert.deepEqual(promotion, {
    pipelineId: '0603',
    attempt: 3,
    pullRequestNumber: 442,
    url: 'https://github.com/WindriderQc/AgentX/pull/442',
    recordedAt: '2026-09-05T04:14:54.188Z'
  });
  assert.deepEqual(receiptGate(candidate, attempt(), promotion, pull(), commit(), promotionReceipt()), {
    exactPullRequest: true,
    exactHead: true,
    sealedReceipt: true,
    ownerOnlyReceipt: true,
    branch: 'agentx/coding-task-0603-attempt-3',
    headSha: HEAD_SHA
  });
  assert.equal(receiptGate(candidate, attempt(), promotion, pull({ body: 'wrong' }), commit(), promotionReceipt()).sealedReceipt, false);
  assert.equal(receiptGate(candidate, attempt(), promotion, pull(), commit(), null).sealedReceipt, false);
});

test('local inbox stages prioritize review, correction, and accepted results waiting for a PR', () => {
  const review = task({
    status: 'review',
    automationAttempts: [attempt({ reviewOutcome: 'pending', reviewedAt: null })],
    feedback: []
  });
  assert.equal(localItem(review, 'WindriderQc/AgentX').stage, 'review_ready');
  assert.equal(localItem(review, 'WindriderQc/AgentX').humanActionRequired, true);

  const correction = task({
    status: 'queued',
    automationAttempts: [attempt({ reviewOutcome: 'requeued' })],
    feedback: []
  });
  assert.equal(localItem(correction, 'WindriderQc/AgentX').stage, 'correction_requested');
  assert.equal(localItem(correction, 'WindriderQc/AgentX').summary.recommendation, 'CORRECT');

  assert.equal(localItem(task({ feedback: [] }), 'WindriderQc/AgentX').stage, 'accepted_waiting_pr');
});

test('existing AgentX CI makes a sealed mergeable PR ready for one explicit merge', async () => {
  const candidate = task();
  const item = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github(),
    production: production(),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(item.stage, 'pr_ready_to_merge');
  assert.equal(item.humanActionRequired, true);
  assert.equal(item.ci.green, true);
  assert.equal(item.gate.ready, true);
  assert.equal(item.pullRequest.headSha, HEAD_SHA);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'token'), false);
});

test('closed unmerged PR gives a terminal correction action instead of waiting for mergeability', async () => {
  const candidate = task();
  const item = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({
      async getPull() {
        return pull({ state: 'closed', merged: false, mergeable: null });
      }
    }),
    production: production(),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(item.stage, 'merge_blocked');
  assert.equal(item.humanActionRequired, true);
  assert.equal(item.summary.recommendation, 'CORRECT');
  assert.match(item.summary.nextAction, /closed without merge/);
  assert.match(item.summary.nextAction, /request a correction/);
  assert.doesNotMatch(item.summary.nextAction, /mergeability calculation/);
  assert.equal(item.gate.ready, false);
});

test('trusted GitHub supersession closes a stale PR without inventing a human action', async () => {
  const candidate = task();
  const item = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({
      async getPull() {
        return pull({ state: 'closed', merged: false, mergeable: null });
      },
      async getIssueComments() {
        return [{
          author_association: 'OWNER',
          body: 'Superseded by the reconciled change in #453.',
          html_url: 'https://github.test/comment/1'
        }];
      }
    }),
    production: production(),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(item, null);

  const untrusted = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({
      async getPull() {
        return pull({ state: 'closed', merged: false, mergeable: null });
      },
      async getIssueComments() {
        return [{ author_association: 'NONE', body: 'Superseded by something else.' }];
      }
    }),
    production: production(),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(untrusted.stage, 'merge_blocked');
});

test('failed CI and receipt drift fail closed to CORRECT', async () => {
  const candidate = task();
  const failed = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({
      async getWorkflowRuns() { return { workflow_runs: [ciRun({ conclusion: 'failure' })] }; },
      async getRunJobs() {
        return { jobs: [{ name: 'data-tests', status: 'completed', conclusion: 'failure' }, { name: 'compose', status: 'completed', conclusion: 'success' }] };
      }
    }),
    production: production(),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(failed.stage, 'ci_failed');
  assert.equal(failed.summary.recommendation, 'CORRECT');
  assert.equal(failed.gate.ready, false);

  const drift = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({ async getPull() { return pull({ body: 'receipt missing' }); } }),
    production: production(),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(drift.stage, 'receipt_mismatch');
  assert.equal(drift.gate.sealedReceipt, false);

  const changedHead = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github(),
    production: production(),
    promotionReceipt: promotionReceipt({ commit: 'a'.repeat(40) })
  });
  assert.equal(changedHead.stage, 'receipt_mismatch');
  assert.equal(changedHead.gate.ready, false);
});

test('merged PR follows the separate deployment workflow and requires live production parity for success', async () => {
  const candidate = task();
  // Historical PRs predate the advisory pre-review marker; a human correction
  // may also have changed the head after the worker receipt was recorded.
  const mergedPull = pull({
    merged: true, state: 'closed', merge_commit_sha: MERGE_SHA,
    body: pull().body.replace('<!-- agentx.coding-team-pre-review/v1 -->', '')
  });
  const deployed = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({
      async getPull() { return mergedPull; },
      async getWorkflowRuns(workflow) {
        if (workflow === 'ci.yml') return { workflow_runs: [ciRun()] };
        assert.equal(workflow, 'deploy.yml');
        return { workflow_runs: [{
          id: 44,
          head_sha: MERGE_SHA,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.test/actions/runs/44',
          created_at: '2026-09-05T04:30:00Z'
        }] };
      }
    }),
    production: production(),
    promotionReceipt: promotionReceipt({ commit: 'a'.repeat(40) })
  });
  assert.equal(deployed.stage, 'deployed');
  assert.equal(deployed.deployment.status, 'succeeded');
  assert.equal(deployed.gate, null);
  assert.equal(deployed.receipt.fingerprint, FINGERPRINT);

  const advancedSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const advanced = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({
      async getPull() { return mergedPull; },
      async compareCommits(base, head) {
        assert.equal(base, MERGE_SHA);
        assert.equal(head, advancedSha);
        return {
          status: 'ahead',
          base_commit: { sha: MERGE_SHA },
          merge_base_commit: { sha: MERGE_SHA }
        };
      },
      async getWorkflowRuns(workflow) {
        if (workflow === 'ci.yml') return { workflow_runs: [ciRun()] };
        return { workflow_runs: [{
          id: 46,
          head_sha: advancedSha,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.test/actions/runs/46',
          created_at: '2026-09-07T23:25:48Z'
        }] };
      }
    }),
    production: production({ checkoutSha: advancedSha }),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(advanced.stage, 'deployed');
  assert.equal(advanced.gate, null);
  assert.equal(advanced.deployment.targetSha, advancedSha);
  assert.match(advanced.summary.nextAction, /contained in the current/);

  const mismatch = await deliveryForPromotedTask({
    deploymentWorkflow: 'deploy.yml',
    task: candidate,
    attempt: attempt(),
    promotion: promotionFromTask(candidate),
    github: github({
      async getPull() { return mergedPull; },
      async getWorkflowRuns(workflow) {
        if (workflow === 'ci.yml') return { workflow_runs: [ciRun()] };
        return { workflow_runs: [{ id: 45, head_sha: MERGE_SHA, status: 'completed', conclusion: 'success' }] };
      }
    }),
    production: production({ checkoutSha: HEAD_SHA }),
    promotionReceipt: promotionReceipt()
  });
  assert.equal(mismatch.stage, 'deployment_verification_failed');
  assert.equal(mismatch.humanActionRequired, true);
  assert.equal(mismatch.gate, null);
});

test('merge requires exact confirmation and revalidates task, source and CI evidence', async () => {
  const calls = [];
  const control = new CodingDeliveryControl({
    github: github({
      async mergePull(number, sha) { calls.push(['merge', number, sha]); return { merged: true, sha: MERGE_SHA }; }
    }),
    taskReader: async () => [task()],
    receiptReader: async () => promotionReceipt(),
    productionReader: async () => production(),
    productionTarget: 'operator@192.0.2.99'
  });
  await assert.rejects(
    control.merge({ pipelineId: '0603', pullRequestNumber: 442, expectedHeadSha: HEAD_SHA }),
    (error) => error.code === 'CODING_DELIVERY_CONFIRMATION_REQUIRED'
  );
  const result = await control.merge({
    pipelineId: '0603',
    pullRequestNumber: 442,
    expectedHeadSha: HEAD_SHA,
    confirmation: mergeConfirmation(442, HEAD_SHA)
  });
  assert.deepEqual(calls, [['merge', 442, HEAD_SHA]]);
  assert.equal(result.merged, true);
  assert.equal(result.deploymentDispatched, true);
  assert.equal(result.deploymentTrigger, 'push-to-main');
  assert.equal(result.mergeCommitSha, MERGE_SHA);
});

test('status route never projects the GitHub secret', async () => {
  const githubClient = github();
  githubClient.token = 'top-secret-token';
  const control = new CodingDeliveryControl({
    github: githubClient,
    taskReader: async () => [task()],
    receiptReader: async () => promotionReceipt(),
    productionReader: async () => production(),
    productionTarget: 'operator@192.0.2.99'
  });
  const router = registerCodingDeliveryControlRoutes({ express: fakeExpress(), control, logger: {} });
  const response = new Response();
  await route(router, 'get', '/status').handlers[0]({}, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.jsonBody.data.counts.readyToMerge, 1);
  assert.equal(response.jsonBody.data.deployment, 'manual-agentx-launcher');
  assert.equal(JSON.stringify(response.jsonBody).includes('Bearer'), false);
  assert.equal(JSON.stringify(response.jsonBody).includes('top-secret-token'), false);
});

test('production projection is bounded to checkout, cleanliness, and service health', () => {
  assert.deepEqual(parseProductionState([
    `checkout=${MERGE_SHA}`,
    'clean=yes',
    'core=healthy',
    'benchmark=healthy',
    'rag=healthy',
    'data=healthy',
    ...['core', 'benchmark', 'rag', 'data'].map(name => `${name}Revision=${MERGE_SHA}`)
  ].join('\n')), production());
});

test('manual deployment requires running source identity and handles optional Data without a deploy workflow', async () => {
  const candidate = task();
  const base = [`checkout=${MERGE_SHA}`, 'clean=yes', 'core=healthy', 'benchmark=healthy', 'rag=healthy', 'data=not-enabled'];
  const configured = github({ getPull: async () => pull({ merged: true, merge_commit_sha: MERGE_SHA }),
    getWorkflowRuns: async workflow => { assert.equal(workflow, 'ci.yml'); return { workflow_runs: [ciRun()] }; } });
  const input = { task: candidate, attempt: candidate.automationAttempts[0], promotion: promotionFromTask(candidate), github: configured };
  const unidentified = parseProductionState(base.join('\n'));
  assert.equal(unidentified.healthy, true);
  assert.equal(unidentified.runtimeMatchesCheckout, false);
  assert.equal((await deliveryForPromotedTask({ ...input, production: unidentified })).stage, 'deployment_pending');
  const accepted = parseProductionState([...base, ...['core', 'benchmark', 'rag'].map(name => `${name}Revision=${MERGE_SHA}`)].join('\n'));
  assert.equal((await deliveryForPromotedTask({ ...input, production: accepted })).stage, 'deployed');
  const drifted = parseProductionState([...base, `coreRevision=${HEAD_SHA}`, `benchmarkRevision=${MERGE_SHA}`, `ragRevision=${MERGE_SHA}`].join('\n'));
  assert.equal((await deliveryForPromotedTask({ ...input, production: drifted })).stage, 'deployment_pending');
  const sourceEquivalent = parseProductionState([...base, `coreRevision=${HEAD_SHA}`, 'coreEquivalent=yes',
    `benchmarkRevision=${MERGE_SHA}`, `ragRevision=${MERGE_SHA}`].join('\n'));
  assert.equal((await deliveryForPromotedTask({ ...input, production: sourceEquivalent })).stage, 'deployed');
  const unproven = parseProductionState([...base, `coreRevision=${HEAD_SHA}`, 'coreEquivalent=no',
    `benchmarkRevision=${MERGE_SHA}`, `ragRevision=${MERGE_SHA}`].join('\n'));
  assert.equal((await deliveryForPromotedTask({ ...input, production: unproven })).stage, 'deployment_pending');
});

test('production probe selects the configured Compose instance and rejects shell syntax', () => {
  const command = productionCommand('/srv/agentx/AgentX', { projectName: 'agentx-canary', envFile: '/etc/agentx/canary.env', overrideFile: '/etc/agentx/canary.yml' });
  assert.match(command, /--project-name agentx-canary/);
  assert.match(command, /--env-file \/etc\/agentx\/canary.env/);
  assert.match(command, /compose ps -q/);
  assert.match(command, /service-image-parity\.py/);
  assert.doesNotMatch(command, /agentx-core|up -d/);
  assert.throws(() => productionCommand('/srv/agentx/AgentX'), /explicit production env/);
  assert.throws(() => productionCommand('/srv/agentx/AgentX', { projectName: 'x; touch', envFile: '/tmp/a' }));
  assert.throws(() => productionCommand('/srv/agentx/AgentX', { envFile: '/tmp/a;touch' }));
});

test('Product acceptance asks for Product publication instead of waiting for the AIOps publisher', async () => {
  const candidate = task({ automation: { mode: 'review_only', policyRef: 'product.pipeline-ui/v1' }, feedback: [] });
  const control = new CodingDeliveryControl({ taskReader: async () => [candidate], productionReader: async () => production() });
  const item = (await control.status()).items[0];
  assert.equal(item.stage, 'product_review');
  assert.equal(item.humanActionRequired, true);
  assert.match(item.summary.nextAction, /AIOps-only publisher does not publish Product/);
});

test('Product release status follows the correct PR and the live Product revision, not the AIOps checkout', async () => {
  const candidate = task({ automation: { mode: 'review_only', policyRef: 'product.pipeline-ui/v1' }, feedback: [
    { text: 'agentx.coding-promotion/v1 task=0603 attempt=3\nhttps://github.com/WindriderQc/AgentX-Ecosystem/pull/211' }
  ] });
  for (const sample of [
    { merged: false, state: 'open', expected: 'product_review' },
    { merged: false, state: 'closed', expected: 'merge_blocked' },
    { merged: true, revision: HEAD_SHA, expected: 'deployment_pending' },
    { merged: true, revision: MERGE_SHA, expected: 'deployed' },
    { merged: true, revision: MERGE_SHA, healthy: false, expected: 'deployment_pending' }
  ]) {
    const control = new CodingDeliveryControl({ taskReader: async () => [candidate],
      github: { configured: true, getPull: () => { throw new Error('Wrong repository'); } },
      productGithub: { configured: true, getPull: async number => { assert.equal(number, 211); return pull({ number, html_url: 'https://github.com/WindriderQc/AgentX-Ecosystem/pull/211', state: sample.state, merged: sample.merged, merge_commit_sha: MERGE_SHA }); }, compareCommits: async () => ({ status: 'behind' }) },
      productionReader: async () => ({ ...production(), checkoutSha: MERGE_SHA, productRevision: sample.revision, healthy: sample.healthy !== false })
    });
    const item = (await control.status()).items[0];
    assert.equal(item.stage, sample.expected);
    assert.equal(item.gate, null);
    assert.equal(item.receiptBinding, null);
  }
});

test('receipt binding stays proven or disproven after merge instead of disappearing with the gate', async () => {
  const candidate = task();
  const run = (body) => deliveryForPromotedTask({
    task: candidate, attempt: attempt(), promotion: promotionFromTask(candidate), production: production(),
    promotionReceipt: promotionReceipt(),
    github: github({ async getPull() { return pull({ merged: true, state: 'closed', merge_commit_sha: MERGE_SHA, ...(body ? { body } : {}) }); } })
  });
  const tampered = await run('receipt missing');
  assert.equal(tampered.gate, null);
  assert.deepEqual(tampered.receiptBinding, { exactPullRequest: true, exactHead: true, sealedReceipt: false });
  const sealed = await run();
  assert.deepEqual(sealed.receiptBinding, { exactPullRequest: true, exactHead: true, sealedReceipt: true });
});

test('production projection records only a valid Product image revision', () => {
  assert.equal(parseProductionState(`checkout=${HEAD_SHA}\nproductRevision=${MERGE_SHA}`).productRevision, MERGE_SHA);
  assert.equal(parseProductionState(`checkout=${HEAD_SHA}\nproductRevision=unavailable`).productRevision, undefined);
});

test('promotion receipt reads only the exact owner-only task-attempt artifact', () => {
  const command = promotionReceiptCommand('/home/agentx/.local/state/agentx/coding-promotions', '0603', 3);
  assert.match(command, /0603-attempt-3\.json/);
  assert.match(command, /stat -c %U/);
  assert.match(command, /stat -c %a/);
  assert.match(command, /"600"/);
  assert.doesNotMatch(command, /token|secret/i);
});
