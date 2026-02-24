/**
 * Roundtable Comparison View
 * Side-by-side 3-column layout for comparing agent responses across rounds.
 */

/**
 * Initialize comparison view module
 * @param {Object} deps - { $, AGENT_CONFIG, escapeHtml }
 * @returns {Object} { handleViewToggle, renderCompareView, setActiveRoundtable }
 */
export function initCompareView(deps) {
  const { $, AGENT_CONFIG, escapeHtml } = deps;

  let currentView = 'timeline';
  let compareActiveRound = 1;
  let activeRoundtable = null;

  function setActiveRoundtable(doc) {
    activeRoundtable = doc;
  }

  function handleViewToggle(view) {
    if (view === currentView) return;
    currentView = view;

    for (const btn of document.querySelectorAll('.rt-view-btn')) {
      btn.classList.toggle('active', btn.dataset.view === view);
    }

    if (view === 'compare') {
      $.rtTurnsContainer.style.display = 'none';
      $.rtCompareContainer.style.display = '';
      renderCompareView();
    } else {
      $.rtTurnsContainer.style.display = '';
      $.rtCompareContainer.style.display = 'none';
    }
  }

  function renderCompareView() {
    if (!activeRoundtable) return;
    const doc = activeRoundtable;
    const turns = doc.turns || [];
    if (turns.length === 0) return;

    const maxRound = Math.max(...turns.map(t => t.round));
    const agentIds = Object.keys(AGENT_CONFIG);

    // Round tabs
    let tabsHtml = '<div class="rt-compare-round-tabs">';
    for (let r = 1; r <= maxRound; r++) {
      tabsHtml += `<button class="rt-compare-round-tab ${r === compareActiveRound ? 'active' : ''}" data-round="${r}">Round ${r}</button>`;
    }
    if (maxRound > 1) {
      tabsHtml += `<button class="rt-compare-round-tab ${compareActiveRound === 0 ? 'active' : ''}" data-round="0">All Rounds</button>`;
    }
    tabsHtml += '</div>';

    // Grid
    let gridHtml = '<div class="rt-compare-grid">';
    for (const agentId of agentIds) {
      const cfg = AGENT_CONFIG[agentId];
      const firstTurn = turns.find(t => t.agentId === agentId);
      const displayLabel = firstTurn?.role || cfg.label;
      const model = firstTurn?.model || '';

      gridHtml += `<div class="rt-compare-column" data-agent="${agentId}">`;
      gridHtml += `<div class="rt-compare-col-header" data-agent="${agentId}">
        <div class="rt-agent-icon ${agentId}"><i class="fas ${cfg.icon}"></i></div>
        <div>
          <div class="rt-col-name">${escapeHtml(displayLabel)}</div>
          <div class="rt-col-model">${escapeHtml(model)}</div>
        </div>
      </div>`;

      for (let r = 1; r <= maxRound; r++) {
        if (compareActiveRound !== 0 && r !== compareActiveRound) continue;
        const turn = turns.find(t => t.agentId === agentId && t.round === r);
        if (turn) {
          const hasError = !!turn.error;
          gridHtml += `<div class="rt-compare-cell ${hasError ? 'error' : ''}">${hasError ? escapeHtml(turn.error) : escapeHtml(turn.response || '')}</div>`;
        } else {
          gridHtml += `<div class="rt-compare-cell" style="color:var(--muted);font-style:italic">No response</div>`;
        }
      }
      gridHtml += '</div>';
    }
    gridHtml += '</div>';

    $.rtCompareContainer.innerHTML = tabsHtml + gridHtml;

    // Wire round tab clicks
    for (const tab of $.rtCompareContainer.querySelectorAll('.rt-compare-round-tab')) {
      tab.addEventListener('click', () => {
        compareActiveRound = parseInt(tab.dataset.round);
        renderCompareView();
      });
    }
  }

  function getCurrentView() { return currentView; }

  return { handleViewToggle, renderCompareView, setActiveRoundtable, getCurrentView };
}
