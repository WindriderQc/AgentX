const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG } = require('../qualityScorer');
const { classifyBenchmarkError } = require('./errorClassifier');
const { multiJudgeScore, shouldEscalateToMultiJudge } = require('./multiJudge');

function buildPromptData(result, originalPrompt) {
    return {
        prompt: result.prompt,
        name: result.prompt_name,
        level: result.prompt_level,
        category: result.prompt_category,
        expected_answer: result.expected_answer,
        scoring_type: result.scoring_type,
        deterministic_scoring: result.deterministic_scoring,
        scoring_dimensions: result.scoring_dimensions || originalPrompt?.scoring_dimensions || undefined,
        reference_answer: result.reference_answer || originalPrompt?.reference_answer || undefined,
        output_contract: result.output_contract || originalPrompt?.output_contract || undefined,
        judge_criteria: result.judge_criteria || originalPrompt?.judge_criteria || undefined,
        required_judge_tier: result.required_judge_tier || originalPrompt?.required_judge_tier || undefined
    };
}

function buildResultScoreContext(result) {
    return {
        latency: result.latency,
        tokens_per_sec: result.tokens_per_sec,
        prompt_category: result.prompt_category,
        scoring_type: result.scoring_type
    };
}

async function findOriginalPrompt(result) {
    if (!result.prompt_name || result.prompt_snapshot_embedded) {
        return null;
    }

    return BenchmarkPrompt.findOne({ name: result.prompt_name })
        .select('scoring_dimensions reference_answer output_contract judge_criteria required_judge_tier')
        .lean();
}

async function persistMultiJudgeScores(resultId, multiJudgeResult) {
    const judgeScoreRecords = multiJudgeResult.scores
        .filter((score) => score.success)
        .map((score) => ({
            judge_model: score.judge_model,
            judge_host: score.judge_host,
            judge_tier: score.judge_tier,
            quality_score: score.quality_score,
            explanation: score.explanation,
            scoring_time_ms: score.scoring_time_ms
        }));

    await BenchmarkResult.updateOne(
        { _id: resultId },
        { $set: { judge_scores: judgeScoreRecords } }
    );
}

function buildConsensusReviewReason(baseScores, multiJudgeResult) {
    return [
        baseScores.review_reason || null,
        multiJudgeResult.divergent ? `Multi-judge divergence ${multiJudgeResult.divergence}` : null,
        multiJudgeResult.tiebreakerUsed ? 'Escalated to tiebreaker judge' : null
    ].filter(Boolean).join('; ');
}

function buildConsensusConfidence(baseScores, consensus) {
    if (consensus === 'agreement') {
        return Math.max(baseScores.judge_confidence || 0, 0.9);
    }

    if (consensus === 'tiebreaker_resolved') {
        return Math.max(baseScores.judge_confidence || 0, 0.85);
    }

    return Math.min(baseScores.judge_confidence ?? 0.6, 0.6);
}

async function applyScoresToResult(resultId, scores, resultData) {
    const categoryOrProfile = resultData.prompt_category || 'interactive';
    const composite = calculateCompositeScore({
        latency: resultData.latency,
        tokens_per_sec: resultData.tokens_per_sec,
        quality_score: scores.quality_score
    }, categoryOrProfile);

    const truncationUpdate = scores.truncation ? {
        'truncation.judge_truncated': scores.truncation.judge_truncated,
        'truncation.judge_tokens': scores.truncation.judge_tokens
    } : {};

    const isJudgeFailed = scores.scoring_method === 'llm_failed';
    let judgeFailureUpdate = {};
    if (isJudgeFailed) {
        const judgeErrorMessage = scores.error || scores.explanation || 'Judge failed';
        const classified = classifyBenchmarkError(judgeErrorMessage);
        judgeFailureUpdate = {
            error: judgeErrorMessage,
            infra_error: classified.infra,
            error_type: classified.type,
            error_http_status: classified.httpStatus
        };
    }

    await BenchmarkResult.updateOne(
        { _id: resultId },
        {
            $set: {
                quality_score: scores.quality_score,
                quality_breakdown: scores.breakdown,
                quality_explanation: scores.explanation,
                judge_prompt: scores.judge_prompt,
                judge_model: scores.judge_model,
                judge_raw_response: scores.judge_raw_response,
                judge_hardware_snapshot: scores.judge_hardware_snapshot || null,
                judge_tier: scores.judge_tier || null,
                judge_tier_downgraded: scores.judge_tier_downgraded || false,
                judge_consensus: scores.judge_consensus || null,
                judge_divergence: scores.judge_divergence !== undefined ? scores.judge_divergence : null,
                judge_tiebreaker_used: !!scores.judge_tiebreaker_used,
                judge_escalated: !!scores.judge_escalated,
                scoring_method: scores.scoring_method,
                scoring_type: scores.scoring_type || resultData.scoring_type || 'reasoning',
                scoring_time_ms: scores.scoring_time_ms,
                quick_pattern: scores.quick_pattern,
                composite_score: composite.composite_score,
                composite_profile_used: composite.composite_profile_used,
                normalized_scores: composite.normalized,
                accuracy_score: scores.accuracy_score !== undefined ? scores.accuracy_score : null,
                compliance_score: scores.compliance_score !== undefined ? scores.compliance_score : null,
                semantic_score: scores.semantic_score !== undefined ? scores.semantic_score : null,
                format_score: scores.format_score !== undefined ? scores.format_score : null,
                format_compliant: scores.format_compliant !== undefined ? scores.format_compliant : null,
                judge_confidence: scores.judge_confidence,
                prompt_complexity: scores.prompt_complexity,
                needs_review: scores.needs_review || false,
                review_reason: scores.review_reason || null,
                ...truncationUpdate,
                ...judgeFailureUpdate
            }
        }
    );

    return {
        quality_score: scores.quality_score,
        scoring_method: scores.scoring_method,
        composite_score: composite.composite_score,
        judge_confidence: scores.judge_confidence,
        needs_review: scores.needs_review || false
    };
}

