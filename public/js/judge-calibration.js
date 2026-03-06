/**
 * Judge Calibration & Human Review Panel
 * Loaded alongside leaderboard.js on the leaderboard page.
 *
 * Two sections:
 * 1. Review Queue — results flagged for human review, with inline scoring
 * 2. Judge Accuracy — calibration stats per judge model vs human consensus
 */

// ── Review Queue ─────────────────────────────────────────────

async function loadReviewQueue() {
  const container = document.getElementById('reviewQueueBody');
  const statsEl = document.getElementById('reviewStats');
  if (!container) return;

  try {
    const res = await fetch('/api/benchmark/results/needs-review?limit=20');
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error);

    const { results, stats } = json.data;

    statsEl.textContent = `${stats.reviewed}/${stats.total} reviewed`;

    if (results.length === 0) {
      container.innerHTML = '<tr><td colspan="7" class="loading-cell">No results need review</td></tr>';
      return;
    }

    container.innerHTML = results.map(r => {
      const hasReview = r.human_score != null;
      const delta = hasReview ? (r.quality_score - r.human_score).toFixed(1) : '';
      const deltaClass = hasReview ? (Math.abs(r.quality_score - r.human_score) > 1 ? 'delta-bad' : 'delta-ok') : '';

      return `
        <tr class="${hasReview ? 'reviewed' : ''}" data-id="${r._id}">
          <td class="truncate" title="${esc(r.prompt_name)}">${esc(r.prompt_name || '?')}</td>
          <td>${esc(r.model || '?')}</td>
          <td>${r.prompt_category || '-'}</td>
          <td>${r.quality_score != null ? r.quality_score.toFixed(1) : '-'}</td>
          <td>
            ${hasReview
              ? `<span class="human-score-display">${r.human_score.toFixed(1)}</span>`
              : `<input type="number" min="0" max="10" step="0.5" class="review-score-input" placeholder="0-10">`}
          </td>
          <td class="${deltaClass}">${delta}</td>
          <td>
            ${hasReview
              ? '<span class="review-done"><i class="fas fa-check"></i></span>'
              : `<input type="text" class="review-notes-input" placeholder="Notes (optional)">
                 <button class="btn-sm btn-primary" onclick="submitReview('${r._id}', this)">Submit</button>`}
          </td>
        </tr>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<tr><td colspan="7" class="loading-cell">Error: ${esc(err.message)}</td></tr>`;
  }
}

async function submitReview(resultId, btn) {
  const row = btn.closest('tr');
  const scoreInput = row.querySelector('.review-score-input');
  const notesInput = row.querySelector('.review-notes-input');

  const score = parseFloat(scoreInput.value);
  if (isNaN(score) || score < 0 || score > 10) {
    scoreInput.style.borderColor = '#ef4444';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    const res = await fetch(`/api/benchmark/results/${resultId}/human-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        human_score: score,
        notes: notesInput?.value || null,
        reviewer: 'dashboard'
      })
    });
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error);

    // Refresh both panels
    loadReviewQueue();
    loadCalibration();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    btn.style.borderColor = '#ef4444';
  }
}

// ── Judge Calibration ────────────────────────────────────────

async function loadCalibration() {
  const container = document.getElementById('calibrationBody');
  if (!container) return;

  try {
    const res = await fetch('/api/benchmark/judge-calibration');
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error);

    const { judges, totalReviews } = json.data;
    document.getElementById('calibrationTotal').textContent = `${totalReviews} reviews`;

    if (judges.length === 0) {
      container.innerHTML = '<tr><td colspan="5" class="loading-cell">No calibration data yet. Submit human reviews above.</td></tr>';
      return;
    }

    container.innerHTML = judges.map(j => {
      const biasLabel = j.bias > 0.3 ? 'Too generous' : j.bias < -0.3 ? 'Too harsh' : 'Balanced';
      const biasClass = Math.abs(j.bias) > 0.5 ? 'delta-bad' : Math.abs(j.bias) > 0.3 ? 'delta-warn' : 'delta-ok';
      const agrClass = j.agreementRate >= 80 ? 'delta-ok' : j.agreementRate >= 60 ? 'delta-warn' : 'delta-bad';

      return `
        <tr>
          <td class="truncate" title="${esc(j.judgeModel)}">${esc(j.judgeModel)}</td>
          <td>${j.reviews}</td>
          <td class="${agrClass}">${j.agreementRate}%</td>
          <td>${j.meanAbsoluteError}</td>
          <td class="${biasClass}" title="Avg judge - human: ${j.bias > 0 ? '+' : ''}${j.bias}">${biasLabel} (${j.bias > 0 ? '+' : ''}${j.bias})</td>
        </tr>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<tr><td colspan="5" class="loading-cell">Error: ${esc(err.message)}</td></tr>`;
  }
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadReviewQueue();
  loadCalibration();
});
