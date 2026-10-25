'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callSecretaryTool, mergeTools, secretaryMcpMiddleware, SECRETARY_TOOLS } = require('../secretary-mcp');
const { readJanitorReportView, diskxLink } = require('../../../src/services/janitorReportView');

const now = new Date('2026-10-25T12:00:00Z');
const SHA = 'c'.repeat(64);
const REPORT_QUERY = 'report=' + encodeURIComponent('2026-10-25T09:00:00.000Z');
const STRATEGY = '/api/v1/janitor/profiles/shared-drive/strategy/latest';
const ok = (body) => ({ response: { ok: true, status: 200 }, body });

// A synthetic stored strategy report, as Data answers it. Paths are fixtures.
const report = {
  status: 'success',
  data: {
    report: {
      generatedAt: '2026-10-25T09:00:00Z',
      status: 'ready_for_policy_review',
      scope: { canonicalRoots: ['/srv/lake', '/srv/media'] },
      evidence: {
        verifiedDuplicateGroups: 42, verifiedDuplicateFiles: 97, provenSavingsBytes: 5 * 1024 ** 3,
        duplicateCandidates: { groups: 300, files: 800 },
        verifiedDuplicateEvidence: [{ sha256: SHA, paths: ['/srv/lake/secret/report.pdf'] }]
      },
      maintenance: { proposals: [{}, {}], executableActions: [] },
      decisions_required: [{ id: 'backupRetention' }],
      policy: { duplicateSurvivor: 'canonical_active', maintenanceAuthorization: 'explicit_per_action' },
      safety: { sharedDriveMutations: 0 }
    }
  }
};

function fakeData({ strategy = () => ok(report), groups, calls = [] } = {}) {
  return async (route, options = {}) => {
    calls.push({ route, query: options.query || '', method: options.method || 'GET' });
    if (route === STRATEGY) return strategy();
    if (route === `${STRATEGY}/groups`) return groups ? groups(options.query) : assert.fail('no group read expected');
    throw new Error(`unexpected route ${route}`);
  };
}

test('janitor_report_view is a read-only, owner-relayed tool with one optional group', () => {
  const tool = SECRETARY_TOOLS.find((item) => item.name === 'janitor_report_view');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['group']);
  assert.deepEqual(tool.inputSchema.required, []);
  assert.match(tool.description, /never an authorization/);
  assert.match(tool.description, /logical bytes: the physical space freed is not measured/);
  assert.match(tool.description, /never scans, runs or generates a report, approves, moves or deletes anything/);
  assert.match(tool.description, /Read-only\.$/);
});

