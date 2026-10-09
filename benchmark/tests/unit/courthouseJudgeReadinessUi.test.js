const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_ROOT = path.join(__dirname, '../../public/js');
const read = (...segments) => fs.readFileSync(path.join(PUBLIC_ROOT, ...segments), 'utf8');

function loadEvidenceModule() {
    const sourcePath = path.join(PUBLIC_ROOT, 'courthouse-v2', 'evidence-provenance.js');
    let source = fs.readFileSync(sourcePath, 'utf8').replace(/export\s+/g, '');
    source += '\nglobalThis.__exports = { evidenceProvenance, evidenceBadge };';
    const context = {};
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.__exports;
}

function loadSettledEvidenceModule() {
    const sourcePath = path.join(PUBLIC_ROOT, 'courthouse-v2', 'settled-evidence.js');
    let source = fs.readFileSync(sourcePath, 'utf8').replace(/export\s+/g, '');
    source += '\nglobalThis.__exports = { settleEvidence, withRecoverableJudgeSetup };';
    const context = {};
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.__exports;
}

describe('Courthouse judge readiness UI contracts', () => {
    test('labels deterministic-only, judge-scored, hybrid, and failed evidence distinctly', () => {
        const { evidenceProvenance } = loadEvidenceModule();

        expect(evidenceProvenance({
            scoring_method: 'deterministic_fallback',
            deterministic_score: 4,
            subjective_score: null,
            judge_model: 'failed-judge'
        }).kind).toBe('deterministic-only');
        expect(evidenceProvenance({
            scoring_method: 'decomposed',
            subjective_score: 8
        }).kind).toBe('judge-scored');
        expect(evidenceProvenance({
            scoring_method: 'hybrid',
            deterministic_score: 9,
            subjective_score: 7
        }).kind).toBe('hybrid');
        expect(evidenceProvenance({ scoring_method: 'llm_failed', judge_model: 'judge' }).kind)
            .toBe('unscored');
    });

    test('The Bench renders the authoritative state, evidence modes, retry, and explicit setup path', () => {
        const source = read('courthouse-v2', 'the-bench.js');
        expect(source).toContain("apiFetch('/benchmark/api/benchmark/judge/readiness')");
        expect(source).toContain('rosterData?.readiness || fallbackReadiness');
        expect(source).toContain('data-judge-ready');
        expect(source).toContain('Retry check');
        expect(source).toContain('Deterministic evidence');
        expect(source).toContain('Judge-scored evidence');
        expect(source).toContain('No model is downloaded or selected automatically.');
    });

    test('re-judge is visibly gated while human and deterministic review remain available', () => {
        const source = read('courthouse-v2', 'detail-panel.js');
        expect(source).toContain('data-judge-required="true"');
        expect(source).toContain('disabled aria-disabled="true"');
        expect(source).toContain('Verify deterministic evidence');
        expect(source).toContain("action === 'rejudge' && !isJudgeReady()");
    });

    test('calibration and setup never auto-select the first model', () => {
        const calibration = read('courthouse-v2', 'calibration.js');
        const setup = read('setup', 'index.js');
        const benchmarkRoster = read('benchmark-v2', 'judge-roster.js');

        expect(calibration).toContain('Select a configured host…');
        expect(calibration).toContain('Select an installed model…');
        expect(calibration).toContain('will not download or auto-select a model');
        expect(calibration).toContain('data-cal-readiness-note');
        expect(calibration).toContain("document.addEventListener('judge-readiness-changed'");
        expect(calibration).toContain('does not measure direct agreement with human scores');
        expect(setup).toContain('Choose an installed judge model…');
        expect(setup).not.toContain('autoSelectJudge');
        expect(benchmarkRoster).toContain('readiness?.preferred_target?.model');
        expect(benchmarkRoster).not.toContain('config.judge_model');
    });

    test('settles independent evidence so one rejected API cannot cancel readiness', async () => {
        const { settleEvidence } = loadSettledEvidenceModule();
        const calls = [];
        const evidence = await settleEvidence({
            dashboard: async () => {
                calls.push('dashboard');
                throw new Error('mongo unavailable');
            },
            readiness: async () => {
                calls.push('readiness');
                return { ready: false, setup: { href: '/benchmark/setup?focus=judge' } };
            },
            review: async () => {
                calls.push('review');
                throw new Error('results unavailable');
            }
        });

        expect(calls.sort()).toEqual(['dashboard', 'readiness', 'review']);
        expect(evidence.dashboard.ok).toBe(false);
        expect(evidence.review.ok).toBe(false);
        expect(evidence.readiness.ok).toBe(true);
        expect(evidence.readiness.value.setup.href).toBe('/benchmark/setup?focus=judge');
    });

    test('routes blocked setup to a real page when roster candidates cannot render', () => {
        const { withRecoverableJudgeSetup } = loadSettledEvidenceModule();
        const blocked = {
            ready: false,
            setup: { href: '#the-bench', label: 'Choose a judge' }
        };

        const unavailableRoster = withRecoverableJudgeSetup(blocked, {
            rosterAvailable: false,
            hostPanels: [{ judges: [] }]
        });
        expect(unavailableRoster.setup.href).toBe('/benchmark/setup?focus=judge');
        expect(unavailableRoster.setup.label).toBe('Open judge setup');

        const renderedCandidates = withRecoverableJudgeSetup(blocked, {
            rosterAvailable: true,
            hostPanels: [{ judges: [{ modelName: 'judge:7b' }] }]
        });
        expect(renderedCandidates.setup.href).toBe('#the-bench');
        expect(renderedCandidates.setup.label).toBe('Choose a judge');
    });

    test('renders recoverable outage states instead of leaving stale loading UI', () => {
        const index = read('courthouse-v2', 'index.js');
        const bench = read('courthouse-v2', 'the-bench.js');
        const ledger = read('courthouse-v2', 'results-ledger.js');

        expect(index).toContain('settleEvidence({');
        expect(index).toContain('Review evidence is unavailable. No empty-queue conclusion was inferred.');
        expect(index).toContain('showRecoverableState');
        expect(index).toContain('ch-retry-section');
        expect(index).toMatch(/await Promise\.allSettled\(\[\s+benchTask,\s+reviewTask,/);
        expect(index).not.toContain('await loadReviewQueue();\n\n    // ── Test library');
        expect(bench).toContain("apiFetch('/benchmark/api/benchmark/judge/readiness')");
        expect(bench).toContain('fallbackReadiness');
        expect(bench).toContain("href: '/benchmark/setup?focus=judge'");
        expect(bench).toContain('dashboard counts');
        expect(bench).toContain('Calibration evidence is historical.');
        expect(bench).toContain('retired or unconfigured host');
        expect(ledger).toContain('ledger-retry');
    });
});

test('the judge roster keeps qualifications for different settings separate', () => {
    const { loadBrowserModule } = require('../helpers/browserModule');
    const { hostColumn } = loadBrowserModule('courthouse-v2/the-bench.js', 'hostColumn', { escHtml: String });
    const host = { hostUrl: 'http://judge:11434', hostName: 'Judge', judges: [{ modelName: 'judge-model' }] };
    const html = hostColumn(host, {}, 0, { available: true, scorerVersion: 'current', map: {
        'http://judge:11434@@judge-model': [
            { qualification_contract_fingerprint: 'a'.repeat(64), current: { status: 'qualified' } },
            { qualification_contract_fingerprint: 'b'.repeat(64), current: { status: 'unqualified', causes: ['calibration_failed_mae'] } }
        ]
    } });
    expect(html).toContain('qualified · contract aaaaaaaa');
    expect(html).toContain('failed qualification · contract bbbbbbbb');
    expect(html).toContain('only for the recorded artifact, runtime and settings');
});
