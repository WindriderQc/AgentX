'use strict';
/**
 * Grouped leaderboard UI: one row per model and host, humanized verdicts,
 * podium gate, provenance and score parts on the row, cohort history, CSV
 * export. The browser modules are run in a vm context over the static
 * fixture in tests/fixtures/leaderboard-grouped.json.
 */
const fs = require('fs');
const path = require('path');
const { loadBrowserModule, loadLeaderboardTextModules } = require('../../helpers/browserModule');
const { VERDICT_REASON } = require('../../../src/services/benchmark/leaderboardGrouping');

const ROOT = path.join(__dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const fixture = require('../../fixtures/leaderboard-grouped.json');

const text = loadLeaderboardTextModules();
const viewModel = loadBrowserModule('leaderboard-v2/view-model.js',
    'buildCategoryScores, buildCategoryDimensions, enrichWithPerfData, toGeneralistBoardEntry, toBoardGroup, groupsFromResponse', text);
const boardStubs = {
    ...text,
    getReadinessMap: async () => ({}),
    getBadgeHtml: () => '',
    speedometer: () => '<svg data-speedometer></svg>',
    formatMs: (value) => (value == null ? '—' : `${value}ms`),
    valColor: () => '#fff',
    shortHost: (url) => String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, ''),
    scoreColor: () => '#4fc3f7'
};
const board = loadBrowserModule('leaderboard-v2/combined-board.js', 'renderCombinedBoard, renderRow, sortRankings, rankedGroups', boardStubs);
const podium = loadBrowserModule('leaderboard-v2/podium.js', 'renderPodium', { scoreColor: () => '#4fc3f7', isComparable: text.isComparable, esc: text.esc });
const hero = loadBrowserModule('leaderboard-v2/hero.js', 'renderHero', { fetchHosts: async () => ({ hosts: [] }) });

const hostNameMap = Object.fromEntries(fixture.hostsRes.hosts.map(host => [host.url, host.name]));
function fixtureGroups() {
    // Fresh copy per test: the view model annotates rows in place.
    const data = JSON.parse(JSON.stringify(fixture.generalistRes.data));
    return viewModel.groupsFromResponse(data, { scoreAxis: 'quality', hostNameMap });
}
function container() {
    return { innerHTML: '', dataset: {}, querySelector: () => null };
}
function count(html, needle) {
    return html.split(needle).length - 1;
}

