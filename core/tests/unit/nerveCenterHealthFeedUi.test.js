const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-health.js'), 'utf8');
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function render(events, meta = {}) {
  const body = { innerHTML: '' };
  const window = {
    NerveCenterShared: {
      fetchJson: async url => (url.startsWith('/api/nerve-center/health/feed') ? { data: events, meta } : null),
      escapeHtml, timeAgo: () => '1m ago',
      renderSectionLoading() {}, renderSectionError(_b, message) { throw new Error(message); }, finishSectionLoad() {}
    }
  };
  vm.runInNewContext(source, { window, document: { getElementById: () => body }, console });
  await window.NerveCenterHealth.loadHealth();
  return body.innerHTML;
}

describe('Nerve Center alert feed', () => {
  test('puts alerts that need action first and folds completed receipts and history', async () => {
    const html = await render([
      { type: 'alert', status: 'active', severity: 'info', title: 'Job A — completed', source: 'heavy-work-queue' },
      { type: 'alert', status: 'active', severity: 'warning', title: 'Job B — failed', source: 'heavy-work-queue' },
      { type: 'event', status: 'resolved', severity: 'info', title: 'Old event', source: 'core' }
    ], { activeAlertCount: 213 });

    expect(html).toContain('1 alert needs action');
    expect(html).toContain('213 active alerts in total, receipts included');
    const folded = html.indexOf('<details class="nc-feed-folded">');
    expect(folded).toBeGreaterThan(html.indexOf('Job B — failed'));
    expect(html.indexOf('Job A — completed')).toBeGreaterThan(folded);
    expect(html).toContain('Completed receipts and history (2)');
    expect(html).not.toContain('Self-Healing');
  });

  test('says when nothing needs action', async () => {
    const html = await render([{ type: 'alert', status: 'active', severity: 'info', title: 'Done' }]);
    expect(html).toContain('Nothing needs action');
  });
});
