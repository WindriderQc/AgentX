/**
 * Roundtable Rendering Module
 * Extracted from index.js for file-size discipline.
 * Handles turn cards, waiting cards, round dividers, synthesis, and discussion start rendering.
 */

/** @type {ReturnType<typeof initRendering>} */
let ctx;

/**
 * Initialize the rendering module with shared context
 * @param {Object} deps
 * @param {Object} deps.$ - DOM refs map
 * @param {Object} deps.AGENT_CONFIG - Agent display config
 * @param {Object} deps.AGENT_SELECTS - Agent select element IDs
 * @param {Function} deps.escapeHtml
 * @param {Function} deps.formatDuration
 */
export function initRendering(deps) {
  ctx = deps;
  return {
    renderDiscussionStart,
    renderRoundDivider,
    renderWaitingCard,
    renderTurnCard,
    renderSynthesisCard,
    getMaxRenderedRound
  };
}

function renderDiscussionStart(doc, renderStats) {
  const { $, escapeHtml } = ctx;

  $.rtStatsRow.style.display = '';
  $.rtDiscussionPanel.style.display = '';
  $.rtTranscriptActions.style.display = 'none';

  $.rtDiscussionTitle.textContent = doc.question;
  $.rtDiscussionMeta.innerHTML = `
    <span><i class="fas fa-hashtag"></i> ${escapeHtml(doc._id)}</span>
    <span><i class="fas fa-layer-group"></i> ${doc.rounds} round${doc.rounds > 1 ? 's' : ''}</span>
  `;

  $.rtTurnsContainer.innerHTML = '';
  $.rtSynthesisContainer.innerHTML = '';

  renderRoundDivider(1);
  const agentIds = Object.keys(ctx.AGENT_CONFIG);
  for (const agentId of agentIds) {
    renderWaitingCard(agentId, 1);
  }

  renderStats({ status: 'running', turns: [], totalDurationMs: null });
  $.rtDiscussionPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRoundDivider(roundNum) {
  const { $ } = ctx;
  const div = document.createElement('div');
  div.className = 'rt-round-divider';
  div.dataset.round = roundNum;
  const label = roundNum === 1 ? 'Round 1 — Initial Analysis' : `Round ${roundNum} — Rebuttal`;
  div.innerHTML = `<span class="rt-round-label">${label}</span>`;
  $.rtTurnsContainer.appendChild(div);
}

function renderWaitingCard(agentId, round) {
  const { $, AGENT_CONFIG, AGENT_SELECTS, escapeHtml } = ctx;
  const cfg = AGENT_CONFIG[agentId] || { icon: 'fa-robot', label: agentId, color: '#888' };
  const ids = AGENT_SELECTS[agentId];
  const customRole = ids && $[ids.role] ? $[ids.role].value.trim() : '';
  const displayLabel = customRole || cfg.label;
  const card = document.createElement('div');
  card.className = 'rt-turn-card waiting';
  card.dataset.role = agentId;
  card.dataset.round = round;
  card.dataset.agent = agentId;
  card.innerHTML = `
    <div class="rt-turn-header">
      <div class="rt-agent-icon ${agentId}"><i class="fas ${cfg.icon}"></i></div>
      <div>
        <div class="rt-turn-agent">${escapeHtml(displayLabel)}</div>
      </div>
    </div>
    <div class="rt-turn-body">
      <span class="rt-turn-waiting-text">Waiting...</span>
    </div>
  `;
  $.rtTurnsContainer.appendChild(card);
}

function renderTurnCard(turn, animate) {
  const { $, AGENT_CONFIG, escapeHtml, formatDuration } = ctx;

  const existing = $.rtTurnsContainer.querySelector(
    `.rt-turn-card[data-agent="${turn.agentId}"][data-round="${turn.round}"]`
  );

  const maxRenderedRound = getMaxRenderedRound();
  if (turn.round > maxRenderedRound) {
    renderRoundDivider(turn.round);
    for (const agentId of Object.keys(AGENT_CONFIG)) {
      renderWaitingCard(agentId, turn.round);
    }
  }

  const cfg = AGENT_CONFIG[turn.agentId] || { icon: 'fa-robot', label: turn.agentId, color: '#888' };
  const displayLabel = turn.role || cfg.label;
  const hasError = !!turn.error;
  const cardClass = hasError ? 'error' : (animate ? 'done' : '');

  const card = document.createElement('div');
  card.className = `rt-turn-card ${cardClass}`;
  card.dataset.role = turn.agentId;
  card.dataset.round = turn.round;
  card.dataset.agent = turn.agentId;

  const stats = turn.stats || {};
  const tps = stats.tokensPerSecond ? stats.tokensPerSecond.toFixed(1) : '—';
  const latency = stats.latencyMs ? formatDuration(stats.latencyMs) : '—';

  let thinkingHtml = '';
  if (turn.thinking) {
    thinkingHtml = `
      <div class="rt-turn-thinking">
        <div class="rt-turn-thinking-toggle" onclick="this.parentElement.classList.toggle('open')">
          <i class="fas fa-chevron-right"></i> Thinking
        </div>
        <div class="rt-turn-thinking-content">${escapeHtml(turn.thinking)}</div>
      </div>
    `;
  }

  let webSearchHtml = '';
  if (turn.webSearchResults && turn.webSearchResults.length > 0) {
    const sourcesHtml = turn.webSearchResults.map(r =>
      `<div><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>${r.snippet ? ` — ${escapeHtml(r.snippet)}` : ''}</div>`
    ).join('');
    webSearchHtml = `
      <div class="rt-turn-websearch">
        <div class="rt-turn-websearch-toggle" onclick="this.parentElement.classList.toggle('open')">
          <i class="fas fa-chevron-right"></i> <i class="fas fa-globe"></i> Web Sources (${turn.webSearchResults.length})
        </div>
        <div class="rt-turn-websearch-content">${sourcesHtml}</div>
      </div>
    `;
  }

  card.innerHTML = `
    <div class="rt-turn-header">
      <div class="rt-agent-icon ${turn.agentId}"><i class="fas ${cfg.icon}"></i></div>
      <div>
        <div class="rt-turn-agent">${escapeHtml(displayLabel)}</div>
        ${turn.model ? `<div class="rt-turn-model">${escapeHtml(turn.model)}</div>` : ''}
      </div>
      <div class="rt-turn-stats">
        <span><i class="fas fa-gauge-high"></i> ${tps} t/s</span>
        <span><i class="fas fa-clock"></i> ${latency}</span>
      </div>
    </div>
    <div class="rt-turn-body">${hasError ? `<span style="color:var(--danger)">${escapeHtml(turn.error)}</span>` : escapeHtml(turn.response || '')}</div>
    ${thinkingHtml}
    ${webSearchHtml}
  `;

  if (existing) {
    existing.replaceWith(card);
  } else {
    const waitingCard = $.rtTurnsContainer.querySelector(
      `.rt-turn-card.waiting[data-agent="${turn.agentId}"][data-round="${turn.round}"]`
    );
    if (waitingCard) {
      waitingCard.replaceWith(card);
    } else {
      $.rtTurnsContainer.appendChild(card);
    }
  }
}

function renderSynthesisCard(synthesis) {
  const { $, escapeHtml, formatDuration } = ctx;
  const existing = $.rtSynthesisContainer.querySelector('.rt-synthesis-card');

  const stats = synthesis.stats || {};
  const tps = stats.tokensPerSecond ? stats.tokensPerSecond.toFixed(1) : '—';
  const latency = stats.latencyMs ? formatDuration(stats.latencyMs) : '—';
  const hasError = !!synthesis.error;

  let thinkingHtml = '';
  if (synthesis.thinking) {
    thinkingHtml = `
      <div class="rt-turn-thinking">
        <div class="rt-turn-thinking-toggle" onclick="this.parentElement.classList.toggle('open')">
          <i class="fas fa-chevron-right"></i> Thinking
        </div>
        <div class="rt-turn-thinking-content">${escapeHtml(synthesis.thinking)}</div>
      </div>
    `;
  }

  const card = document.createElement('div');
  card.className = `rt-synthesis-card ${hasError ? 'error' : 'done'}`;
  card.innerHTML = `
    <div class="rt-turn-header">
      <div class="rt-agent-icon synthesizer"><i class="fas fa-gavel"></i></div>
      <div>
        <div class="rt-turn-agent">Synthesis</div>
        ${synthesis.model ? `<div class="rt-turn-model">${escapeHtml(synthesis.model)}</div>` : ''}
      </div>
      <div class="rt-turn-stats">
        <span><i class="fas fa-gauge-high"></i> ${tps} t/s</span>
        <span><i class="fas fa-clock"></i> ${latency}</span>
      </div>
    </div>
    <div class="rt-turn-body">${hasError ? `<span style="color:var(--danger)">${escapeHtml(synthesis.error)}</span>` : escapeHtml(synthesis.response || '')}</div>
    ${thinkingHtml}
  `;
  if (existing) {
    existing.replaceWith(card);
  } else {
    $.rtSynthesisContainer.appendChild(card);
  }
}

function getMaxRenderedRound() {
  const dividers = ctx.$.rtTurnsContainer.querySelectorAll('.rt-round-divider');
  let max = 0;
  for (const d of dividers) {
    const r = parseInt(d.dataset.round);
    if (r > max) max = r;
  }
  return max;
}