describe('reason humanizer', () => {
    test('covers every filterReason the service can emit and every verdict reason the grouping adds', () => {
        const service = read('src/services/benchmark/index.js');
        const aggregation = read('src/services/benchmark/generalistScoreAggregation.js');
        const codes = new Set(Object.values(VERDICT_REASON));
        for (const source of [service, aggregation]) {
            for (const match of source.matchAll(/filterReason(?:\s*:\s*|\s*=\s*row\.filterReason\s*\|\|\s*)'([a-z_]+)'/g)) codes.add(match[1]);
        }
        const proofBlock = aggregation.slice(aggregation.indexOf('const proofReason'), aggregation.indexOf(': null;', aggregation.indexOf('const proofReason')));
        for (const match of proofBlock.matchAll(/'([a-z_]+)'/g)) codes.add(match[1]);
        expect(codes.size).toBeGreaterThanOrEqual(14);
        for (const code of codes) {
            expect(text.REASON_TEXT).toHaveProperty(code);
            expect(text.humanizeReason(code)).toMatch(/^[A-Z][^:]+: .+\.$/);
        }
    });

    test('falls back to the raw code, never to nothing', () => {
        expect(text.humanizeReason('made_up_code')).toBe('Not comparable: made_up_code.');
        expect(text.humanizeReason(null)).toBe('Not comparable: no reason recorded.');
        expect(text.humanizeReason('')).toContain('no reason recorded');
        expect(text.reasonLabel('partial_scope')).toBe('Partial coverage');
        expect(text.reasonLabel('made_up_code')).toBe('Not comparable');
    });

    test('explains the headline choice and why a history row is not the headline', () => {
        const groups = fixtureGroups();
        const qwen = groups.find(group => group.model === 'qwen3.8:27b');
        const deepseek = groups.find(group => group.model === 'deepseek-r1:32b');
        expect(text.describeHeadline(qwen)).toBe('Headline: cohort 3f9a2c7d1e because it is the cohort the board compares: the quality cohort (one judge, scorer version and context set for every model) covering the most models, and this model has results in it.');
        expect(text.describeHeadline(deepseek)).toContain('because this model has no results in the cohort the board compares, so its most recent cohort is shown and it stays unranked');
        expect(text.describeHeadline({ headline: { qualityCohortFingerprint: null }, headlineReason: 'pooled_cohorts' })).toContain('cohort none because the local-only board pools every cohort');
        expect(text.describeHeadline({ headline: {}, headlineReason: 'brand_new_rule' })).toContain('headline rule brand_new_rule');
        expect(text.describeHeadline({ headline: {} })).toBe('Headline: cohort none — the only cohort of this model and host in view.');
        expect(text.describeHistoryRow(qwen.history[0])).toBe('not the cohort the board compares');
        expect(text.describeHistoryRow({ historyReason: 'weird' })).toBe('weird');
    });

    test('renders a legend for the reasons present and says what a rank means', () => {
        const legend = text.reasonLegendHtml(['partial_scope', 'made_up_code']);
        expect(legend).toContain('<dt data-reason="partial_scope">Partial coverage</dt>');
        expect(legend).toContain('<dd>Not comparable: made_up_code.</dd>');
        expect(legend).toContain('A model with partial coverage still ranks');
        expect(legend).toContain('A rank is authoritative only when the judge behind it passed calibration for the exact scorer version');
        expect(text.reasonLegendHtml([])).toContain('Every row on this board is ranked.');
    });
});

describe('view model', () => {
    test('yields one group per model and host with the server headline, history and verdict', () => {
        const groups = fixtureGroups();
        expect(groups.map(group => group.model)).toEqual([
            'qwen3.8:27b', 'gemma3:12b', 'phi4:14b', 'llama3.3:70b', 'mistral-small:24b', 'broken-model:7b', 'deepseek-r1:32b'
        ]);
        const qwen = groups[0];
        expect(qwen).toMatchObject({ rank: 1, comparable: true, hostName: 'gpu-a', cohortCount: 4, headlineReason: 'comparable_cohort' });
        expect(qwen.history).toHaveLength(3);
        expect(qwen.headline.scoreParts).toEqual({ score: 8.24, quality: 8.61, coverage: 0, difficulty: 0, evidence: 0 });
        expect(qwen.headline).toMatchObject({ tokPerSec: 38.4, tokPerSecGen: 46.1, avgLatency: 1840, p95Latency: 3320, benchmarkTtft: 410, hostTtft: 355, successRate: 98, judgeModel: 'judge-qwen3:32b' });
        expect(qwen.history[0].cohortScore).toEqual({ field: 'quality_score', mean10: 8.3, sampleSize: 28 });
        expect(groups.map(group => group.comparable)).toEqual([true, true, true, false, false, false, false]);
        // Partial coverage ranks, with a note: its score already carries the penalties.
        expect(groups[2]).toMatchObject({ rank: 3, comparable: true });
        expect(groups[2].headline.verdict).toMatchObject({ reasons: [], notes: ['partial_scope'] });
    });

    test('keeps an unknown success rate unknown, so the performance coefficient waits', () => {
        const phi4 = fixtureGroups().find(group => group.model === 'phi4:14b').headline;
        expect(phi4.successRate).toBeNull();
        expect(phi4.perfCoeff).toBeNull();
        expect(text.successText(phi4)).toBe('unknown (3 attempts, 3 infrastructure errors, no denominator)');
        const qwen = fixtureGroups()[0].headline;
        expect(text.successText(qwen)).toBe('42/43 = 98 %');
        // 38.4 tok/s normalised at 40 (0.96) × 0.98.
        expect(qwen.perfCoeff).toBe(0.941);
    });

    test('treats a response without groups as one group per flat row, without history', () => {
        const data = JSON.parse(JSON.stringify(fixture.generalistRes.data));
        delete data.groups;
        const groups = viewModel.groupsFromResponse(data, { scoreAxis: 'quality' });
        expect(groups).toHaveLength(data.leaderboard.length);
        expect(groups.every(group => group.history.length === 0)).toBe(true);
        expect(groups.filter(group => group.model === 'qwen3.8:27b')).toHaveLength(4);
        expect(viewModel.groupsFromResponse(fixture.generalistRes.data, { selectedHost: 'http://gpu-b.lan:11434' }).map(group => group.model))
            .toEqual(['llama3.3:70b', 'deepseek-r1:32b']);
    });
});

