'use strict';

const { loadBrowserModule } = require('../../helpers/browserModule');

const helpers = {
  _fmtCtx: n => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n)),
  escAttr: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
};
const { renderContextProposal } = loadBrowserModule(
  'model-profiler/components/context-proposal.js', 'renderContextProposal', helpers
);

const proposed = {
  modelName: 'gemma4:12b', status: 'proposed', offer: true, direction: 'increase',
  currentContext: 65536, proposedContext: 98304, proposalId: 'write-1',
  expectedVram: { hostUsedMiB: 30720, hostTotalMiB: 49152, modelMiB: 20480 },
  coResidents: [{ model: 'bge-m3:latest', observedContext: 8192, vramMiB: 1229 }],
  taskBudgets: { interactive: 32768, document: 65536 }
};

describe('pin context proposal rendering', () => {
  it('shows current pin, proposal, expected VRAM and both decisions', () => {
    const html = renderContextProposal(proposed);
    expect(html).toContain('Raise pin 64k → 96k');
    expect(html).toContain('30.0 GB host of 48.0 GB');
    expect(html).toContain('bge-m3:latest fully in VRAM at 8k');
    expect(html).toContain('>Apply</button>');
    expect(html).toContain('>Keep current</button>');
    expect(html).toContain('not the pin allocation');
  });

  it('keeps a declined proposal visible with Apply only', () => {
    const html = renderContextProposal({ ...proposed, declined: true, declinedAt: '2026-09-27T11:00:00Z' }, { mode: 'card' });
    expect(html).toContain('is-declined');
    expect(html).toContain('until the pin matches or a newer profile replaces it');
    expect(html).toContain('>Apply</button>');
    expect(html).not.toContain('Keep current</button>');
  });

  it('says so and offers nothing when the model is not pinned', () => {
    const html = renderContextProposal({ modelName: 'qwen3:8b', status: 'not_pinned', offer: false });
    expect(html).toContain('not pinned on this host');
    expect(html).not.toContain('<button');
    expect(renderContextProposal({ status: 'not_pinned' }, { mode: 'card' })).toBe('');
  });

  it('presents an unknown limit with its qualification, not an estimate', () => {
    const html = renderContextProposal({
      modelName: 'gemma4:12b', status: 'unknown_limit', currentContext: 65536, soloVerifiedContext: 131072,
      reason: 'No passing probe step had every other pinned resident fully in VRAM beside this model.',
      qualification: { missingResidents: ['bge-m3:latest'], candidates: [98304, 131072], instruction: 'Reprofile with the pins resident.' }
    });
    expect(html).toContain('Limit with co-residents unknown');
    expect(html).toContain('Missing beside it: bge-m3:latest');
    expect(html).toContain('Candidates to qualify: 96k, 128k');
    expect(html).toContain('not a fit with the other pins');
    expect(html).not.toContain('<button');
  });

  it('reports a failed apply with its rollback state', () => {
    const html = renderContextProposal({ ...proposed, lastAttempt: { outcome: { message: 'Short-prompt speed fell', rollback: 'unverified' } } });
    expect(html).toContain('Last Apply failed: Short-prompt speed fell');
    expect(html).toContain('runtime restoration is unverified');
  });

  it('shows an ambiguous apply as outcome unknown, not as a failure', () => {
    const html = renderContextProposal({ ...proposed, lastAttempt: { outcomeUnknown: true, outcome: { message: 'No answer' } } });
    expect(html).toContain('outcome unknown');
    expect(html).toContain('Check the current pin');
    expect(html).not.toContain('Last Apply failed');
  });

  it('escapes model names', () => {
    expect(renderContextProposal({ ...proposed, modelName: '<x>' })).not.toContain('<x>');
  });
});
