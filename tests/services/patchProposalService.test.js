const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const SpecialX = require('../../models/SpecialX');
const AutomationTask = require('../../models/AutomationTask');
const AutomationRun = require('../../models/AutomationRun');
const PatchProposal = require('../../models/PatchProposal');
const { getAutomationRunnerService } = require('../../src/services/automationRunnerService');

jest.mock('../../src/services/modelRouter', () => ({
  routeRequest: jest.fn(async () => ({
    model: 'llama3.1',
    target: 'local',
    taskType: 'analysis'
  }))
}));

jest.mock('../../src/services/chatService', () => ({
  handleChatRequest: jest.fn(async () => ({
    response: '# Guide\n\nUpdated guidance from proposal.\n'
  }))
}));

const {
  applyPatchProposalTask,
  approvePatchProposal,
  expirePendingPatchProposalsTask,
  runPatchProposalTask
} = require('../../src/services/patchProposalService');

async function seedDocsDriftRun(repoPath, finding) {
  const task = await AutomationTask.create({
    type: 'docs_drift_check',
    status: 'completed',
    input: { repoPath },
    completedAt: new Date()
  });

  const run = await AutomationRun.create({
    taskId: task._id,
    workerId: 'test-worker',
    status: 'completed',
    output: {
      repoPath,
      newFindings: [finding],
      resolvedFindings: [],
      unchanged: 0
    },
    artifacts: [{
      name: 'docs_drift_snapshot',
      kind: 'json',
      content: {
        repoPath,
        findings: [finding]
      }
    }],
    finishedAt: new Date()
  });

  await AutomationTask.updateOne(
    { _id: task._id },
    { $set: { resultRunId: run._id } }
  );

  return task;
}

describe('patchProposalService', () => {
  const service = getAutomationRunnerService();
  let tempRepo = null;

  beforeEach(async () => {
    await Promise.all([
      SpecialX.deleteMany({}),
      AutomationTask.deleteMany({}),
      AutomationRun.deleteMany({}),
      PatchProposal.deleteMany({})
    ]);

    tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-proposals-'));
  });

  afterEach(async () => {
    if (tempRepo) {
      await fs.rm(tempRepo, { recursive: true, force: true });
      tempRepo = null;
    }
  });

  afterAll(() => {
    service.stop();
  });

  test('creates pending patch proposals from docs drift findings', async () => {
    const docsDir = path.join(tempRepo, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n\nOld guidance.\n', 'utf8');

    const finding = {
      key: 'finding-guide-1',
      type: 'doc_staleness',
      title: 'Guide is stale',
      path: 'docs/guide.md',
      evidence: 'References old workflow names.',
      metadata: { section: 'overview' }
    };

    const docsDriftTask = await seedDocsDriftRun(tempRepo, finding);
    const patchTask = await AutomationTask.create({
      type: 'patch_proposal',
      input: {
        repoPath: tempRepo,
        docsDriftTaskId: docsDriftTask._id
      }
    });
    const specialX = await SpecialX.ensureDefaultOperator();

    const result = await runPatchProposalTask(patchTask, specialX);

    expect(result.output.proposalsCreated).toBe(1);
    const proposal = await PatchProposal.findOne({ sourceTaskId: patchTask._id }).lean();
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe('pending');
    expect(proposal.targetFile).toBe('docs/guide.md');
    expect(proposal.proposedContent).toContain('Updated guidance from proposal.');
  });

  test('approves and applies a proposal by enqueuing patch_apply', async () => {
    const docsDir = path.join(tempRepo, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    const targetPath = path.join(docsDir, 'guide.md');
    await fs.writeFile(targetPath, '# Guide\n\nOriginal content.\n', 'utf8');

    const sourceTask = await AutomationTask.create({
      type: 'patch_proposal',
      input: { repoPath: tempRepo }
    });

    const proposal = await PatchProposal.create({
      sourceTaskId: sourceTask._id,
      findingKey: 'finding-guide-apply',
      findingSnapshot: { title: 'Guide is stale', path: 'docs/guide.md' },
      repoPath: tempRepo,
      targetFile: 'docs/guide.md',
      originalContent: '# Guide\n\nOriginal content.\n',
      proposedContent: '# Guide\n\nApproved replacement.\n',
      diffSummary: 'Update guide',
      blastRadius: 'docs_only',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });

    const approval = await approvePatchProposal(proposal._id, {
      actorSource: 'console',
      actorUserId: 'architect'
    });

    expect(approval.applyTask).toBeTruthy();
    expect(approval.applyTask.type).toBe('patch_apply');

    const approvedProposal = await PatchProposal.findById(proposal._id).lean();
    expect(approvedProposal.status).toBe('approved');
    expect(approvedProposal.applyTaskId).toBeTruthy();

    const applyResult = await applyPatchProposalTask(approval.applyTask);
    expect(applyResult.summary).toContain('Applied patch proposal');

    const appliedProposal = await PatchProposal.findById(proposal._id).lean();
    const updatedContent = await fs.readFile(targetPath, 'utf8');
    expect(appliedProposal.status).toBe('applied');
    expect(updatedContent).toBe('# Guide\n\nApproved replacement.\n');
  });

  test('expires only pending proposals during sweep', async () => {
    const sourceTask = await AutomationTask.create({
      type: 'patch_proposal',
      input: { repoPath: tempRepo }
    });

    await PatchProposal.create([
      {
        sourceTaskId: sourceTask._id,
        findingKey: 'expired-pending',
        repoPath: tempRepo,
        targetFile: 'docs/expired.md',
        proposedContent: '# Expired',
        diffSummary: 'Expired',
        blastRadius: 'docs_only',
        status: 'pending',
        expiresAt: new Date(Date.now() - 60 * 1000)
      },
      {
        sourceTaskId: sourceTask._id,
        findingKey: 'approved-still-approved',
        repoPath: tempRepo,
        targetFile: 'docs/approved.md',
        proposedContent: '# Approved',
        diffSummary: 'Approved',
        blastRadius: 'docs_only',
        status: 'approved',
        expiresAt: new Date(Date.now() - 60 * 1000)
      }
    ]);

    const result = await expirePendingPatchProposalsTask({ workspaceId: null });

    expect(result.output.expiredCount).toBe(1);
    const proposals = await PatchProposal.find({}).sort({ targetFile: 1 }).lean();
    expect(proposals[0].status).toBe('approved');
    expect(proposals[1].status).toBe('expired');
  });
});
