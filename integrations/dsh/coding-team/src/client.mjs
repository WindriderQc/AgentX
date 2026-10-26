/** Reject credential-bearing links and protocols other than HTTPS. */
export function normalizePipelineUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || /[\u0000-\u0020]/u.test(value)) {
    throw new TypeError('Pipeline URL must be an absolute HTTPS URL');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search
      || url.pathname !== '/pipeline' || url.hash !== '#pipelineWorkerMonitor') {
    throw new TypeError('Pipeline URL must use HTTPS /pipeline#pipelineWorkerMonitor without credentials or query parameters');
  }
  return url.href;
}

/** Present Core work inside a native Studio panel; retain the full monitor link. */
export function createClientPlugin(React, pipelineUrl) {
  const href = normalizePipelineUrl(pipelineUrl);
  const label = 'AgentX Coding Team';
  const panelId = 'agentx-coding-work';
  const workUrl = new URL('/pipeline?view=studio', href).href;
  function WorkIcon({ size = 18 }) {
    return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
    React.createElement('path', { d: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16' }));
  }
  function WorkPanel() {
    return React.createElement('iframe', {
      src: workUrl, title: 'Travail des agents', 'data-agentx-coding-work': '',
      referrerPolicy: 'no-referrer',
      style: { display: 'block', width: '100%', height: '100%', minHeight: 300, border: 0 },
    });
  }
  function CodingTeamLink({ wide }) {
    const icon = React.createElement('svg', {
      width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true,
    }, React.createElement('path', { d: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16' }));
    return React.createElement('a', {
      href, target: '_blank', rel: 'noopener noreferrer',
      title: `${label} (opens in a new tab)`,
      'aria-label': `${label} (opens in a new tab)`,
      'data-agentx-coding-team': '',
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center',
        gap: 8, minHeight: 36, width: wide ? '100%' : 36, boxSizing: 'border-box',
        padding: wide ? '7px 8px' : 0, borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-label-primary)', textDecoration: 'none', font: 'inherit',
      },
    }, icon, wide ? React.createElement('span', null, label) : null);
  }
  return {
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, WorkPanel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panelId, order: 20, label: () => 'Travail des agents',
      }, WorkIcon));
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'agentx-coding-team', order: 20,
      }, CodingTeamLink));
    },
  };
}
