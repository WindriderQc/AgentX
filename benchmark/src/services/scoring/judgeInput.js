'use strict';

// Preserve complete evidence unless the caller explicitly asks for an excerpt.
// All scoring steps must see the same excerpt and report its actual extent.
function prepareJudgeResponse(response, config = {}) {
    const full = String(response ?? '');
    const limit = Number(config.response_char_budget);
    const text = Number.isInteger(limit) && limit > 0 ? full.slice(0, limit) : full;
    return {
        text,
        evidence: {
            response_truncated_for_judge: text.length < full.length,
            response_chars: full.length,
            judge_window_chars: text.length
        }
    };
}

function assertJudgeInputUnmodified(data) {
    const changes = data?.agentx_contract?.contextBudget?.transformations;
    if (changes?.truncation?.applied === true || changes?.condensation?.applied === true) {
        throw new Error('Judge input was truncated or condensed upstream; quality was not evaluated');
    }
    // A character-based overflow estimate is not proof of a runtime truncation.
    // Keep the existing report-only behavior for that estimate.
}

function assertJudgeOutputComplete(data) {
    // A parseable JSON object or YES/NO prefix is not a completed verdict when
    // the runtime says generation stopped at its limit.
    if (data?.done_reason === 'length' || data?.done === false) {
        throw Object.assign(new Error('Judge output was incomplete; quality was not evaluated'), { code: 'JUDGE_OUTPUT_INCOMPLETE' });
    }
}

// Use the result's existing raw-evidence fields. This is diagnostic evidence,
// not a qualification or an accuracy measurement.
function beginJudgeCallEvidence(config, request) {
    if (!Array.isArray(config.judgeCallEvidence)) return null;
    const call = {
        index: config.judgeCallEvidence.length,
        started_at: new Date().toISOString(),
        host: request.host,
        requested_model: request.model,
        prompt: request.prompt,
        options: { ...request.options },
        think: request.think,
        status: null
    };
    config.judgeCallEvidence.push(call);
    return call;
}

function finishJudgeCallEvidence(call, { status, data, error } = {}) {
    if (!call) return;
    call.duration_ms = Date.now() - Date.parse(call.started_at);
    if (status !== undefined) call.status = status;
    if (error) call.error = String(error.message || error);
    if (data) {
        for (const field of ['model', 'response', 'thinking', 'done', 'done_reason',
            'prompt_eval_count', 'eval_count', 'total_duration', 'load_duration',
            'prompt_eval_duration', 'eval_duration']) {
            call[field] = data[field] ?? null;
        }
        call.artifact = data.agentx_contract?.artifact ?? null;
        call.qualification = data.agentx_contract?.qualification ?? null;
        call.transformations = data.agentx_contract?.contextBudget?.transformations ?? null;
    }
}

function judgeCallEvidenceFields(calls) {
    return {
        judge_prompt: JSON.stringify(calls.map(({ index, prompt }) => ({ index, prompt }))),
        judge_raw_response: JSON.stringify({ version: 1, calls: calls.map(({ prompt, ...call }) => call) })
    };
}

module.exports = { prepareJudgeResponse, assertJudgeInputUnmodified, assertJudgeOutputComplete,
    beginJudgeCallEvidence, finishJudgeCallEvidence, judgeCallEvidenceFields };
