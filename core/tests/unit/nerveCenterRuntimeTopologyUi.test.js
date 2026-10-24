const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-runtime-topology.js'), 'utf8');

function card() {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const window = { NerveCenterShared: { escapeHtml } };
  vm.runInNewContext(source, { window, Date });
  return window.NerveCenterRuntimeTopology;
}

const endpoint = (url, role, extra = {}) => ({ url, role, hostName: null, resources: ['gpu-a'], pins: [{ model: 'main:q8', contextSize: 196608 }],
  online: true, pinsResident: true, ready: true, reason: null, ...extra });

describe('Nerve Center runtime topology card', () => {
  it('says when no topology is declared', () => {
    expect(card().build({ configured: false, valid: true, groups: [] })).toContain('No topology modes are declared');
  });

  it('reports an invalid declaration without showing its content', () => {
    const html = card().build({ configured: true, valid: false, code: 'runtime_topology_configuration_invalid', groups: [] });
    expect(html).toContain('declaration is invalid');
  });

  it('marks the running mode, explains the others and offers no switch', () => {
    const html = card().build({ configured: true, valid: true, observedAt: new Date().toISOString(), groups: [{
      id: 'dual-gpu', label: 'Dual GPU', activeMode: 'pooled', state: 'active', modes: [
        { id: 'lanes', label: 'Two lanes', status: 'inactive', endpoints: [endpoint('http://h:11437', 'conversation', { ready: false, online: false, reason: 'offline' })] },
        { id: 'pooled', label: 'Pooled', status: 'active', endpoints: [endpoint('http://h:11434', 'pooled')] }
      ] }] });
    expect(html).toContain('Pooled</strong>');
    expect(html).toContain('(running now)');
    expect(html).toContain('runtime not reachable');
    expect(html).toContain('main:q8 · 196608');
    expect(html).not.toMatch(/<button|<select/);
  });

  it('escapes declared labels', () => {
    const html = card().build({ configured: true, valid: true, observedAt: new Date().toISOString(), groups: [{
      id: 'g', label: '<b>x</b>', activeMode: null, state: 'none_active', modes: [] }] });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('No declared mode is running.');
  });
});
