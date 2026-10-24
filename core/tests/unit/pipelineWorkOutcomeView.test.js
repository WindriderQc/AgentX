'use strict';
const { view } = require('../../src/services/pipelineWorkOutcomeView');
test('task closure and stored artifacts never imply deployment or outcome acceptance', () => {
  const result = view({ pipelineId: '0001', status: 'done', resolution: { kind: 'superseded' } });
  expect(result.taskRecord).toMatchObject({ status: 'done', resolution: 'superseded', provesOutcomeAcceptance: false });
  expect(result.artifacts.provesExternalDelivery).toBe(false);
  expect(result.publication).toBeNull(); expect(result.deployment.state).toBe('not_observed_here');
  expect(result.acceptance.state).toBe('not_inferred');
});
test('merge and CI observations require the exact stored publication head', () => {
  const head = 'a'.repeat(40), task = { pipelineId: '0001', status: 'review', codingAutonomy: {
    pr: { repository: 'example/project', number: 3, head },
    delivery: { head, headMatches: true, merged: true, ci: 'success', state: 'closed', observedAt: '2026-01-01T00:00:00Z' } } };
  expect(view(task).publication.observation).toMatchObject({ merged: true, ci: 'success' });
  task.codingAutonomy.delivery.head = 'b'.repeat(40);
  expect(view(task).publication).toMatchObject({ observation: null, unassociatedObservation: true });
  task.codingAutonomy.pr.repository = 'javascript:bad';
  expect(view(task).publication).toBeNull();
});