describe('podium gate', () => {
    test('shows only comparable verdicts, without medals or a champion', () => {
        const raw = fixtureGroups().map(group => group.raw);
        const target = { innerHTML: '' };
        podium.renderPodium(target, raw);
        expect(target.innerHTML).toContain('qwen3.8:27b');
        expect(target.innerHTML).toContain('gemma3:12b');
        expect(target.innerHTML).toContain('Evidence 1');
        expect(target.innerHTML).toContain('Evidence 2');
        expect(target.innerHTML).toContain('phi4:14b');
        for (const model of ['llama3.3:70b', 'mistral-small:24b', 'broken-model:7b', 'deepseek-r1:32b']) {
            expect(target.innerHTML).not.toContain(model);
        }
        expect(target.innerHTML).not.toContain('>Champion<');
        expect(target.innerHTML).not.toContain('aria-label="Gold"');
    });

    test('renders no top-3 block at all without a comparable verdict', () => {
        const raw = fixtureGroups().map(group => group.raw).filter(row => !row.verdict.comparable);
        const target = { innerHTML: '' };
        podium.renderPodium(target, raw, {});
        expect(target.innerHTML).toContain('No comparable verdict on this board, so there is no podium.');
        // Four observations, the filtered one included: the board lists it too.
        expect(target.innerHTML).toContain('4 observations are listed in the leaderboard, unranked');
        expect(target.innerHTML).not.toContain('r-pod ');
        expect(target.innerHTML).not.toContain('Evidence 1');
    });
});

