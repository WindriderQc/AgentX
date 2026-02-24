/**
 * Roundtable Quality Score Rendering
 * Renders LLM-as-Judge quality badges on turn cards and synthesis.
 */

/**
 * Initialize quality scores module
 * @param {Object} deps - { $, escapeHtml }
 * @returns {Object} { renderQualityScores }
 */
export function initQualityScores(deps) {
  const { $ } = deps;

  function formatScore(score) {
    if (typeof score !== 'number') return '—';
    return score.toFixed(1);
  }

  function createQualityBadge(score) {
    const badge = document.createElement('span');
    const tier = score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
    badge.className = `rt-quality-badge ${tier}`;
    badge.innerHTML = `<i class="fas fa-star" style="font-size:9px"></i> ${typeof score === 'number' ? score.toFixed(1) : '—'}/10`;
    return badge;
  }

  function renderQualityScores(doc) {
    const scores = doc.qualityScores;
    if (!scores) return;

    // Add badges to turn cards
    if (scores.agents) {
      for (const [agentId, agentScore] of Object.entries(scores.agents)) {
        if (typeof agentScore.overall !== 'number') continue;

        const cards = $.rtTurnsContainer.querySelectorAll(`.rt-turn-card[data-agent="${agentId}"]`);
        const lastCard = cards[cards.length - 1];
        if (lastCard && !lastCard.querySelector('.rt-quality-badge')) {
          const badge = createQualityBadge(agentScore.overall);
          const header = lastCard.querySelector('.rt-turn-stats');
          if (header) header.appendChild(badge);

          const body = lastCard.querySelector('.rt-turn-body');
          if (body && !lastCard.querySelector('.rt-quality-breakdown')) {
            const breakdown = document.createElement('div');
            breakdown.className = 'rt-quality-breakdown';
            breakdown.innerHTML = `
              <span title="How clear and well-structured the response is">Clarity: ${formatScore(agentScore.clarity)}</span>
              <span title="Quality of reasoning, examples, and supporting arguments">Evidence: ${formatScore(agentScore.evidence_quality)}</span>
              <span title="Logical consistency and flow of the argument">Coherence: ${formatScore(agentScore.logical_coherence)}</span>
            `;
            body.after(breakdown);
          }
        }
      }
    }

    // Add badge to synthesis card
    if (scores.synthesis && typeof scores.synthesis.overall === 'number') {
      const synthCard = $.rtSynthesisContainer.querySelector('.rt-synthesis-card');
      if (synthCard && !synthCard.querySelector('.rt-quality-badge')) {
        const badge = createQualityBadge(scores.synthesis.overall);
        const header = synthCard.querySelector('.rt-turn-stats');
        if (header) header.appendChild(badge);

        const body = synthCard.querySelector('.rt-turn-body');
        if (body && !synthCard.querySelector('.rt-quality-breakdown')) {
          const breakdown = document.createElement('div');
          breakdown.className = 'rt-quality-breakdown';
          breakdown.innerHTML = `
            <span title="How well the synthesis covers all panel perspectives">Coverage: ${formatScore(scores.synthesis.coverage)}</span>
            <span title="Balance in representing each agent's viewpoint">Fairness: ${formatScore(scores.synthesis.fairness)}</span>
            <span title="How concrete and actionable the recommendation is">Actionability: ${formatScore(scores.synthesis.actionability)}</span>
          `;
          body.after(breakdown);
        }
      }
    }

    // Add summary bar
    if (!$.rtSynthesisContainer.querySelector('.rt-quality-summary')) {
      const agentOveralls = scores.agents ? Object.values(scores.agents).map(s => s.overall).filter(s => typeof s === 'number' && s > 0) : [];
      const avgAgent = agentOveralls.length > 0 ? (agentOveralls.reduce((a, b) => a + b, 0) / agentOveralls.length) : null;
      const synthOverall = scores.synthesis?.overall;
      const agreement = scores.agreementIndex;

      const summary = document.createElement('div');
      summary.className = 'rt-quality-summary';
      let inner = '<span class="rt-quality-label" title="LLM-as-Judge — an AI evaluates response quality after completion"><i class="fas fa-star"></i> Quality Scores</span>';
      if (avgAgent !== null) inner += `<span>Avg Agent: ${createQualityBadge(avgAgent).outerHTML}</span>`;
      if (typeof synthOverall === 'number') inner += `<span>Synthesis: ${createQualityBadge(synthOverall).outerHTML}</span>`;
      if (typeof agreement === 'number') inner += `<span title="How much the panel agents converged on key points">Agreement: ${(agreement * 100).toFixed(0)}%</span>`;
      summary.innerHTML = inner;
      $.rtSynthesisContainer.appendChild(summary);
    }
  }

  return { renderQualityScores };
}
