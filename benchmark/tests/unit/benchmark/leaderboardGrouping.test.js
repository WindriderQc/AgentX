'use strict';
/**
 * One group per model and host, a headline chosen by the board's own cohort
 * selection, the other cohorts as history, and a verdict that decides which
 * rows may carry a rank. Pure functions over the rows getGeneralistLeaderboard
 * emits; no database.
 */
const {
    HEADLINE_REASON,
    HISTORY_REASON,
    VERDICT_REASON,
    comparisonScorerFamily,
    dominantScorerVersion,
    groupLeaderboard,
    verdictFor
} = require('../../../src/services/benchmark/leaderboardGrouping');

const HOST = 'http://gpu-a.example:11434';
const SELECTED = 'sha256:selected-cohort';

function scored(overrides = {}) {
    return {
        model: 'qwen3.8:27b', host: HOST, qualityCohortFingerprint: SELECTED,
        rankable: true, filtered: false, filterReason: null, generalistScore: 81.4,
        fullScopeEligible: true, totalTests: 42,
        scorerVersions: { '2.16.0': 42 },
        earliestTimestamp: '2026-09-18T00:00:00.000Z', latestTimestamp: '2026-09-21T00:00:00.000Z',
        performance: { scorerVersions: { '2.16.0': 42 }, earliestTimestamp: '2026-09-18T00:00:00.000Z', latestTimestamp: '2026-09-21T00:00:00.000Z' },
        ...overrides
    };
}

function otherCohort(index, overrides = {}) {
    const day = String(20 - index).padStart(2, '0');
    return {
        model: 'qwen3.8:27b', host: HOST, qualityCohortFingerprint: `sha256:cohort-${index}`,
        rankable: false, filtered: false, filterReason: 'quality_cohort_fingerprint_mismatch',
        generalistScore: null, totalTests: 7, latestTimestamp: `2026-08-${day}T00:00:00.000Z`,
        scorerVersions: {},
        performance: { scorerVersions: { '2.15.0': 7 }, earliestTimestamp: `2026-08-${day}T00:00:00.000Z`, latestTimestamp: `2026-08-${day}T00:00:00.000Z` },
        ...overrides
    };
}

describe('one group per model and host', () => {
    test('folds thirteen cohorts of one model into one headline and twelve history rows', () => {
        const rows = [scored(), ...Array.from({ length: 12 }, (_, i) => otherCohort(i + 1))];
        const { groups, groupCount } = groupLeaderboard(rows, { selectedQualityCohortFingerprint: SELECTED });

        expect(groupCount).toBe(1);
        const [group] = groups;
        expect(group).toMatchObject({
            key: `qwen3.8:27b@@${HOST}`, model: 'qwen3.8:27b', host: HOST,
            rank: 1, comparable: true, cohortCount: 13, resultCount: 42 + 12 * 7,
            headlineReason: HEADLINE_REASON.COMPARABLE_COHORT,
            earliestTimestamp: '2026-08-08T00:00:00.000Z', latestTimestamp: '2026-09-21T00:00:00.000Z'
        });
        expect(group.headline.qualityCohortFingerprint).toBe(SELECTED);
        expect(group.history).toHaveLength(12);
        // Newest first, each one saying why it is not the headline.
        expect(group.history[0].qualityCohortFingerprint).toBe('sha256:cohort-1');
        expect(group.history[11].qualityCohortFingerprint).toBe('sha256:cohort-12');
        expect(group.history.every(row => row.historyReason === HISTORY_REASON.OTHER_COHORT)).toBe(true);
        expect(group.history.every(row => row.verdict.reasons.length > 0)).toBe(true);
        expect(group.history[0].verdict).toMatchObject({ comparable: false, reasons: ['quality_cohort_fingerprint_mismatch'] });
    });

    test('a model absent from the comparable cohort shows its newest cohort, unranked, with the reason', () => {
        const rows = [
            scored(),
            otherCohort(1, { model: 'other-model', latestTimestamp: '2026-07-01T00:00:00.000Z', performance: { scorerVersions: { '2.15.0': 3 }, latestTimestamp: '2026-07-01T00:00:00.000Z' } }),
            otherCohort(2, { model: 'other-model', latestTimestamp: '2026-07-09T00:00:00.000Z', performance: { scorerVersions: { '2.15.0': 3 }, latestTimestamp: '2026-07-09T00:00:00.000Z' } })
        ];
        const { groups } = groupLeaderboard(rows, { selectedQualityCohortFingerprint: SELECTED });
        const other = groups.find(group => group.model === 'other-model');
        expect(other).toMatchObject({ rank: null, comparable: false, cohortCount: 2, headlineReason: HEADLINE_REASON.LATEST_EVIDENCE });
        expect(other.headline.qualityCohortFingerprint).toBe('sha256:cohort-2');
        expect(other.verdict.reasons).toEqual(['quality_cohort_fingerprint_mismatch']);
        expect(other.history.map(row => row.qualityCohortFingerprint)).toEqual(['sha256:cohort-1']);
    });

    test('results on an edited prompt share the cohort but never become the headline', () => {
        const stale = scored({
            generalistScore: null, rankable: false, filterReason: 'prompt_content_changed', promptContentStale: true,
            stalePrompts: ['Reasoning two'], totalTests: 2, latestTimestamp: '2026-09-30T00:00:00.000Z'
        });
        const { groups } = groupLeaderboard([stale, scored()], { selectedQualityCohortFingerprint: SELECTED });
        expect(groups[0]).toMatchObject({ rank: 1, comparable: true, headlineReason: HEADLINE_REASON.COMPARABLE_COHORT });
        expect(groups[0].headline.promptContentStale).toBeUndefined();
        expect(groups[0].history).toHaveLength(1);
        expect(groups[0].history[0].verdict).toMatchObject({ comparable: false, reasons: ['prompt_content_changed'] });
    });

    test('keeps hosts apart and annotates the flat rows in place', () => {
        const rows = [scored(), scored({ host: 'http://gpu-b.example:11434', generalistScore: 70 })];
        const { groups } = groupLeaderboard(rows, { selectedQualityCohortFingerprint: SELECTED });
        expect(groups.map(group => group.host)).toEqual([HOST, 'http://gpu-b.example:11434']);
        expect(rows[0].verdict).toEqual(expect.objectContaining({ comparable: true, reasons: [] }));
    });

    test('the pooled local-only board has one row per model and host and says so', () => {
        const { groups } = groupLeaderboard([scored({ qualityCohortFingerprint: 'sha256:first-seen' })], { selectedQualityCohortFingerprint: null });
        expect(groups[0]).toMatchObject({ headlineReason: HEADLINE_REASON.POOLED_COHORTS, history: [], comparable: true, rank: 1 });
    });
});

