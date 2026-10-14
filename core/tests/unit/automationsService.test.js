'use strict';
const {createAutomationsService, openClawJob} = require('../../src/services/automationsService');
const {buildOpenClawCronEvidence} = require('../../integrations/runtime-bridges/openclaw/runtimeEvidence');
const stamp = '2026-10-14T12:00:00.000Z';
const native = {available: true, revision: 4, jobs: [{id: 'usage', name: 'Usage', enabled: true, schedule: {type: 'interval', minutes: 15}, nextRunAt: stamp}], history: [], historyTotal: 0, inventory: {rows: [], unavailable: []}};
const rawJobs = [
  {id: 'one', name: 'Promotion', enabled: true, agentId: null, schedule: {kind: 'cron', expr: '15 4 * * *', tz: 'America/Toronto'}, payload: {kind: 'agentTurn', message: '__openclaw_memory_core_short_term_promotion_dream__'}, lastRunError: 'private diagnostic', state: {lastRunStatus: 'error', nextRunAtMs: Date.parse(stamp)}},
  {id: 'two', name: 'Promotion', enabled: false, schedule: {kind: 'every', everyMs: 900000}, payload: {kind: 'command', argv: ['secret-command'], env: {TOKEN: 'secret-value'}}}
];
function fixture(extra = {}) {
  return createAutomationsService({operations: {status: jest.fn(async () => native)},
    readCron: async () => buildOpenClawCronEvidence({jobs: rawJobs}, {includeDisabledCron: true}),
    readBackup: () => ({enabled: true, anchor: 'cron', cron: '0 3 * * *', timezone: 'America/Toronto'}),
    readMirrors: async () => [
      {sourceId: 'oc-One name', name: 'Duplicate mirror', metadata: {scheduler: 'openclaw', originalJobId: 'one', mirrorState: 'absent-from-openclaw'}},
      {sourceId: 'oc-Retired old name', name: 'Retired', enabled: false, metadata: {scheduler: 'openclaw', originalJobId: 'retired', mirrorState: 'absent-from-openclaw'}}
    ], ...extra});
}
test('deduplicates by native identity, preserves different jobs with the same name and separates retired mirrors', async () => {
  const data = await fixture().status();
  expect(data.jobs.map(job => job.id)).toEqual(['usage', 'openclaw:one', 'openclaw:two', 'core:backup', 'openclaw:retired']);
  expect(data.jobs.filter(job => job.enabled)).toHaveLength(3);
  expect(data.jobs.at(-1)).toMatchObject({archived: true, enabled: false, state: 'archived'});
  expect(data.jobs[1]).toMatchObject({kind: 'native-core', state: 'failed'});
  expect(data.jobs[2]).toMatchObject({kind: 'command', state: 'paused'});
  expect(JSON.stringify(data)).not.toMatch(/secret-command|secret-value|private diagnostic|payload|argv/);
});
test('one unavailable owner does not hide the other sources or convert cached jobs into fresh evidence', async () => {
  let offline = false;
  const service = fixture({readCron: async () => {if (offline) throw Error('private host'); return buildOpenClawCronEvidence({jobs: rawJobs});}});
  await service.status(); offline = true;
  const data = await service.status({refresh: true});
  expect(data.available).toBe(true);
  expect(data.sources[1]).toMatchObject({available: false, stale: true});
  expect(data.jobs.some(job => job.id === 'openclaw:one')).toBe(true);
  expect(JSON.stringify(data)).not.toContain('private host');
});
test('a lost supervisor read retains its jobs and revision while disabling its controls', async () => {
  let offline = false;
  const service = fixture({operations: {status: async () => {if (offline) throw Error('offline'); return native;}}});
  await service.status(); offline = true;
  expect(await service.status()).toMatchObject({operationsAvailable: false, revision: 4,
    jobs: expect.arrayContaining([expect.objectContaining({id: 'usage'})])});
});
test('coalesces concurrent native reads and rejects an invalid page before contacting owners', async () => {
  const readCron = jest.fn(async () => buildOpenClawCronEvidence({jobs: rawJobs}));
  const service = fixture({readCron});
  await Promise.all([service.status(), service.status()]);
  expect(readCron).toHaveBeenCalledTimes(1);
  await expect(service.status({offset: -1})).rejects.toMatchObject({status: 400});
});
