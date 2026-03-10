const { HOSTS } = require('../modelRouter');

function resolveJudgeHost(executionHost, judgeConfig = {}) {
    const execHost = String(executionHost || '').trim();
    const explicitHost = String(judgeConfig.host || '').trim();
    const judgeSameHost = judgeConfig.judge_same_host !== undefined
        ? !!judgeConfig.judge_same_host
        : false;

    if (explicitHost) {
        return {
            judgeHost: explicitHost,
            effectiveJudgeSameHost: explicitHost === execHost,
            resolution: 'explicit'
        };
    }

    if (judgeSameHost) {
        return {
            judgeHost: execHost,
            effectiveJudgeSameHost: true,
            resolution: 'same_host'
        };
    }

    let judgeHost = HOSTS.primary || '';
    if (execHost === HOSTS.primary) {
        judgeHost = HOSTS.secondary || '';
    } else if (execHost === HOSTS.secondary) {
        judgeHost = HOSTS.primary || '';
    }

    if (!judgeHost || judgeHost === execHost) {
        return {
            judgeHost: execHost,
            effectiveJudgeSameHost: true,
            resolution: 'fallback_same_host'
        };
    }

    return {
        judgeHost,
        effectiveJudgeSameHost: false,
        resolution: 'cross_host'
    };
}

module.exports = {
    resolveJudgeHost
};