test('the summary gives counts, logical savings, status and the DiskX link, and no path', async () => {
  const calls = [];
  const result = await readJanitorReportView({}, { fetchData: fakeData({ calls }), now: () => now, env: { CORE_PUBLIC_URL: 'https://agentx.lan' } });
  assert.equal(result.available, true);
  assert.equal(result.status, 'ready_for_policy_review');
  assert.equal(result.ageMs, 3 * 3600000);
  assert.deepEqual(result.counts, { verifiedGroups: 42, verifiedFiles: 97, candidateGroups: 300, executableActions: 0, decisionsRequired: 1, sharedDriveMutations: 0 });
  assert.equal(result.provenSavingsBytes, 5 * 1024 ** 3);
  assert.equal(result.provenSavingsLabel, '5,00 Go');
  assert.equal(result.bytesKind, 'logical');
  assert.equal(result.physicalSpaceMeasured, false);
  assert.equal(result.survivorRule, 'canonical_active');
  assert.equal(result.survivorRuleAuthorizes, false);
  assert.equal(result.link, 'https://agentx.lan/diskx?janitor=latest&' + REPORT_QUERY);
  assert.equal(result.readOnly, true);
  assert.match(result.summary, /42 groupes de doublons vérifiés par SHA-256, 97 fichiers, 5,00 Go d’économie logique prouvée/);
  assert.match(result.summary, /0 action\(s\) exécutable\(s\), 1 décision\(s\)/);
  assert.match(result.summary, /ce n’est pas une autorisation/);
  assert.match(result.summary, /l’espace physique libéré n’est pas mesuré/);
  assert.equal(result.notes.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /\/srv\//, 'no root or file path leaves the tool');
  assert.deepEqual(calls.map((call) => [call.route, call.method]), [[STRATEGY, 'GET']]);
});

test('a named group adds its copy count and opens DiskX on it; an unknown group says so', async () => {
  const calls = [];
  const groups = (query) => ok({ status: 'success', data: { report: { generatedAt: '2026-10-25T09:00:00Z' }, groups: query === `sha256=${SHA}`
    ? [{ sha256: SHA, count: 3, provenSavingsBytes: 2048, files: [{ path: '/srv/lake/a' }] }] : [] } });
  const found = await readJanitorReportView({ group: SHA.toUpperCase() }, { fetchData: fakeData({ groups, calls }), now: () => now, env: {} });
  assert.deepEqual(found.group, { sha256: SHA, found: true, copies: 3, provenSavingsBytes: 2048, provenSavingsLabel: '2,00 Ko' });
  assert.equal(found.link, `/diskx?janitor=latest&group=${SHA}&${REPORT_QUERY}`);
  assert.match(found.summary, /Groupe cccccccccccc… : 3 copies, 2,00 Ko logiques/);
  assert.doesNotMatch(JSON.stringify(found), /\/srv\//);
  assert.ok(calls.every((call) => call.method === 'GET'));

  const other = 'd'.repeat(64);
  const missing = await readJanitorReportView({ group: other }, { fetchData: fakeData({ groups }), now: () => now, env: {} });
  assert.deepEqual(missing.group, { sha256: other, found: false });
  assert.equal(missing.link, '/diskx?janitor=latest&' + REPORT_QUERY);
  assert.match(missing.summary, /n’est pas dans le dernier rapport/);
});

test('no report yet, Data down and refused arguments are said as such', async () => {
  const empty = await readJanitorReportView({}, { fetchData: fakeData({ strategy: () => ({ response: { ok: false, status: 404 }, body: {} }) }), now: () => now });
  assert.equal(empty.available, false);
  assert.equal(empty.link, null);
  assert.equal(empty.summary, 'Aucun rapport Janitor n’est encore disponible.');

  await assert.rejects(readJanitorReportView({}, { fetchData: async () => { throw new Error('ECONNREFUSED'); } }), { code: 'DATA_UNAVAILABLE' });
  await assert.rejects(readJanitorReportView({}, { fetchData: fakeData({ strategy: () => ({ response: { ok: false, status: 502 }, body: {} }) }) }), { code: 'DATA_UNAVAILABLE' });
  for (const args of [{ group: 'xyz' }, { group: SHA, approve: true }, ['x']]) {
    const result = await callSecretaryTool('janitor_report_view', args, { janitorReportView: (input) => readJanitorReportView(input, { fetchData: async () => assert.fail('no read') }) });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.structuredContent.error, 'INVALID_ARGUMENTS');
  }
});

test('the DiskX link stays a Core path unless CORE_PUBLIC_URL is a clean http(s) address', () => {
  assert.equal(diskxLink({}, {}), '/diskx?janitor=latest');
  assert.equal(diskxLink({ group: SHA }, { CORE_PUBLIC_URL: 'https://agentx.lan/' }), `https://agentx.lan/diskx?janitor=latest&group=${SHA}`);
  assert.equal(diskxLink({}, { CORE_PUBLIC_URL: 'https://user:pw@agentx.lan' }), '/diskx?janitor=latest');
  assert.equal(diskxLink({}, { CORE_PUBLIC_URL: 'javascript:alert(1)' }), '/diskx?janitor=latest');
});

test('the tool is answered for the owner relay but never listed to MCP clients', async () => {
  const listed = mergeTools({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'check_health' }] } }).result.tools.map((tool) => tool.name);
  assert.equal(listed.includes('janitor_report_view'), false);

  let answer;
  const res = { json(body) { answer = body; } };
  await secretaryMcpMiddleware({ janitorReportView: (input) => readJanitorReportView(input, { fetchData: fakeData(), now: () => now, env: {} }) })(
    { method: 'POST', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'janitor_report_view', arguments: {} } } },
    res, () => assert.fail('the secretary middleware answers it'));
  assert.equal(answer.result.isError, false);
  assert.equal(answer.result.structuredContent.link, '/diskx?janitor=latest&' + REPORT_QUERY);
});
