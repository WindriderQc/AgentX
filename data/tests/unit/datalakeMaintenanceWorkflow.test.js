const workflow = require('../../scripts/datalake-maintenance-workflow');

function baseOptions(overrides = {}) {
  return {
    ...workflow.parseArgs([
      '--base-url', 'http://core.local/api/data',
      '--root', '/mnt/datalake/RAG',
      '--output-dir', 'C:/tmp/reports',
      '--timeout-ms', '1000'
    ]),
    ...overrides
  };
}

function makeRequestMock() {
  return jest.fn(async (_baseUrl, route, options = {}) => {
    if (route === '/janitor/profiles' && !options.method) return { profiles: [] };
    if (route === '/janitor/profiles' && options.method === 'POST') {
      return { profile: { _id: 'profile-1', name: options.body.name } };
    }
    if (route === '/janitor/profiles/profile-1/run' && options.method === 'POST') {
      return { run_id: 'run-1' };
    }
    if (route === '/janitor/profiles/runs/run-1') {
      return {
        run: {
          status: 'complete',
          proposed_actions: [{
            policy: 'delete_duplicates',
            reason: 'same sha256 as /mnt/datalake/RAG/keep.bin',
            files: ['/mnt/datalake/RAG/delete.bin'],
            space_saved: 1234,
            status: 'pending'
          }]
        }
      };
    }
    if (route.startsWith('/storage/summary?root=')) {
      return {
        totalFiles: 431, totalSize: 64000000, totalSizeFormatted: '61.04 MB',
        hashCoverageFiles: 1, hashCoverageBytes: 1, hashedFiles: 431, hashedBytes: 64000000,
        lastScan: { id: 'scan-1', status: 'complete' }
      };
    }
    if (route.startsWith('/storage/files/tree')) {
      return { tree: [{ path: '/mnt/datalake/RAG', fileCount: 47, totalSizeFormatted: '61.34 MB' }] };
    }
    if (route.startsWith('/storage/files/browse')) {
      return { files: [{ path: '/mnt/datalake/RAG/files_full_optimized.json.md', size: 31530000 }] };
    }
    if (route.startsWith('/storage/files/stats?root=')) return { byExtension: [], byCategory: [], total: {} };
    if (route.startsWith('/storage/files/duplicates')) {
      return { method: 'sha256', summary: { totalDuplicateGroups: 1, totalWastedSpace: 1234 }, duplicates: [] };
    }
    if (route.startsWith('/storage/files/cleanup-recommendations?root=')) {
      return { recommendations: [{ type: 'duplicates', priority: 'high', message: 'Found duplicate groups', potentialSavings: 1234 }] };
    }
    if (route === '/janitor/policies') return { policies: [{ id: 'delete_duplicates' }] };
    if (route === '/janitor/suggest' && options.method === 'POST') {
      return {
        suggestions_count: 1,
        total_space_saved: 1234,
        policies_applied: ['delete_duplicates'],
        suggestions: [{
          policy: 'delete_duplicates',
          reason: 'duplicate hash',
          files: ['/mnt/datalake/RAG/delete.bin'],
          space_saved: 1234
        }]
      };
    }
    throw new Error(`unexpected route: ${route}`);
  });
}

