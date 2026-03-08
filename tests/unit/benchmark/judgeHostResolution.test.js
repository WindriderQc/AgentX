jest.mock('../../../src/services/modelRouter', () => ({
    HOSTS: {
        primary: 'http://primary-host:11434',
        secondary: ''
    }
}));

const { resolveJudgeHost } = require('../../../src/services/benchmark/judgeHostResolution');

describe('resolveJudgeHost', () => {
    it('prefers an explicit judge host override', () => {
        const result = resolveJudgeHost('http://exec-host:11434', {
            host: 'http://judge-host:11434',
            judge_same_host: true
        });

        expect(result).toEqual({
            judgeHost: 'http://judge-host:11434',
            effectiveJudgeSameHost: false,
            resolution: 'explicit'
        });
    });

    it('uses same-host judging when requested', () => {
        const result = resolveJudgeHost('http://exec-host:11434', {
            judge_same_host: true
        });

        expect(result).toEqual({
            judgeHost: 'http://exec-host:11434',
            effectiveJudgeSameHost: true,
            resolution: 'same_host'
        });
    });

    it('uses the primary judge host for non-primary execution hosts', () => {
        const result = resolveJudgeHost('http://custom-exec:11434', {});

        expect(result).toEqual({
            judgeHost: 'http://primary-host:11434',
            effectiveJudgeSameHost: false,
            resolution: 'cross_host'
        });
    });

    it('falls back to same-host judging when no alternate host exists', () => {
        const result = resolveJudgeHost('http://primary-host:11434', {});

        expect(result).toEqual({
            judgeHost: 'http://primary-host:11434',
            effectiveJudgeSameHost: true,
            resolution: 'fallback_same_host'
        });
    });
});