describe('grouped board rendering', () => {
    test('renders one row per model and host, ranks only comparable verdicts, and lists the rest unranked with reasons', async () => {
        const target = container();
        await board.renderCombinedBoard(target, fixtureGroups());
        const html = target.innerHTML;

        expect(count(html, '<article class="cb-row')).toBe(7);
        expect(count(html, '<span class="cb-summary-model">qwen3.8:27b')).toBe(1);
        expect(html).toContain('Ranking <small>3 models</small>');
        expect(html).toContain('aria-label="#1, provisional">#1<small>provisional</small>');
        expect(html).toContain('aria-label="#2, provisional">#2<small>provisional</small>');
        expect(html).toContain('aria-label="#3, provisional">#3<small>provisional</small>');
        expect(html).not.toContain('#4<');
        expect(html).toContain('<details class="cb-unranked"><summary class="cb-section-title cb-section-unranked" id="cb-unranked-title">Other evidence <small>4 not ranked: judged on other terms or without a score</small></summary>');
        expect(count(html, '<article class="cb-row cb-not-comparable"')).toBe(4);
        // The unranked marker appears in the summary row and again in the detail sheet.
        expect(count(html, 'cb-rank-none')).toBe(8);
        expect(html).not.toContain('P1');
        expect(html).not.toContain('🥇');
        expect(html).toContain('3 ranked (0 authoritative) · 4 other');
        expect(html).toContain('Judged by judge-qwen3:32b · scorer 2.16 · Ranks provisional where the grader is not qualified · Open a row for its full evidence');
        // The grader behind the provisional ranks and why it is not qualified.
        expect(html).toContain('<dt data-reason="grader_qualification_unknown">');
        expect(html).toContain('<li>judge-qwen3:32b @ http://gpu-a.lan:11434: this judge has never been calibrated</li>');
        expect(html).toContain('id="export-csv"');
        expect(html).toContain('id="cb-model-dialog"');
        expect(html).toContain('<details class="cb-legend">');
        for (const code of ['mixed_scorer_versions', 'unversioned_scorer', 'excessive_empty_responses', 'quality_cohort_fingerprint_mismatch']) {
            expect(html).toContain(`<dt data-reason="${code}">`);
            expect(html).toContain(`<li data-reason="${code}">${text.humanizeReason(code)}</li>`);
        }
        // Partial coverage is explained in the legend, not listed as a reason.
        expect(html).toContain('<dt data-reason="partial_scope">');
        expect(html).not.toContain('<li data-reason="partial_scope">');
    });

    test('puts the headline explanation, provenance, score parts and labelled figures on the row', async () => {
        const target = container();
        await board.renderCombinedBoard(target, fixtureGroups());
        const html = target.innerHTML;
        const qwen = html.slice(html.indexOf('<article class="cb-row cb-comparable" data-group-key="qwen3.8:27b'), html.indexOf('<article class="cb-row', html.indexOf('qwen3.8:27b@@') + 1));

        expect(qwen).toContain('Headline: cohort 3f9a2c7d1e because it is the cohort the board compares');
        expect(qwen).toContain('data-comparable="true" data-partial="false">Provisional rank: Grader qualification unknown</span>');
        expect(qwen).toContain('<dt>Judge</dt><dd>judge-qwen3:32b</dd>');
        expect(qwen).toContain('<dt>Scorer</dt><dd>2.16.0 ×42</dd>');
        expect(qwen).toContain('<dt>Contexts</dt><dd>65536 ×42</dd>');
        expect(qwen).toContain('<dt>Results</dt><dd>42</dd>');
        expect(qwen).toContain('<dt>Dates</dt><dd>2026-09-18 → 2026-09-21</dd>');
        expect(qwen).toContain('Score 8.24 / 10 = quality 8.61 coverage −0.00 (7 categories, 100 % coverage)');
        expect(qwen).toContain('<strong>quality 8.61</strong><small>no adjustment</small>');
        expect(qwen).toContain('<span>tok/s (total)</span><strong>38.4 tok/s</strong>');
        expect(qwen).toContain('<span>tok/s (generation)</span><strong>46.1 tok/s</strong>');
        expect(qwen).toContain('<span>latency mean / p95</span><strong>1.8 s / 3.3 s</strong>');
        expect(qwen).toContain('<span>TTFT measured / host baseline</span><strong>410 ms / 355 ms</strong>');
        expect(qwen).toContain('<span>success</span><strong>42/43 = 98 %</strong>');
        expect(qwen).toContain('<strong>38.4 tok/s (total)</strong><small>TTFT measured 410ms</small>');
        expect(qwen).toContain('<span class="cb-score-label">score</span>');
        expect(qwen).toContain('<span>score / 10</span>');
        // Expandable history with each cohort's date range, judge, scorer, contexts, score, coverage, attempts and reason.
        expect(qwen).toContain('<summary>3 other cohorts of this model on this host</summary>');
        expect(count(qwen, '<tr data-cohort="sha256:')).toBe(3);
        expect(qwen).toContain('<td data-label="Dates">2026-08-30 → 2026-09-02</td>');
        expect(qwen).toContain('<td data-label="Scorer">2.15.2 ×28</td>');
        expect(qwen).toContain('<td data-label="Score">8.30 / 10 mean quality (not a ranked score)</td>');
        expect(qwen).toContain('<td data-label="Attempts" title="successes / attempts (infrastructure errors)">28/30 (1 infra)</td>');
        expect(qwen).toContain('not the cohort the board compares · Other cohort</td>');
        expect(qwen).toContain('<td data-label="Scorer">unversioned ×21</td>');
        expect(qwen).toContain('<td data-label="Score">not scored</td>');
    });

    test('spells out every non-comparable verdict and never shows an unknown success rate as 100 %', async () => {
        const target = container();
        await board.renderCombinedBoard(target, fixtureGroups());
        const html = target.innerHTML;
        const rowOf = (model) => html.slice(html.indexOf(`data-group-key="${model}@@`), html.indexOf('<article class="cb-row', html.indexOf(`data-group-key="${model}@@`)) > -1 ? html.indexOf('<article class="cb-row', html.indexOf(`data-group-key="${model}@@`)) : undefined);

        const phi4 = rowOf('phi4:14b');
        expect(phi4).toContain('data-comparable="true" data-partial="true">Provisional rank: Grader qualification unknown · Partial coverage</span>');
        expect(phi4).toContain('Score 6.17 / 10 = quality 7.90 coverage −1.25 (5 categories, 71 % coverage) hard-level −0.48');
        expect(phi4).toContain('<strong>unknown (3 attempts, 3 infrastructure errors, no denominator)</strong>');
        expect(phi4).not.toContain('100 %');
        expect(phi4).toContain('<span class="cb-score-label">score</span>');
        expect(phi4).toContain('<small>coverage −1.25 · hard-level −0.48</small>');
        expect(rowOf('llama3.3:70b')).toContain('Not ranked: Mixed scorer generations');
        expect(rowOf('llama3.3:70b')).toContain('not ranked</span>');
        expect(rowOf('mistral-small:24b')).toContain('Not ranked: Unversioned scorer');
        expect(rowOf('broken-model:7b')).toContain('Score withheld.');
        const deepseek = rowOf('deepseek-r1:32b');
        expect(deepseek).toContain('Not ranked: Other cohort');
        expect(deepseek).toContain('Headline: cohort 2a4c6e8f0b because this model has no results in the cohort the board compares');
        expect(deepseek).toContain('No comparable score for this cohort.');
        expect(deepseek).toContain('<summary>1 other cohort of this model on this host</summary>');
    });

    test('keeps category switching working on groups and preserves open history', async () => {
        const opened = [];
        const target = {
            innerHTML: '', dataset: { triageMode: 'coding' }, querySelector: () => null,
            querySelectorAll: (selector) => selector === '.cb-history[open]'
                ? [{ dataset: { groupKey: 'qwen3.8:27b@@http://gpu-a.lan:11434' } }]
                : selector === '.cb-history'
                    ? [{ dataset: { groupKey: 'qwen3.8:27b@@http://gpu-a.lan:11434' }, set open(value) { opened.push(value); } }, { dataset: { groupKey: 'other' }, set open(value) { opened.push(`other:${value}`); } }]
                    : []
        };
        await board.renderCombinedBoard(target, fixtureGroups());
        const html = target.innerHTML;
        expect(count(html, '<article class="cb-row')).toBe(7);
        // Coding: qwen 8.8 ahead of gemma 7.2 among comparable rows; unranked rows stay below.
        expect(html.indexOf('data-group-key="qwen3.8:27b')).toBeLessThan(html.indexOf('data-group-key="gemma3:12b'));
        expect(html.indexOf('id="cb-unranked-title"')).toBeGreaterThan(html.indexOf('data-group-key="gemma3:12b'));
        expect(opened).toEqual([true]);
        // The category tabs stay on even when rows cover different scopes, with the stored choice active.
        expect(html).not.toContain('Scopes differ');
        expect(html).toMatch(/data-cat="coding" role="tab"\s+aria-selected="true"/);
        expect(html).toMatch(/data-cat="generalist" role="tab"\s+aria-selected="false"/);
    });

    test('says so when nothing on the board is comparable', async () => {
        const target = container();
        await board.renderCombinedBoard(target, fixtureGroups().filter(group => !group.comparable));
        expect(target.innerHTML).toContain('No model on this board was judged on the same terms as the others, so nothing is ranked.');
        expect(target.innerHTML).toContain('<details class="cb-unranked" open>');
        expect(target.innerHTML).not.toContain('Ranking <small>');
        expect(target.innerHTML).not.toContain('#1<');
    });
});

