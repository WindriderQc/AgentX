'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-principal-model.js'), 'utf8');

function card() {
  const window = { NerveCenterShared: { escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, '') } };
  vm.runInNewContext(source, { window, document: {}, globalThis: {} });
  return window.NerveCenterPrincipalModel;
}

const principal = (options, extra = {}) => ({
  available: true, selected: 'standard', model: 'everyday:27b', contextSize: 196608, hostUrl: 'http://host:11434',
  choicesRevision: 2, divergentRoutes: [], options, ...extra
});

describe('Nerve Center principal model card', () => {
  it('shows the model each option names and which one is in use', () => {
    const html = card().build(principal([
      { value: 'standard', label: 'Standard', model: 'everyday:27b' },
      { value: 'abliterated', label: 'Abliterated', model: 'open:27b' }
    ]));
    expect(html).toContain('everyday:27b (in use)');
    expect(html).toContain('open:27b');
    expect(html).toContain('Choose the Abliterated model');
    expect(html).not.toContain('Not set');
  });

  it('on a fresh install shows both options unset and the switch disabled', () => {
    const html = card().build(principal([
      { value: 'standard', label: 'Standard', model: null },
      { value: 'abliterated', label: 'Abliterated', model: null }
    ], { available: false, selected: null, model: null }));
    expect(html.match(/Not set/g)).toHaveLength(2);
    expect(html).toContain('Choose a model installed on http://host:11434 for Standard and Abliterated');
    expect(html).toMatch(/id="ncPrincipalChoice"[^>]*disabled/);
    expect(html).toMatch(/id="ncPrincipalApply"[^>]*disabled/);
  });

  it('saves a choice with the revision it showed, through the choices route', () => {
    expect(source).toContain("'/api/nerve-center/principal-model/choices'");
    expect(source).toContain('expectedRevision: principalModel.choicesRevision');
    expect(source).toContain("'/api/nerve-center/principal-model/installed'");
  });
});
