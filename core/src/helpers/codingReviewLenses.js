'use strict';

// Advisory focus only: these lenses never select a model, grant work or pass a gate.
const LENSES = Object.freeze({
  code: 'Check concrete correctness, regressions and whether tests cover the requested behavior.',
  ux: 'Check user flows, loading/empty/error states, keyboard access and recovery from interrupted actions.',
  visual: 'Check visual consistency and responsive layout. Source alone cannot establish the rendered appearance.',
  performance: 'Check repeated work, rendering cost and resource lifecycle. Distinguish hypotheses from measured improvements.',
  security: 'Check data exposure, trust boundaries and consequential effects. Do not invent exploitability without evidence.'
});

function parseLenses(value = 'code') {
  if (typeof value !== 'string') throw new Error('review lenses must be a comma-separated string');
  const names = value.split(',').map(name => name.trim());
  if (!names.length || names.some(name => !Object.hasOwn(LENSES, name))
    || new Set(names).size !== names.length) throw new Error('unknown, empty or repeated review lens');
  return names;
}

function reviewInstructions(lenses) {
  return '\nRequested review lenses:\n' + lenses.map(name => `${name}: ${LENSES[name]}`).join('\n')
    + '\nFor each requested lens, state concrete findings and missing evidence separately. '
    + 'This call has no browser, test runner or measuring tools. Never present a source inspection '
    + 'as a visual, interaction or performance test. Do not issue PASS, approval or deployment authority. '
    + 'A missing screenshot or measurement is an evidence gap, not a defect proved in the code.';
}

function reviewScope(lenses) {
  return { lenses: [...lenses], basis: 'supplied_packet_only',
    browserExecuted: false, testsExecuted: false, performanceMeasured: false,
    grantsApproval: false };
}

module.exports = { LENSES, parseLenses, reviewInstructions, reviewScope };