describe('csv export', () => {
    test('exports the displayed groups, headline and history rows, with verdicts and labelled figures', () => {
        const groups = fixtureGroups();
        const csv = text.buildCsvFromGroups(groups);
        const lines = csv.split('\n');
        expect(lines[0]).toBe(text.CSV_HEADERS.join(','));
        expect(lines).toHaveLength(1 + 7 + 3 + 1 + 1);
        const header = lines[0].split(',');
        // Minimal RFC 4180 field split: quoted fields may hold commas and doubled quotes.
        const fields = (line) => {
            const out = [];
            let current = '';
            let quoted = false;
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (quoted) {
                    if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
                    else if (char === '"') quoted = false;
                    else current += char;
                } else if (char === '"') quoted = true;
                else if (char === ',') { out.push(current); current = ''; }
                else current += char;
            }
            out.push(current);
            return out;
        };
        const cell = (line, name) => fields(line)[header.indexOf(name)];
        expect(fields(lines[1])).toHaveLength(header.length);
        expect(lines[1].startsWith('headline,1,generalist,1,true,,false,unknown,grader_qualification_unknown no_calibration_record,')).toBe(true);
        expect(cell(lines[1], 'model')).toBe('qwen3.8:27b');
        expect(cell(lines[1], 'score')).toBe('8.240');
        expect(cell(lines[1], 'qualityRaw')).toBe('8.610');
        expect(cell(lines[1], 'tokPerSecTotal')).toBe('38.4');
        expect(cell(lines[1], 'tokPerSecGeneration')).toBe('46.1');
        expect(cell(lines[1], 'successRate')).toBe('98');
        expect(lines[2].startsWith('history,,,,false,quality_cohort_fingerprint_mismatch,false,unknown,')).toBe(true);
        expect(cell(lines[2], 'headlineOrHistoryReason')).toBe('not the cohort the board compares');
        expect(cell(lines[2], 'meanAxisScore')).toBe('8.300');
        const phi4 = lines.find(line => line.includes('phi4:14b'));
        expect(cell(phi4, 'verdictReasons')).toBe('');
        expect(cell(phi4, 'rank')).toBe('3');
        expect(cell(phi4, 'successRate')).toBe('');
        expect(cell(phi4, 'infraErrors')).toBe('3');
        expect(text.csvFilename(new Date('2026-09-22T10:00:00Z'))).toBe('leaderboard-2026-09-22.csv');
    });

    test('writes the rank the screen showed, in every mode, and never a stale server rank', () => {
        // Generalist mode: the server rank, kept under a host or subset view (a gap is honest).
        const withoutLeader = fixtureGroups().filter(group => group.model !== 'qwen3.8:27b');
        const generalist = board.rankedGroups(withoutLeader, 'generalist');
        expect(generalist.comparable.map(group => [group.model, group.displayedRank, group.rankScope])).toEqual([['gemma3:12b', 2, 'generalist'], ['phi4:14b', 3, 'generalist']]);
        const csvGeneralist = text.buildCsvFromGroups([...generalist.comparable, ...generalist.others]).split('\n');
        expect(csvGeneralist[1].startsWith('headline,2,generalist,2,true,,')).toBe(true);

        // Category mode: position by that category, labelled as such; serverRank keeps the board rank.
        const coding = board.rankedGroups(fixtureGroups(), 'coding');
        expect(coding.comparable.map(group => [group.model, group.displayedRank, group.rank])).toEqual([['qwen3.8:27b', 1, 1], ['phi4:14b', 2, 3], ['gemma3:12b', 3, 2]]);
        const swapped = fixtureGroups();
        swapped.find(group => group.model === 'gemma3:12b').headline.categoryScores.coding = 9.9;
        const codingSwapped = board.rankedGroups(swapped, 'coding');
        expect(codingSwapped.comparable.map(group => [group.model, group.displayedRank, group.rank])).toEqual([['gemma3:12b', 1, 2], ['qwen3.8:27b', 2, 1], ['phi4:14b', 3, 3]]);
        const csvCoding = text.buildCsvFromGroups([...codingSwapped.comparable, ...codingSwapped.others]).split('\n');
        expect(csvCoding[1].startsWith('headline,1,coding,2,true,,')).toBe(true);
        expect(csvCoding[2].startsWith('headline,2,coding,1,true,,')).toBe(true);
        expect(coding.others.every(group => group.displayedRank === null)).toBe(true);
    });

    test('neutralises spreadsheet formulas and keeps line breaks inside one quoted field', () => {
        const groups = fixtureGroups().slice(0, 1);
        groups[0].headline.host = '=HYPERLINK("http://x","go")';
        groups[0].headline.judgeModel = 'judge\nwith break';
        groups[0].headline.harness = { name: '@cmd', version: '-1' };
        const lines = text.buildCsvFromGroups(groups).split('\n');
        expect(lines[1]).toContain(',"\'=HYPERLINK(""http://x"",""go"")",');
        expect(lines[1]).toContain(",'@cmd,-1,");
        expect(lines[1]).toContain(',"judge');
        expect(lines[2]).toBe('with break",2.16.0:42,65536:42,2026-09-18,2026-09-21,42,8.240,8.610,0.000,0.000,0.000,100,true,8.610,quality_score,38.4,46.1,1840,3320,410,355,42,44,1,98,,8.80,8.40,8.10,7.90,9.00,7.60,8.50,');
    });
});

