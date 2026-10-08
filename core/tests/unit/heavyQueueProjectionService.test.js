const { getHeavyQueue, parseHeavyQueue } = require('../../src/services/heavyQueueProjectionService');

test('projects running and waiting jobs without session identifiers or notes', () => {
  const markdown = `# QUEUE.md
## Running
| Priority | Job | Owner (session) | Hosts | Estimated | Started | Notes |
|---|---|---|---|---|---|---|
| 3 | Image batch | private-session-id | Host A | 30 min | 00:48 | private operator note |
## Waiting
| Priority | Job | Owner (session) | Hosts | Estimated | Not before | Notes |
|---|---|---|---|---|---|---|
| 1 | Benchmark run | another-private-id | Host B | 2 h | 02:00 | secret note |
## Done
| 1 | Completed job | session | Host B | 1 h | 01:00 | private note |
`;
  const projection = parseHeavyQueue(markdown);
  expect(projection).toEqual({
    running: [{ priority: 3, job: 'Image batch', hosts: 'Host A', estimated: '30 min', timing: '00:48' }],
    waiting: [{ priority: 1, job: 'Benchmark run', hosts: 'Host B', estimated: '2 h', timing: '02:00' }]
  });
  expect(JSON.stringify(projection)).not.toMatch(/private|session|secret|Completed/);
});

test('reports an unmounted queue as unavailable', async () => {
  const projection = await getHeavyQueue('/does-not-exist/QUEUE.md');
  expect(projection).toMatchObject({ available: false, running: [], waiting: [] });
});
