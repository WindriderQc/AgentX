/**
 * Batch Planner
 * Builds execution plans from batch configuration
 */

const { JUDGE_CONFIG } = require('../qualityScorer');
const { HOSTS } = require('../modelRouter');
const { normalizeExecutionConfig } = require('./config');

/**
 * Build execution plan from batch config
 * Determines host-model mapping, judge hosts, and category distribution
 *
 * @param {string} host - Primary execution host
 * @param {Array} models - Models to benchmark
 * @param {Array} selectedPrompts - Prompts to run
 * @param {Object} options - Plan options
 * @returns {Object} { plan, modelsByHost, normalizedExecutionConfig }
 */
function buildExecutionPlan(host, models, selectedPrompts, options = {}) {
    const { quality_scoring = true, judge_config = {}, execution_config = {} } = options;

    // Group models by host
    const modelsByHost = {};
    for (const model of models) {
        const targetHost = host;
        if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
        modelsByHost[targetHost].push(model);
    }

    const judgeSameHost = (judge_config && judge_config.judge_same_host !== undefined)
        ? !!judge_config.judge_same_host
        : false;
    const normalizedExecConfig = normalizeExecutionConfig(execution_config);

    const execHosts = Object.entries(modelsByHost).map(([exec_host, hostModels]) => {
        let judge_host = exec_host;
        if (!judgeSameHost) {
            judge_host = HOSTS.primary;
            if (exec_host === HOSTS.primary) judge_host = HOSTS.secondary;
            else if (exec_host === HOSTS.secondary) judge_host = HOSTS.primary;
        }

        return {
            exec_host,
            judge_host: quality_scoring ? judge_host : null,
            models: hostModels,
            tests: hostModels.length * selectedPrompts.length
        };
    });

    const categoryCounts = {};
    for (const p of selectedPrompts) {
        const cat = p.category || 'uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    const categories = Object.entries(categoryCounts)
        .map(([category, prompt_count]) => ({
            category,
            prompt_count,
            tests: prompt_count * models.length
        }))
        .sort((a, b) => b.tests - a.tests);

    const promptCounts = categories
        .map((c) => Number(c.prompt_count) || 0)
        .filter((n) => n > 0);
    const minPromptsPerCategory = promptCounts.length > 0 ? Math.min(...promptCounts) : 0;
    const maxPromptsPerCategory = promptCounts.length > 0 ? Math.max(...promptCounts) : 0;
    const matrixBalanced = promptCounts.length > 0 && minPromptsPerCategory === maxPromptsPerCategory;
    const totalCategoryPrompts = promptCounts.reduce((sum, n) => sum + n, 0);
    const projectedTests = models.length * totalCategoryPrompts;

    const plan = {
        exec_hosts: execHosts,
        judge_model: (judge_config && judge_config.model) ? judge_config.model : JUDGE_CONFIG.model,
        judge_same_host: judgeSameHost,
        execution_config: normalizedExecConfig,
        total_models: models.length,
        total_prompts: selectedPrompts.length,
        categories,
        workload_summary: {
            category_count: categories.length,
            total_category_prompts: totalCategoryPrompts,
            min_prompts_per_category: minPromptsPerCategory,
            max_prompts_per_category: maxPromptsPerCategory,
            matrix_balanced: matrixBalanced,
            projected_tests: projectedTests
        }
    };

    return { plan, modelsByHost, normalizedExecutionConfig: normalizedExecConfig, judgeSameHost };
}

module.exports = { buildExecutionPlan };
