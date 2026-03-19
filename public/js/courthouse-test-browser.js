const BENCHMARK_API = '/api/benchmark';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function estimateInputTokens(text) {
    const source = text || '';
    return source ? Math.max(1, Math.ceil(source.length / 4)) : 0;
}

function expectedOutputTokens(prompt) {
    const value = Number(prompt && prompt.expected_tokens);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function suggestedContextTokens(prompt) {
    const input = estimateInputTokens(prompt && prompt.prompt);
    const output = expectedOutputTokens(prompt) || 256;
    return Math.ceil((input + output + 256) / 512) * 512;
}

function typeLabel(prompt) {
    return prompt.scoring_type || prompt.category || 'general';
}

function renderCriteria(prompt) {
    if (!Array.isArray(prompt.judge_criteria) || prompt.judge_criteria.length === 0) return '';
    return `<div class="court-test-block"><h5>Judge Criteria</h5><ul>${prompt.judge_criteria.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`;
}

function renderCard(prompt) {
    const chars = (prompt.prompt || '').length.toLocaleString();
    const input = estimateInputTokens(prompt.prompt).toLocaleString();
    const output = expectedOutputTokens(prompt);
    const suggested = suggestedContextTokens(prompt).toLocaleString();
    const expected = prompt.expected_answer
        ? `<div class="court-test-block"><h5>Expected Answer</h5><pre>${escapeHtml(prompt.expected_answer)}</pre></div>`
        : '';
    const reference = prompt.reference_answer
        ? `<div class="court-test-block"><h5>Reference Answer</h5><pre>${escapeHtml(prompt.reference_answer)}</pre></div>`
        : '';
    return `<details class="court-test-card"><summary><div class="court-test-main"><div class="court-test-title">${escapeHtml(prompt.name || 'Untitled Test')}</div><div class="court-test-meta"><span class="court-chip">Level ${escapeHtml(prompt.level)}</span><span class="court-chip">${escapeHtml(typeLabel(prompt))}</span>${prompt.required_judge_tier ? `<span class="court-chip">Judge ${escapeHtml(String(prompt.required_judge_tier).toUpperCase())}</span>` : ''}</div><div class="court-test-context"><span class="court-chip">${chars} chars</span><span class="court-chip">~${input} input tokens</span><span class="court-chip">${output ? `${output.toLocaleString()} expected output` : 'output open-ended'}</span><span class="court-chip">min safe ctx ≥ ${suggested}</span></div></div><i class="fas fa-chevron-down" style="color:var(--muted);"></i></summary><div class="court-test-body"><div class="court-test-block"><h5>Prompt Context</h5><pre>${escapeHtml(prompt.prompt || '')}</pre></div>${expected}${reference}${renderCriteria(prompt)}</div></details>`;
}

async function loadCatalog() {
    const listEl = document.getElementById('courtTestList');
    const statsEl = document.getElementById('courtTestStats');
    const searchEl = document.getElementById('courtTestSearch');
    const levelEl = document.getElementById('courtTestLevelFilter');
    const categoryEl = document.getElementById('courtTestCategoryFilter');
    if (!listEl || !statsEl || !searchEl || !levelEl || !categoryEl) return;

    statsEl.textContent = 'Loading tests...';
    listEl.innerHTML = '';

    const response = await fetch(`${BENCHMARK_API}/prompts`, { credentials: 'same-origin' });
    const json = await response.json();
    const prompts = Array.isArray(json?.data?.prompts) ? json.data.prompts : [];

    const levels = [...new Set(prompts.map((p) => Number(p.level)).filter(Boolean))].sort((a, b) => a - b);
    const categories = [...new Set(prompts.map((p) => p.category).filter(Boolean))].sort();
    levelEl.innerHTML = '<option value="">All levels</option>' + levels.map((level) => `<option value="${level}">${level}</option>`).join('');
    categoryEl.innerHTML = '<option value="">All categories</option>' + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');

    function render() {
        const q = searchEl.value.trim().toLowerCase();
        const selectedLevel = levelEl.value;
        const selectedCategory = categoryEl.value;
        const filtered = prompts.filter((prompt) => {
            if (selectedLevel && String(prompt.level) !== selectedLevel) return false;
            if (selectedCategory && (prompt.category || '') !== selectedCategory) return false;
            if (!q) return true;
            return [prompt.name, prompt.prompt, prompt.category, prompt.scoring_type]
                .filter(Boolean)
                .some((value) => String(value).toLowerCase().includes(q));
        });
        statsEl.textContent = `${filtered.length} tests shown · context guidance is derived from prompt length plus expected output budget`;
        listEl.innerHTML = filtered.length
            ? filtered.map(renderCard).join('')
            : '<div class="court-test-stats">No tests match the current filters.</div>';
    }

    searchEl.addEventListener('input', render);
    levelEl.addEventListener('change', render);
    categoryEl.addEventListener('change', render);
    render();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCatalog);
} else {
    loadCatalog();
}
