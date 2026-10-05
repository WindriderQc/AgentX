'use strict';

/**
 * Review reasons set when a result is executed, before any judge runs. A
 * re-judge keeps these and replaces everything a previous judge added, so a
 * judge failure that a later judge resolves does not flag the result forever.
 */
const EXECUTION_REVIEW_REASONS = Object.freeze({
    hiddenRuntimeCap: 'Response hit a hidden runtime token cap; the prompt did not expose a response budget, so the row is invalid for automatic quality ranking',
    thinkingOnly: 'Thinking mode produced hidden reasoning but no visible final answer; hidden thinking is preserved for audit but not scored',
    thinkingBudgetExhausted: 'Generation reached its token budget while hidden reasoning was present; the visible answer may be incomplete. This does not establish runaway reasoning',
    // Preserve the execution reason on historical rows during rejudging.
    thinkingRunaway: 'Thinking mode hit the generation token limit while hidden reasoning was present; the visible final answer may be incomplete or starved',
    inputTruncated: 'Prompt likely hit the input context budget before generation; judge cannot know whether the model saw the full task',
    nonRankableMode: 'Campaign mode is diagnostic/profile-only under the frozen artifact contract and is not rankable',
    executableFixture: fixtureId => `Correctness requires executable repository fixture ${fixtureId || '(missing fixture id)'}; LLM judge output is advisory only`
});

const EXECUTION_REASON_PREFIXES = Object.values(EXECUTION_REVIEW_REASONS)
    .map(reason => (typeof reason === 'function' ? reason('') : reason).split(/[;(]/)[0].trim());

/** The execution-time part of a stored review reason, or null. */
function executionReviewReason(reviewReason) {
    const parts = String(reviewReason || '').split(';').map(part => part.trim()).filter(Boolean);
    // An executable-fixture reason contains its own "; LLM judge output..." tail.
    const kept = [];
    for (let i = 0; i < parts.length; i += 1) {
        if (EXECUTION_REASON_PREFIXES.some(prefix => parts[i].startsWith(prefix))) {
            kept.push(parts[i]);
            if (parts[i + 1] === 'LLM judge output is advisory only') kept.push(parts[++i]);
        }
    }
    return kept.length > 0 ? kept.join('; ') : null;
}

module.exports = { EXECUTION_REVIEW_REASONS, executionReviewReason };