describe('datalake maintenance workflow', () => {
  test('JSON retains all received suggestions while Markdown declares its overview and AI sample', () => {
    const coverage = { actions: { included: 50, available: 70 }, fileEntries: { included: 250, available: 700 }, selection: 'First 50 actions.' };
    const report = workflow.buildReport({ options: baseOptions(), generatedAt: '2026-10-06T00:00:00Z',
      collected: { janitorSuggest: { ok: true, data: { suggestions: Array.from({ length: 30 }, (_, i) => ({
        policy: `suggestion-${i}`, files: [`/synthetic/${i}.txt`], space_saved: i
      })) } } },
      profileRun: { run_id: 'run-1', run: { proposed_actions: [], ai_triage: { outcome: 'completed', coverage } } }
    });
    expect(report.proposals).toHaveLength(30);
    expect(report.proposals[0].type).toBe('suggestion-29');
    expect(report.proposals.at(-1).type).toBe('suggestion-0');
    const markdown = workflow.markdownReport(report);
    expect(markdown).toContain('Showing 25 of 30 proposals');
    expect(markdown).toContain('50/70 actions and 250/700 file entries submitted');
    expect(markdown).toContain('JSON report retains the complete received proposal list');
  });

  test('parseArgs keeps the default profile proposal-only and unscheduled', () => {
    const options = workflow.parseArgs([
      '--root', '/mnt/datalake/RAG',
      '--profile-run-id', 'run-1',
      '--run-profile',
      '--no-hashes',
      '--tree-limit', '3'
    ]);

    expect(options.ensureProfile).toBe(true);
    expect(options.runProfile).toBe(true);
    expect(options.profileRunId).toBe('run-1');
    expect(options.computeHashes).toBe(false);
    expect(options.treeLimit).toBe(3);
  });

  test('runWorkflow only calls read/proposal endpoints and writes proposal-only reports', async () => {
    const requestJson = makeRequestMock();
    const writeFile = jest.fn(async () => {});
    const mkdir = jest.fn(async () => {});

    const result = await workflow.runWorkflow(baseOptions({ runProfile: true, liveSample: true }), {
      requestJson,
      writeFile,
      mkdir,
      now: () => '2026-07-03T15:00:00.000Z'
    });

    const calledRoutes = requestJson.mock.calls.map(call => call[1]);
    expect(calledRoutes).toContain('/janitor/profiles');
    expect(calledRoutes).toContain('/janitor/profiles/profile-1/run');
    expect(calledRoutes).toContain('/janitor/profiles/runs/run-1');
    expect(calledRoutes).toContain('/janitor/suggest');
    expect(calledRoutes.some(route => /approve|execute|dedup-approve|confirm-deletion/.test(route))).toBe(false);

    const createCall = requestJson.mock.calls.find(call => call[1] === '/janitor/profiles' && call[2].method === 'POST');
    expect(createCall[2].body).toMatchObject({
      roots: ['/mnt/datalake/RAG'],
      policies: ['delete_duplicates'],
      schedule: null,
      aiTriage: false,
      hashMode: 'candidates'
    });

    expect(result.report.safety).toMatchObject({
      destructiveRequestsMade: 0,
      deleteMoveArchiveExecuted: false,
      approvalEndpointsCalled: false,
      scheduleEnabled: false
    });
    expect(result.report.profile.run.proposedActionCount).toBe(1);
    expect(result.report.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'janitor.profile-run', approvalStatus: 'pending' }),
        expect.objectContaining({ source: 'janitor.suggest', approvalStatus: 'not_approved' })
      ])
    );

    const serializedReport = JSON.stringify(result.report);
    expect(serializedReport).not.toContain('confirmationToken');
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[0][1]).not.toContain('confirmationToken');
    expect(writeFile.mock.calls[1][1]).not.toContain('Confirmation token');
  });

  test('runWorkflow can attach an existing profile run without starting another one', async () => {
    const requestJson = makeRequestMock();

    const result = await workflow.runWorkflow(baseOptions({
      ensureProfile: false,
      profileRunId: 'run-1'
    }), {
      requestJson,
      writeFile: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      now: () => '2026-07-03T15:05:00.000Z'
    });

    const calledRoutes = requestJson.mock.calls.map(call => call[1]);
    expect(calledRoutes).toContain('/janitor/profiles/runs/run-1');
    expect(calledRoutes).not.toContain('/janitor/profiles/profile-1/run');
    expect(result.report.profile).toMatchObject({
      action: 'existing_run',
      run: { run_id: 'run-1', status: 'complete', proposedActionCount: 1 }
    });
    expect(result.report.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'janitor.profile-run', approvalStatus: 'pending' })
      ])
    );
  });

  test('default assessment skips the capped live filesystem sample', async () => {
    const requestJson = makeRequestMock();
    const result = await workflow.runWorkflow(baseOptions({ ensureProfile: false }), {
      requestJson,
      writeFile: jest.fn(async () => {}),
      mkdir: jest.fn(async () => {}),
      now: () => '2026-07-03T15:10:00.000Z'
    });

    expect(requestJson.mock.calls.map(call => call[1])).not.toContain('/janitor/suggest');
    expect(result.report.riskNotes).toEqual(expect.arrayContaining([
      expect.stringContaining('intentionally skipped')
    ]));
  });
});