describe('comparable verdict', () => {
    test('needs a rankable, unfiltered, scored, versioned row on the board scorer generation', () => {
        expect(verdictFor(scored(), '2.16')).toEqual({
            comparable: true, authoritative: false, authorityReasons: [VERDICT_REASON.GRADER_UNKNOWN],
            graderStatus: 'unknown', graderCauses: [],
            reasons: [], notes: [], scorerVersion: '2.16.0', scorerFamily: '2.16', comparisonScorerFamily: '2.16'
        });
        // Partial coverage still ranks: the score carries its penalties, the note says what is missing.
        expect(verdictFor(scored({ fullScopeEligible: false }), '2.16')).toMatchObject({
            comparable: true, reasons: [], notes: [VERDICT_REASON.PARTIAL_SCOPE]
        });
        expect(verdictFor(scored({ scorerVersions: { unversioned: 42 }, performance: { scorerVersions: { unversioned: 42 } } }), '2.16').reasons)
            .toEqual([VERDICT_REASON.UNVERSIONED_SCORER]);
        expect(verdictFor(scored({ scorerVersions: { '2.15.3': 42 } }), '2.16').reasons).toEqual([VERDICT_REASON.SCORER_FAMILY_MISMATCH]);
        // Patch releases share a generation.
        expect(verdictFor(scored({ scorerVersions: { '2.16.4': 42 } }), '2.16').comparable).toBe(true);
        expect(verdictFor(scored({ rankable: true, generalistScore: null }), '2.16').reasons).toEqual([VERDICT_REASON.NO_SCORE]);
    });

    test('a row the service already unranked keeps its own reason, never an empty one', () => {
        expect(verdictFor(scored({ rankable: false, filterReason: 'mixed_scorer_versions' }), '2.16').reasons).toEqual(['mixed_scorer_versions']);
        expect(verdictFor(scored({ filtered: true, filterReason: 'excessive_empty_responses', generalistScore: 0 }), '2.16').reasons)
            .toEqual(['excessive_empty_responses']);
        expect(verdictFor(scored({ rankable: false, filterReason: null }), '2.16').reasons).toEqual([VERDICT_REASON.NOT_RANKABLE]);
        expect(verdictFor(otherCohort(1), '2.16')).toMatchObject({ comparable: false, reasons: ['quality_cohort_fingerprint_mismatch'], scorerVersion: '2.15.0' });
    });

    test('the board scorer generation is that of the newest scored, rankable evidence in the selected cohort', () => {
        const rows = [
            scored({ model: 'old', scorerVersions: { '2.15.0': 10 }, latestTimestamp: '2026-09-01T00:00:00.000Z' }),
            scored({ model: 'new', scorerVersions: { '2.16.0': 10 }, latestTimestamp: '2026-09-21T00:00:00.000Z' }),
            scored({ model: 'newest-but-other-cohort', qualityCohortFingerprint: 'x', scorerVersions: { '2.17.0': 1 }, latestTimestamp: '2026-09-22T00:00:00.000Z' })
        ];
        expect(comparisonScorerFamily(rows, SELECTED)).toBe('2.16');
        expect(comparisonScorerFamily(rows, null)).toBe('2.17');
        expect(comparisonScorerFamily([], SELECTED)).toBeNull();
        expect(dominantScorerVersion({ scorerVersions: { unversioned: 5, '2.16.0': 2, '2.16.1': 2 } })).toBe('2.16.0');
        expect(dominantScorerVersion({ scorerVersions: {}, performance: { scorerVersions: { '2.14.0': 1 } } })).toBe('2.14.0');
        expect(dominantScorerVersion({ scorerVersions: { unversioned: 3 } })).toBeNull();
    });
});

