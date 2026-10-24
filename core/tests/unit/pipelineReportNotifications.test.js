'use strict';

jest.mock('../../models/Alert', () => ({ updateOne: jest.fn(async () => ({ acknowledged: true })) }));
const Alert = require('../../models/Alert');
const notifications = require('../../src/services/pipelineReportNotifications');
const ui = require('../../public/js/pipeline-report-continuation');

beforeEach(() => { jest.clearAllMocks(); notifications._forget(); });

describe('private report alerts', () => {
  it('writes one stable alert per outcome and kind, with a plain message and a link to the task', async () => {
    const id = await notifications.publish({ pipelineId: '0939' }, 'documents_blocked', 'r1', { paths: ['docs/A.md', 'docs/B.md'] });
    expect(id).toBe(notifications.alertId('pipeline-report:0939:r1:documents_blocked'));
    const [query, update, options] = Alert.updateOne.mock.calls[0];
    expect(query).toEqual({ _id: id });
    expect(update.$setOnInsert).toMatchObject({ ruleId: 'pipeline_report', severity: 'warning', status: 'active',
      title: 'Report documents blocked — task 0939',
      message: '2 documents failed two review steps and need attention: docs/A.md, docs/B.md.' });
    expect(update.$setOnInsert.context.additionalData).toMatchObject({ pipelineId: '0939', requestId: 'r1', path: '/pipeline?task=0939' });
    expect(options.upsert).toBe(true);
    await notifications.publish({ pipelineId: '0939' }, 'documents_blocked', 'r1', { paths: ['docs/A.md'] });
    expect(Alert.updateOne).toHaveBeenCalledTimes(1);
  });

  it('explains why a report waits and ignores unknown kinds', async () => {
    await notifications.publish({ pipelineId: '0939' }, 'needs_grant', 'r2', { reason: 'campaign_window_closed' });
    expect(Alert.updateOne.mock.calls[0][1].$setOnInsert.message)
      .toBe('The approved campaign window is not open. Grant more or approve a window to continue the saved report.');
    expect(await notifications.publish({ pipelineId: '0939' }, 'invented', 'r3')).toBeNull();
  });
});

describe('continuation switch display', () => {
  it('states the switch, the active continuation and an unavailable runner plainly', () => {
    expect(ui.statusText({ enabled: false, available: true, active: null })).toBe('Global chaining off; task-specific agreements still apply · nothing in progress');
    expect(ui.statusText({ enabled: true, available: true, active: { pipelineId: '0939', requestId: 'abc' } }))
      .toBe('Global chaining on · continuing task 0939 (request abc)');
    expect(ui.statusText({ enabled: true, available: false, active: null })).toContain('the coding runner is unavailable');
  });
});