async function judgeResult(resultId, judgeConfig = {}, batchHardwareSnapshot = null, multiJudgeConfig = null) {
    const result = await BenchmarkResult.findById(resultId);
    if (!result) {
        throw new Error(`Result not found: ${resultId}`);
    }
    if (!result.success) {
        throw new Error('Cannot judge failed test executions');
    }
    if (!result.response) {
        throw new Error('No response to judge');
    }

    const originalPrompt = await findOriginalPrompt(result);
    const promptData = buildPromptData(result, originalPrompt);
    const resultData = buildResultScoreContext(result);
    const mergedConfig = {
        model: judgeConfig.model || result.judge_model || JUDGE_CONFIG.model,
        host: judgeConfig.host || result.judge_host || JUDGE_CONFIG.host
    };

    const baseScores = await scoreResponse({
        response: result.response,
        prompt: promptData,
        judgeConfig: mergedConfig,
        _batchHardwareSnapshot: batchHardwareSnapshot
    });

    const useMultiJudge = shouldEscalateToMultiJudge({
        category: result.prompt_category,
        scoringMethod: baseScores.scoring_method,
        judgeConfidence: baseScores.judge_confidence,
        needsReview: baseScores.needs_review,
        multiJudgeConfig
    });

    if (!useMultiJudge) {
        return applyScoresToResult(resultId, baseScores, resultData);
    }

    const multiJudgeResult = await multiJudgeScore({
        response: result.response,
        prompt: promptData,
        judges: multiJudgeConfig.judges,
        tiebreakerJudge: multiJudgeConfig.tiebreaker || null,
        _batchHardwareSnapshot: batchHardwareSnapshot,
        seedJudgeResult: {
            judge_model: baseScores.judge_model || mergedConfig.model,
            judge_host: baseScores.judge_host || mergedConfig.host,
            judge_tier: baseScores.judge_tier || 'unknown',
            quality_score: baseScores.quality_score,
            explanation: baseScores.explanation,
            scoring_time_ms: baseScores.scoring_time_ms,
            scoring_method: baseScores.scoring_method,
            success: baseScores.quality_score !== null && baseScores.quality_score !== undefined
        }
    });

    await persistMultiJudgeScores(resultId, multiJudgeResult);

    const consensusConfidence = buildConsensusConfidence(baseScores, multiJudgeResult.consensus);
    const consensusNeedsReview = multiJudgeResult.consensus === 'divergent_unresolved';
    const consensusReviewReason = buildConsensusReviewReason(baseScores, multiJudgeResult);

    return applyScoresToResult(resultId, {
        ...baseScores,
        quality_score: multiJudgeResult.finalScore !== null
            ? multiJudgeResult.finalScore
            : baseScores.quality_score,
        explanation: `[Multi-judge consensus: ${multiJudgeResult.consensus}] ${baseScores.explanation || ''}`.trim(),
        judge_confidence: Math.round(consensusConfidence * 100) / 100,
        needs_review: consensusNeedsReview,
        review_reason: consensusNeedsReview
            ? (consensusReviewReason || 'Multi-judge disagreement requires review')
            : (consensusReviewReason || baseScores.review_reason || null),
        judge_consensus: multiJudgeResult.consensus,
        judge_divergence: multiJudgeResult.divergence ?? null,
        judge_tiebreaker_used: !!multiJudgeResult.tiebreakerUsed,
        judge_escalated: true
    }, resultData);
}

module.exports = {
    applyScoresToResult,
    judgeResult
};
