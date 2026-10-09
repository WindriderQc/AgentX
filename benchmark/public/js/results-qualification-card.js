// results-qualification-card.js — the qualification card of one result in the
// Test Inspector. The server builds the card (GET /api/benchmark/results/:id,
// `qualification_card`); this file only renders its five sections so a reader
// can tell a weak answer from an unqualified grader, a broken environment or
// missing proof. The raw score is always shown, whatever the verdict.

(function () {
    const STATUS_TONE = {
        completed: 'ok', ok: 'ok', scored: 'ok', qualified: 'ok', complete: 'ok', not_applicable: 'ok',
        failed: 'bad', unqualified: 'bad', missing: 'bad', unreliable_on_result: 'bad',
        not_measured: 'warn', not_evaluated: 'warn', pending: 'warn', not_scored: 'warn', unknown: 'warn'
    };

    const REASON_TEXT = {
        environment_failed: 'the environment failed, so the model was not measured',
        environment_unknown: 'the failure cause is unknown',
        product_behavior_unknown: 'whether the model answered is unknown',
        grade_missing: 'the answer has no grade yet',
        grader_unqualified: 'the grader is not qualified for this scorer version (failed calibration or not recorded)',
        grader_unknown: 'no complete calibration covers this judge and scorer version',
        grader_unreliable_on_result: 'the grader is qualified but did not hold up on this answer',
        evidence_missing: 'some proof is missing',
        excluded_from_leaderboard: 'the result is excluded from the leaderboard'
    };

    const CAUSE_TEXT = {
        judge_contract_missing: 'the verdict does not record its complete judge execution settings',
        no_calibration_for_contract: 'no calibration covers this exact judge artifact, runtime and settings',
        judge_identity_missing: 'the result does not record its judge',
        scorer_version_missing: 'the result carries no scorer version',
        no_calibration_record: 'this judge has never been calibrated',
        calibration_for_other_scorer_version: 'this judge was calibrated only under another scorer version',
        calibration_incomplete: 'its latest calibration did not finish',
        calibration_reference_set_changed: 'its calibration used an older reference set',
        calibration_failed_ordering: 'calibration failed on pairwise ordering',
        calibration_failed_mae: 'calibration failed on mean absolute error',
        calibration_failed_identity: 'calibration marked a reference answer down',
        calibration_failed_attention: 'calibration failed a known-answer probe',
        attention_check_failed: 'the judge failed the known-answer probe on this answer',
        needs_review: 'the answer is flagged for human review',
        grader_llm_failed: 'the judge output was incomplete',
        grader_authority_invalidated: 'the judge authority was invalidated'
    };

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function label(status) {
        return String(status || 'unknown').replace(/_/g, ' ');
    }

    function score(value) {
        return value === null || value === undefined ? '—' : Number(value).toFixed(2);
    }

    function section(title, status, body) {
        const tone = STATUS_TONE[status] || 'warn';
        return `<div class="qc-section qc-${tone}">
            <dt>${esc(title)} <span class="qc-status">${esc(label(status))}</span></dt>
            <dd>${body}</dd>
        </div>`;
    }

    function causeList(causes) {
        if (!causes || !causes.length) return '';
        return `<ul class="qc-causes">${causes.map(code => `<li data-cause="${esc(code)}">${esc(CAUSE_TEXT[code] || code)}</li>`).join('')}</ul>`;
    }

    function renderQualificationCard(result) {
        const card = result && result.qualification_card;
        if (!card) {
            return `<section class="qc-card qc-card-unknown" aria-label="Qualification card">
                <h4>Qualification card unavailable</h4>
                <p>The server returned no card for this result, so nothing here is authoritative.</p>
            </section>`;
        }
        const quality = card.model_quality || {};
        const grader = card.grader || {};
        const judge = grader.judge || {};
        const qualification = grader.qualification || {};
        const record = (qualification.judges || [])[0]?.record || null;
        const environment = card.environment || {};
        const evidence = card.evidence || {};
        const verdict = card.authoritative
            ? 'Authoritative: every section allows this result to count.'
            : `Not authoritative: ${(card.reasons || []).map(code => REASON_TEXT[code] || code).join('; ') || 'no reason recorded'}.`;

        const qualityBody = `raw ${esc(score(quality.quality_score))}`
            + ` · composite ${esc(score(quality.composite_score))}`
            + (quality.judge_quality_score !== null && quality.judge_quality_score !== undefined ? ` · judge before override ${esc(score(quality.judge_quality_score))}` : '')
            + (quality.correctness_source ? ` · correctness from ${esc(quality.correctness_source)}` : '')
            + (quality.scoring_method ? ` · method ${esc(quality.scoring_method)}` : '');
        const graderBody = grader.status === 'not_applicable'
            ? 'No LLM judge graded this answer.'
            : `${esc(judge.model || 'unknown judge')} @ ${esc(judge.host || 'unknown host')} · scorer ${esc(grader.scorer_version || 'unknown')}`
              + (record ? ` · calibration ${esc((record.recorded_at || '').slice(0, 10))}${record.metrics ? `, ordering ${esc(record.metrics.ordering_ties_half ?? '—')} %, MAE ${esc(record.metrics.mae ?? '—')}` : ''}` : '')
              + causeList(grader.causes);
        const environmentBody = environment.diagnostic
            ? `${esc(environment.diagnostic.category)} · next: ${esc(environment.diagnostic.nextAction)}`
            : 'No infrastructure failure recorded.';
        const evidenceBody = evidence.status === 'not_evaluated'
            ? 'Not evaluated: the run did not produce an answer to prove.'
            : evidence.missing && evidence.missing.length
                ? `Missing: ${esc(evidence.missing.join(', '))}`
                : 'Response, scorer version and grader identity are recorded.';
        const product = card.product_behavior || {};

        return `<section class="qc-card ${card.authoritative ? 'qc-card-authoritative' : 'qc-card-provisional'}" aria-label="Qualification card">
            <h4>${esc(verdict)}</h4>
            <dl class="qc-sections">
                ${section('Product behavior', product.status, esc(product.detail ? label(product.detail) : 'The model produced an answer.'))}
                ${section('Model quality', quality.status, qualityBody)}
                ${section('Grader', grader.status, graderBody)}
                ${section('Environment', environment.status, environmentBody)}
                ${section('Evidence', evidence.status, evidenceBody)}
            </dl>
        </section>`;
    }

    window.renderQualificationCard = renderQualificationCard;
})();
