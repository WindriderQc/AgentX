'use strict';
const { buildProductNavigation } = require('./productNavigation');

// Menu pages and contextual destinations retain their existing native owner.
function screenDestinations(options = {}) {
  const { navItems } = buildProductNavigation(options);
  const pages = navItems.flatMap(group => group.children).filter(item => item.href && !item.action);
  if (options.publicUrls?.benchmark) pages.push({ id: 'benchmark-setup', label: 'Benchmark setup', href: options.publicUrls.benchmark.replace(/\/+$/, '') + '/setup' });
  const core = String(options.publicUrls?.core || '').replace(/\/+$/, '');
  const contextual = options.agentxProfile === 'demo' ? [] : [
    { id: 'dad-people', label: 'Personnes', href: '/dad/people' },
    { id: 'images-guide', label: 'Image guide', href: '/images/guide' },
    { id: 'voice-devices', label: 'Voice devices', href: '/voice-lab/devices' },
    { id: 'voice-personas', label: 'Voice personalities', href: '/voice-lab/personas' }
  ];
  return [{ id: 'home', label: 'AgentX', href: '/' }, ...pages, ...contextual]
    .filter(item => !item.href.startsWith('/api/') || item.external)
    .map(item => {
      let href = item.href, sameOrigin = href.startsWith('/') && !href.startsWith('//');
      try {
        if (!sameOrigin && core && new URL(href).origin === new URL(core).origin) {
          const url = new URL(href); href = url.pathname + url.search + url.hash; sameOrigin = true;
        }
      } catch { /* Unreachable or separate-origin service: link only. */ }
      const conversation = ['dad', 'panel', 'kids', 'lecture', 'psyx', 'playground', 'voice-lab'].includes(item.id);
      return { id: item.id, label: item.label, href, ...(conversation && { conversation: true }),
        // Another conversation must not duplicate the microphone and greeting.
        mode: sameOrigin && !item.external && !conversation ? 'frame' : 'link' };
    });
}
module.exports = { screenDestinations };