describe('ranking', () => {
    test('ranks comparable groups by score and lists the others after them without a rank', () => {
        const rows = [
            scored({ model: 'partial', generalistScore: 85, fullScopeEligible: false }),
            scored({ model: 'second', generalistScore: 80 }),
            scored({ model: 'first', generalistScore: 90 }),
            scored({ model: 'mixed', generalistScore: 99, rankable: false, filterReason: 'mixed_scorer_versions' }),
            otherCohort(1, { model: 'unscored-newer', latestTimestamp: '2026-09-10T00:00:00.000Z', performance: { latestTimestamp: '2026-09-10T00:00:00.000Z' } }),
            otherCohort(2, { model: 'unscored-older', latestTimestamp: '2026-09-01T00:00:00.000Z', performance: { latestTimestamp: '2026-09-01T00:00:00.000Z' } })
        ];
        const result = groupLeaderboard(rows, { selectedQualityCohortFingerprint: SELECTED });
        expect(result.groups.map(group => [group.model, group.rank])).toEqual([
            ['first', 1], ['partial', 2], ['second', 3],
            ['mixed', null], ['unscored-newer', null], ['unscored-older', null]
        ]);
        expect(result).toMatchObject({ comparableCount: 3, groupCount: 6, comparisonScorerFamily: '2.16', selectedQualityCohortFingerprint: SELECTED });
    });

    test('handles an empty board', () => {
        expect(groupLeaderboard([], {})).toEqual({
            groups: [], comparableCount: 0, authoritativeCount: 0, groupCount: 0, comparisonScorerFamily: null, selectedQualityCohortFingerprint: null
        });
    });
});

describe('authoritative verdict', () => {
    const qualified = { status: 'qualified', authoritative: true, causes: [], judges: [] };
    const failed = { status: 'unqualified', authoritative: false, causes: ['calibration_failed_ordering'], judges: [] };
    const unknown = { status: 'unknown', authoritative: false, causes: ['no_calibration_record'], judges: [] };

    test('only a comparable row graded by a qualified judge is authoritative', () => {
        expect(verdictFor(scored({ graderQualification: qualified }), '2.16')).toMatchObject({
            comparable: true, authoritative: true, authorityReasons: [], graderStatus: 'qualified'
        });
        expect(verdictFor(scored({ graderQualification: failed }), '2.16')).toMatchObject({
            comparable: true, authoritative: false, authorityReasons: [VERDICT_REASON.GRADER_UNQUALIFIED],
            graderCauses: ['calibration_failed_ordering']
        });
        expect(verdictFor(scored({ graderQualification: unknown }), '2.16')).toMatchObject({
            comparable: true, authoritative: false, authorityReasons: [VERDICT_REASON.GRADER_UNKNOWN]
        });
        // A qualified grader never rescues a non-comparable row.
        expect(verdictFor(scored({ graderQualification: qualified, rankable: false, filterReason: 'mixed_scorer_versions' }), '2.16'))
            .toMatchObject({ comparable: false, authoritative: false, authorityReasons: [] });
    });

    test('ranks stay in score order; the raw score of a provisional row is untouched', () => {
        const rows = [
            scored({ model: 'provisional', generalistScore: 90, graderQualification: failed }),
            scored({ model: 'authoritative', generalistScore: 80, graderQualification: qualified })
        ];
        const result = groupLeaderboard(rows, { selectedQualityCohortFingerprint: SELECTED });
        expect(result.groups.map(group => [group.model, group.rank, group.authoritative, group.headline.generalistScore]))
            .toEqual([['provisional', 1, false, 90], ['authoritative', 2, true, 80]]);
        expect(result).toMatchObject({ comparableCount: 2, authoritativeCount: 1 });
    });
});