describe('screen rank and section labels', () => {
    test('labels category-mode ranks by the category and keeps the server rank on a subset view', async () => {
        const target = { innerHTML: '', dataset: { triageMode: 'coding' }, querySelector: () => null };
        await board.renderCombinedBoard(target, fixtureGroups().filter(group => ['qwen3.8:27b', 'gemma3:12b'].includes(group.model)));
        expect(target.innerHTML).toContain('Ranking <small>2 models by Coding</small>');
        expect(target.innerHTML).toContain('aria-label="1st in Coding, provisional"><b>1st</b><small>Coding</small></span>');
        expect(target.innerHTML).toContain('title="1st in Coding among comparable verdicts (category order, not the generalist rank) — provisional:');
        expect(target.innerHTML).toContain('aria-label="2nd in Coding, provisional"><b>2nd</b><small>Coding</small></span>');
        expect(target.innerHTML).toContain('title="2nd in Coding among comparable verdicts (category order, not the generalist rank) — provisional:');
        expect(target.innerHTML).not.toContain('>#1<');

        const subset = container();
        await board.renderCombinedBoard(subset, fixtureGroups().filter(group => group.model !== 'qwen3.8:27b'));
        expect(subset.innerHTML).toContain('>#2<small>provisional</small>');
        expect(subset.innerHTML).not.toContain('>#1<');
    });
});

