const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { buildProductNavigation } = require('../../../shared/productNavigation');
const { normalizeTrustedRuntimeNavItems } = require('../../src/extensions/trustedRuntimeNavigation');

const navPath = path.join(__dirname, '../../views/partials/nav.ejs');
const portalPath = path.join(__dirname, '../../views/pages/home.ejs');
// One address: Benchmark and RAG public URLs carry their path prefix.
const publicUrls = {
  core: 'https://core.example',
  benchmark: 'https://core.example/benchmark',
  rag: 'https://core.example/rag',
  data: 'http://data.example:4183',
};

async function renderNav(service, agentxProfile = 'full', activePage = 'nerve-center', trustedRuntimeNavItems = []) {
  return ejs.renderFile(navPath, {
    buildProductNavigation,
    service,
    activePage,
    agentxProfile,
    publicUrls,
    reqHost: 'wrong-host.example',
    trustedRuntimeNavItems,
  });
}

function hrefFor(html, label) {
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  return anchors.find((match) => match[2].replace(/<[^>]+>/g, ' ').includes(label))?.[1];
}

describe('shared navigation public URL contract', () => {
  test('Core stays relative while cross-service links use configured authority', async () => {
    const html = await renderNav('core');
    expect(hrefFor(html, 'Chat')).toBe('/playground');
    expect(hrefFor(html, 'Nerve Center')).toBe('/nerve-center');
    expect(hrefFor(html, 'Agent Ops')).toBe('/agent-ops');
    expect(hrefFor(html, 'Compare models')).toBe('https://core.example/benchmark/');
    expect(hrefFor(html, 'Knowledge overview')).toBe('https://core.example/rag/');
    expect(new URL(hrefFor(html, 'Nerve Center'), 'https://192.0.2.99').href)
      .toBe('https://192.0.2.99/nerve-center');
    expect(html).not.toContain('wrong-host.example');
  });

  test('Benchmark links its own pages through its public URL and its Nerve Center hop uses configured Core', async () => {
    const html = await renderNav('benchmark');
    expect(hrefFor(html, 'Chat')).toBe('https://core.example/playground');
    expect(hrefFor(html, 'Compare models')).toBe('https://core.example/benchmark/');
    expect(hrefFor(html, 'Leaderboard')).toBe('https://core.example/benchmark/leaderboard');
    expect(hrefFor(html, 'Nerve Center')).toBe('https://core.example/nerve-center');
    expect(hrefFor(html, 'Knowledge overview')).toBe('https://core.example/rag/');
  });

  test('RAG links its own pages through its public URL and its Nerve Center hop uses configured Core', async () => {
    const html = await renderNav('rag');
    expect(hrefFor(html, 'Knowledge overview')).toBe('https://core.example/rag/');
    expect(hrefFor(html, 'Nerve Center')).toBe('https://core.example/nerve-center');
    expect(hrefFor(html, 'Compare models')).toBe('https://core.example/benchmark/');
  });

  test('Benchmark and RAG links are the same on every service', async () => {
    const serviceLinks = html => [...html.matchAll(/href="(https:\/\/core\.example\/(?:benchmark|rag)\/[^"]*)"/g)].map(match => match[1]);
    const core = serviceLinks(await renderNav('core'));
    expect(core).toHaveLength(11);
    expect(serviceLinks(await renderNav('benchmark'))).toEqual(core);
    expect(serviceLinks(await renderNav('rag'))).toEqual(core);
  });

  test('every profile returns to the same canonical home on Core', async () => {
    expect(hrefFor(await renderNav('core', 'demo'), 'AgentX')).toBe('/');
    expect(hrefFor(await renderNav('benchmark', 'demo'), 'AgentX')).toBe('https://core.example/');
    expect(hrefFor(await renderNav('core', 'full'), 'AgentX')).toBe('/');
  });

  test('full navigation groups surfaces by use, with one secondary system door', () => {
    const full = buildProductNavigation({ publicUrls, activePage: 'finance' });
    expect(full.spaces.map(space => space.label)).toEqual(['Personnel', 'Famille', 'Atelier']);
    expect(full.spaces.map(space => space.href)).toEqual(['/dad', '/panel', '/pipeline']);
    expect(full.activeSpace.id).toBe('personal-group');
    expect(full.navItems.filter(space => space.secondary).map(space => space.label)).toEqual(['Système']);
    expect(buildProductNavigation({ activePage: 'kids-sounds' }).activeSpace.id).toBe('family-group');
    expect(buildProductNavigation({ service: 'rag', activePage: 'rag-upload' }).activeSpace.id).toBe('workshop-group');
  });

  test('demo filters private spaces and destinations while keeping the workshop entry', () => {
    const demo = buildProductNavigation({ agentxProfile: 'demo', publicUrls });
    expect(demo.spaces.map(space => space.label)).toEqual(['Atelier']);
    expect(demo.spaces[0].href).toBe('/playground');
    const destinations = demo.navItems.flatMap(group => group.children).map(item => item.href);
    for (const route of ['/dad', '/panel', '/finance', '/psyx', '/pipeline', '/data-toolbox']) {
      expect(destinations).not.toContain(route);
    }
  });

  test('household review has one direct LAN entry in Family across all services', async () => {
    const navigation = buildProductNavigation({ activePage: 'dad-family' });
    expect(navigation.activeSpace.id).toBe('family-group');
    expect(navigation.navItems.flatMap(group => group.children).filter(item => item.id === 'dad-family')).toHaveLength(1);
    for (const service of ['core', 'benchmark', 'rag']) {
      const html = await renderNav(service, 'full', 'dad-family');
      const destination = (service === 'core' ? '' : publicUrls.core) + '/dad/family';
      expect(hrefFor(html, 'Suivi familial')).toBe(destination);
      const anchor = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].find(match => match[0].includes('Suivi familial'))[0];
      expect(anchor).not.toContain('data-access="adult"');
      expect(anchor).toContain('aria-current="page"');
      expect(html).not.toContain('Suivi des lectures');
      expect(html).not.toContain('Espace parents');
      expect(hrefFor(await renderNav(service, 'demo'), 'Suivi familial')).toBeUndefined();
    }
  });

  test('Chat stays directly reachable in the Atelier menu in both profiles', async () => {
    for (const profile of ['full', 'demo']) {
      const html = await renderNav('core', profile, 'playground');
      expect(hrefFor(html, 'Chat')).toBe('/playground');
      expect(html).toMatch(/href="\/playground" class="dropdown-item active"[\s\S]*?aria-current="page"/);
      expect(html).not.toContain('/harnesses');
    }
  });

  test('composed surfaces stay reachable across services and remain excluded from demo', async () => {
    const surfaces = { Nestor: '/dad', 'Avec Nestor': '/panel', PsyX: '/psyx', Finance: '/finance', 'Data Toolbox': '/data-toolbox' };
    for (const service of ['core', 'benchmark', 'rag']) {
      const full = await renderNav(service);
      const demo = await renderNav(service, 'demo', 'playground');
      for (const [label, route] of Object.entries(surfaces)) {
        expect(hrefFor(full, label)).toBe((service === 'core' ? '' : publicUrls.core) + route);
        expect(hrefFor(demo, label)).toBeUndefined();
      }
      expect(demo).not.toContain('nav-trigger-personal-group');
      expect(demo).not.toContain('nav-trigger-family-group');
    }
    expect(await renderNav('core', 'full', 'finance')).toMatch(/href="\/finance"\s+class="dropdown-item active"\s+aria-current="page"/);
  });

  const runtimeLaunchers = normalizeTrustedRuntimeNavItems([
    { id: 'openclaw-runtime', label: 'OpenClaw', href: '/api/openclaw/control-launch/overview', icon: 'fa-paw', owner: 'AIOps', description: 'Protected agent desk.' },
    { id: 'dsh-studio', label: 'DSH Studio', href: '/api/dsh/control-launch', icon: 'fa-terminal', owner: 'AIOps' },
  ]);

  function externalRuntimeAnchors(html) {
    const section = html.split('External runtimes')[1] || '';
    return [...section.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*data-nav-owner="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => ({ href: match[1], owner: match[2], label: match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));
  }

  test('full navigation exposes validated trusted runtime launchers as two distinct, provider-tagged doors', async () => {
    const core = await renderNav('core', 'full', 'nerve-center', runtimeLaunchers);
    expect(core).toContain('External runtimes');
    expect(hrefFor(core, 'OpenClaw')).toBe('/api/openclaw/control-launch/overview');
    expect(hrefFor(core, 'DSH Studio')).toBe('/api/dsh/control-launch');
    expect(core).toMatch(/href="\/api\/openclaw\/control-launch\/overview"[^>]*target="_blank" rel="noopener"[^>]*data-nav-owner="AIOps"[^>]*title="Protected agent desk\."/);
    expect(core).toContain('<span class="nav-owner-tag">AIOps</span>');

    expect(await renderNav('core', 'demo', 'demo', runtimeLaunchers)).not.toContain('DSH Studio');
  });

  test('Benchmark and RAG render exactly the launchers Core renders, through the configured Core authority', async () => {
    const core = externalRuntimeAnchors(await renderNav('core', 'full', 'nerve-center', runtimeLaunchers));
    const benchmark = externalRuntimeAnchors(await renderNav('benchmark', 'full', 'benchmark', runtimeLaunchers));
    const rag = externalRuntimeAnchors(await renderNav('rag', 'full', 'rag', runtimeLaunchers));

    expect(core.map((a) => a.label)).toEqual(['OpenClaw AIOps', 'DSH Studio AIOps']);
    const absolute = (anchors) => anchors.map((a) => ({ ...a, href: new URL(a.href, 'https://core.example').href }));
    expect(absolute(benchmark)).toEqual(absolute(core));
    expect(absolute(rag)).toEqual(absolute(core));
    expect(benchmark[0].href).toBe('https://core.example/api/openclaw/control-launch/overview');
    expect(rag[1].href).toBe('https://core.example/api/dsh/control-launch');

    // Without launchers, no service invents a section.
    for (const service of ['core', 'benchmark', 'rag']) {
      expect(await renderNav(service, 'full', 'nerve-center', [])).not.toContain('External runtimes');
    }
  });

  test('frozen Planning lives under History & reference, with Pipeline as the execution authority', async () => {
    const html = await renderNav('core', 'full', 'pipeline');
    const labs = html.slice(html.indexOf('id="nav-menu-workshop-group"'));
    expect(labs).toContain('History &amp; reference');
    expect(labs).toContain('Experimental');
    expect(labs.indexOf('History &amp; reference')).toBeGreaterThan(labs.indexOf('Experimental'));
    expect(labs.indexOf('Planning · frozen')).toBeGreaterThan(labs.indexOf('History &amp; reference'));
    expect(hrefFor(html, 'Planning · frozen')).toBe('/planning');
    expect(html).toMatch(/href="\/planning"[^>]*title="Historical strategy and evidence reference\. Frozen: current delivery lives in Pipeline\."/);
    expect(hrefFor(html, 'Pipeline')).toBe('/pipeline');
    expect(await renderNav('rag', 'full', 'rag')).toContain('History &amp; reference');
  });

  test('the Product navigation groups are identical on every service', async () => {
    const groups = (html) => [...html.matchAll(/id="nav-trigger-([a-z-]+)"/g)].map((m) => m[1]);
    const items = (html) => [...html.matchAll(/class="dropdown-item[^"]*"[^>]*>\s*<i class="fas [^"]+" aria-hidden="true"><\/i>\s*([^<]+)/g)].map((m) => m[1].trim());
    const core = await renderNav('core', 'full', 'nerve-center', runtimeLaunchers);
    const benchmark = await renderNav('benchmark', 'full', 'benchmark', runtimeLaunchers);
    const rag = await renderNav('rag', 'full', 'rag', runtimeLaunchers);
    expect(groups(benchmark)).toEqual(groups(core));
    expect(groups(rag)).toEqual(groups(core));
    expect(items(benchmark)).toEqual(items(core));
    expect(items(rag)).toEqual(items(core));
  });

  test('trusted runtime labels stay escaped in rendered navigation', async () => {
    const items = normalizeTrustedRuntimeNavItems([{
      id: 'private-runtime',
      label: '<img src=x onerror=alert(1)>',
      href: '/api/private-runtime/control-launch',
      icon: 'fa-terminal',
    }]);
    const html = await renderNav('core', 'full', 'nerve-center', items);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  test('navigation exposes every release-critical demo surface and exact RAG page state', async () => {
    const demo = await renderNav('core', 'demo', 'prompts');
    for (const label of ['Prompts', 'Profiler', 'Courthouse', 'Efficiency Map']) {
      expect(hrefFor(demo, label)).toBeTruthy();
    }

    const ragMaintenance = await renderNav('rag', 'full', 'rag-maintenance');
    expect(hrefFor(ragMaintenance, 'Maintenance')).toBe('https://core.example/rag/maintenance');
    expect(ragMaintenance).toMatch(/href="https:\/\/core\.example\/rag\/maintenance"[\s\S]*?aria-current="page"/);
  });

  test('navigation exposes a complete disclosure and keyboard contract', async () => {
    const html = await renderNav('core', 'full', 'pipeline');
    expect(html).toContain('<nav class="top-nav" aria-label="Navigation principale">');
    expect(html).toContain('id="nav-trigger-workshop-group"');
    expect(html).toContain('aria-controls="nav-menu-workshop-group"');
    expect(html).toContain('id="nav-menu-workshop-group" aria-labelledby="nav-trigger-workshop-group"');
    expect(hrefFor(html, 'Pipeline')).toBe('/pipeline');
    expect(html.match(/href="\/pipeline"[\s\S]*?aria-current="page"/)).not.toBeNull();
    const controller = fs.readFileSync(path.join(__dirname, '../../public/js/product-navigation.js'), 'utf8');
    expect(controller).toContain("e.key === 'ArrowDown'");
    expect(controller).toContain("e.key === 'Escape'");
    expect(controller).toContain("e.key === 'Home'");
    expect(controller).toContain("e.key === 'End'");
    expect(controller).toContain("container.classList.toggle('has-open-menu'");
  });

  test('shared layout provides a skip-to-content target without replacing page-owned ids', () => {
    const layout = fs.readFileSync(path.join(__dirname, '../../views/layouts/main.ejs'), 'utf8');
    expect(layout).toContain('class="skip-link"');
    expect(layout).toContain('href="#main-content"');
    expect(layout).toContain("document.querySelector('main, [role=\"main\"]')");
    expect(layout).toContain("main.parentNode.insertBefore(target, main)");
  });

  test('nav source does not synthesize URLs from request hosts or service ports', () => {
    const source = fs.readFileSync(navPath, 'utf8');
    expect(source).not.toContain('reqHost');
    expect(source).not.toMatch(/localhost|127\.0\.0\.1|192\.168\.2\.|:308[0123]/);
  });

  test('home preserves the full workspace and configured service links', async () => {
    const html = await ejs.renderFile(portalPath, { buildProductNavigation, publicUrls });
    for (const route of ['/playground', '/models', '/analytics', '/performance', '/prompts', '/council', '/nerve-center', '/agent-ops', '/cluster-schedule', '/memory-review', '/pipeline', '/planning', '/backup']) {
      expect(html).toContain(`href="${route}"`);
    }
    expect(hrefFor(html, 'Leaderboard')).toBe('https://core.example/benchmark/leaderboard');
    expect(html).toContain('https://core.example/rag/documents');
    expect(html).not.toContain('host-home-link');
  });

  test.each(['/', '/portal/', '/ecosystem', '/ECOSYSTEM/', '/ecosystem?from=portal#top', '/old/../portal'])(
    'home omits a configured host return link to its own destination %s', async (url) => {
      const html = await ejs.renderFile(portalPath, {
        buildProductNavigation, publicUrls, hostHome: { url, label: 'Mon écosystème' }
      });
      expect(html).not.toContain('id="host-home-link"');
      expect(html).toContain('aria-label="Choisir un espace"');
    }
  );

  test('home preserves optional host-home and normalized runtime launchers', async () => {
    const html = await ejs.renderFile(portalPath, {
      buildProductNavigation, publicUrls,
      hostHome: { url: '/household', label: 'Household' },
      trustedRuntimeNavItems: [{ id: 'runtime', label: 'My runtime', href: '/api/runtime/open', owner: 'host', description: 'Runtime' }]
    });
    expect(hrefFor(html, 'Household')).toBe('/household');
    expect(hrefFor(html, 'My runtime')).toBe('/api/runtime/open');
  });
});
