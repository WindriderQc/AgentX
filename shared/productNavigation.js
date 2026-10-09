'use strict';

const { demoSurfaceDisabled } = require('./agentxRuntimeProfile');
const { productSpaces } = require('./productSpaces');

function buildProductNavigation({ service = 'core', activePage = '', publicUrls = {},
  agentxProfile = 'full', trustedRuntimeNavItems = [] } = {}) {
  const cleanBase = value => String(value || '').replace(/\/+$/, '');
  const urls = publicUrls && typeof publicUrls === 'object' ? publicUrls : {};
  // Only Core-to-Core links stay relative. Benchmark and RAG pages live under a
  // path prefix that their public URL carries, so their links always use it.
  const coreBase = service === 'core' ? '' : cleanBase(urls.core);
  const link = (owner, route) => (owner === 'core' ? coreBase : cleanBase(urls[owner])) + route;
  const retired = ['operations', 'hosts', 'cluster', 'alerts', 'dashboard', 'alert-analytics', 'hardware-matrix'];
  const effectiveActive = activePage === 'cost-tracking' ? 'analytics'
    : retired.includes(activePage) ? 'nerve-center' : activePage;
  const groups = productSpaces(link);
  const system = groups.find(group => group.secondary);
  if (agentxProfile !== 'demo' && Array.isArray(trustedRuntimeNavItems) && trustedRuntimeNavItems.length) {
    system.children.push({ section: 'External runtimes' }, ...trustedRuntimeNavItems.map(item => ({
      id: item.id, label: item.label, icon: item.icon, href: coreBase + item.href,
      external: true, owner: item.owner || null, description: item.description || null
    })));
  }
  const available = item => agentxProfile !== 'demo' || (!item.external && (
    !item.href || !item.href.startsWith(coreBase + '/') || !demoSurfaceDisabled(item.href.slice(coreBase.length))
  ));
  const navItems = groups.map(group => ({ ...group,
    href: group.entry ? link('core', agentxProfile === 'demo' ? '/playground' : group.entry) : null,
    children: group.children.filter(available).filter((child, index, all) =>
      !child.section || Boolean(all[index + 1] && !all[index + 1].section))
  })).filter(group => group.children.some(child => child.href));
  const isActive = id => id === effectiveActive;
  const isChildActive = children => children.some(child => child.id && isActive(child.id));
  const activeSpace = navItems.find(group => isChildActive(group.children));
  return { navItems, spaces: navItems.filter(group => !group.secondary), activeSpace,
    brandHref: coreBase + '/', brandTitle: 'Accueil AgentX', isActive, isChildActive };
}

module.exports = { buildProductNavigation };