describe('hero results count', () => {
    test('counts every result behind each model and host, all cohorts included', async () => {
        const groups = fixtureGroups();
        const heroRows = groups.map(group => ({ ...group.raw, totalTests: group.resultCount }));
        expect(heroRows.reduce((sum, row) => sum + row.totalTests, 0)).toBe(299);
        expect(groups.map(group => group.raw).reduce((sum, row) => sum + row.totalTests, 0)).toBe(198);

        // The hero keeps its rule of leaving filtered models out of its counts:
        // 299 minus the 16 runs of the filtered model. Headline-only would read 182.
        const target = { innerHTML: '', querySelector: () => ({ innerHTML: '' }) };
        await hero.renderHero(target, fixture.dashboardRes, { hostScope: 'current', rankings: heroRows, hostsRes: fixture.hostsRes });
        expect(target.innerHTML).toContain('<div class="r-stat-val">283</div>');
        expect(target.innerHTML).not.toContain('<div class="r-stat-val">182</div>');
        expect(read('public/js/leaderboard-v2/index.js')).toContain('totalTests: group.resultCount');
        expect(read('public/js/leaderboard-v2/index.js')).toContain('rankings: heroRows');
    });
});

describe('escaping', () => {
    const MODEL = '<script>alert(1)</script>"x';
    const JUDGE = 'judge"<b>bold</b>';

    test('escapes model and judge names through the grouped row, its history and the podium', async () => {
        expect(text.esc('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
        const groups = fixtureGroups().slice(0, 1);
        groups[0].headline.model = MODEL;
        groups[0].headline.judgeModel = JUDGE;
        groups[0].history[0].judgeModel = '<i>hist</i>';
        groups[0].history[0].model = MODEL;
        const target = container();
        await board.renderCombinedBoard(target, groups);
        const html = target.innerHTML;
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>bold</b>');
        expect(html).not.toContain('<i>hist</i>');
        expect(html).toContain('<span class="cb-summary-model">&lt;script&gt;alert(1)&lt;/script&gt;&quot;x</span>');
        expect(html).toContain('<dt>Judge</dt><dd>judge&quot;&lt;b&gt;bold&lt;/b&gt;</dd>');
        expect(html).toContain('<td data-label="Judge">&lt;i&gt;hist&lt;/i&gt;</td>');
        expect(html).toContain('aria-label="Open full evidence sheet for &lt;script&gt;alert(1)&lt;/script&gt;&quot;x"');

        const raw = { ...groups[0].raw, model: MODEL, hostName: 'host<img src=x onerror=1>' };
        const pod = { innerHTML: '' };
        podium.renderPodium(pod, [raw], {});
        expect(pod.innerHTML).not.toContain('<script>');
        expect(pod.innerHTML).not.toContain('<img src=x');
        expect(pod.innerHTML).toContain('<div class="r-pod-name">&lt;script&gt;alert(1)&lt;/script&gt;&quot;x</div>');
        expect(pod.innerHTML).toContain('host&lt;img src=x onerror=1&gt;');
    });

    test('escapes host chips and the comparison rule in the page shell', () => {
        const page = read('public/js/leaderboard-v2/index.js');
        expect(page).toContain("import { esc }                     from './verdict.js'");
        expect(page).toContain('data-host-url="${esc(url)}" title="Show only results from ${esc(name)}"');
        expect(page).toContain('<span class="r-host-opt-name">${esc(name)}</span>');
    });
});

describe('page wiring', () => {
    test('the page renders groups, exposes a render entry point for the fixture and lets the board own the export button', () => {
        const page = read('public/js/leaderboard-v2/index.js');
        expect(page).toContain('export async function renderLeaderboardPage');
        expect(page).toContain("import { groupsFromResponse }      from './view-model.js'");
        expect(page).toContain("dataset?.leaderboardSource !== 'fixture'");
        expect(page).not.toContain('renderEvidenceNotice');
        expect(page).not.toContain('buildCsvFromRankings');
        expect(page).not.toContain("getElementById('export-csv')");
        const server = read('server.js');
        expect(server).toContain('<link rel="stylesheet" href="/css/leaderboard-v2-groups.css">');
        const html = read('tests/fixtures/leaderboard-grouped.html');
        expect(html).toContain('data-leaderboard-source="fixture"');
        expect(html).toContain("import { renderLeaderboardPage } from '../../public/js/leaderboard-v2/index.js'");
        expect(html).toContain("fetch('./leaderboard-grouped.json')");
    });

    test('the grouped stylesheet stacks history rows into cards at phone width', () => {
        const css = read('public/css/leaderboard-v2-groups.css');
        expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.cb-history-table thead \{ display: none; \}[\s\S]*\.cb-history-table td::before \{\s*content: attr\(data-label\);/);
        expect(css).toContain('.cb-toolbar { align-items: stretch; flex-direction: column; }');
        expect(read('public/css/leaderboard-v2.css').split('\n').length).toBeLessThanOrEqual(2776);
    });
});
