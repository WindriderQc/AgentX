/**
 * Chat history search: text query, filters and pages over
 * /api/history/search, which applies the same Playground visibility rules
 * as the recent list. With no query and no filter, the sidebar shows the
 * plain recent list.
 */
import { loadHistoryList, renderHistoryItems, renderHistoryState } from './chat-history.js';

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;

export function initHistorySearch(elements, state) {
  const $ = (id) => document.getElementById(id);
  const input = $('conversationSearchInput');
  const panel = $('filterPanel');
  if (!input || !panel) return;
  const clearBtn = $('clearSearchBtn');
  const toggle = $('toggleFiltersBtn');
  const pager = $('paginationControls');
  const tagsInput = $('filterTagsInput');
  const chips = $('filterTagsChips');
  const search = { page: 1, tags: [], token: 0 };
  let debounce = null;

  function filters() {
    const models = [...$('filterModel').selectedOptions].map((option) => option.value).filter(Boolean);
    return {
      q: input.value.trim(),
      dateFrom: $('filterDateFrom').value,
      dateTo: $('filterDateTo').value,
      models: models.join(','),
      ragOnly: $('filterRagOnly').checked ? 'true' : '',
      feedbackRating: $('filterFeedback').value,
      tags: search.tags.join(','),
      sortBy: $('filterSortBy').value
    };
  }

  const isActive = (f = filters()) => Boolean(f.q || f.dateFrom || f.dateTo || f.models || f.ragOnly || f.feedbackRating || f.tags);

  async function run(page = search.page) {
    const f = filters();
    clearBtn.style.display = f.q ? '' : 'none';
    const token = ++search.token;
    if (!isActive(f)) {
      pager.style.display = 'none';
      search.page = 1;
      return loadHistoryList(elements, state);
    }
    search.page = page;
    renderHistoryState(elements, 'loading', 'Searching conversations…');
    const params = new URLSearchParams(Object.entries({ ...f, page: String(page), limit: String(PAGE_SIZE) }).filter(([, value]) => value));
    try {
      const res = await fetch(`/api/history/search?${params}`);
      if (!res.ok) throw new Error(`Search request failed: ${res.status}`);
      const { data } = await res.json();
      if (token !== search.token) return [];
      const items = (data?.results || []).map((row) => ({ id: String(row._id), title: row.title, date: row.updatedAt || row.createdAt }));
      if (items.length) renderHistoryItems(elements, state, items);
      else renderHistoryState(elements, 'empty', 'No matching conversations', 'Change the search or clear the filters.');
      const pages = data?.pagination || {};
      pager.style.display = pages.totalPages > 1 ? '' : 'none';
      $('paginationInfo').textContent = `Page ${pages.currentPage || 1} of ${Math.max(1, pages.totalPages || 1)}`;
      $('prevPageBtn').disabled = !pages.hasPreviousPage;
      $('nextPageBtn').disabled = !pages.hasNextPage;
      return items;
    } catch (err) {
      if (token !== search.token) return [];
      console.error('History search failed', err);
      pager.style.display = 'none';
      renderHistoryState(elements, 'error', 'Search unavailable', 'Clear the search to see recent conversations.');
      return [];
    }
  }

  function renderChips() {
    chips.replaceChildren(...search.tags.map((tag) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip';
      chip.textContent = `${tag} ×`;
      chip.setAttribute('aria-label', `Remove tag ${tag}`);
      chip.addEventListener('click', () => { search.tags = search.tags.filter((item) => item !== tag); renderChips(); });
      return chip;
    }));
  }

  // The model filter lists the models seen in recent conversations.
  async function fillModels() {
    const select = $('filterModel');
    if (select.options.length > 1) return;
    try {
      const res = await fetch('/api/history');
      const { data } = await res.json();
      const models = [...new Set((Array.isArray(data) ? data : []).map((item) => item.model).filter(Boolean))].sort();
      models.forEach((model) => select.add(new Option(model, model)));
    } catch { /* the filter still works without suggestions */ }
  }

  state.historySearch = { active: () => isActive(), run: () => run() };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => run(1), DEBOUNCE_MS);
  });
  clearBtn.addEventListener('click', () => { input.value = ''; run(1); input.focus(); });
  toggle.setAttribute('aria-controls', 'filterPanel');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? '' : 'none';
    toggle.setAttribute('aria-expanded', String(open));
    if (open) fillModels();
  });
  tagsInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const tag = tagsInput.value.trim();
    if (tag && !search.tags.includes(tag)) search.tags.push(tag);
    tagsInput.value = '';
    renderChips();
  });
  $('applyFiltersBtn').addEventListener('click', () => run(1));
  $('clearFiltersBtn').addEventListener('click', () => {
    ['filterDateFrom', 'filterDateTo', 'filterFeedback'].forEach((id) => { $(id).value = ''; });
    [...$('filterModel').options].forEach((option) => { option.selected = false; });
    $('filterRagOnly').checked = false;
    $('filterSortBy').value = 'relevance';
    search.tags = [];
    renderChips();
    run(1);
  });
  $('prevPageBtn').addEventListener('click', () => run(Math.max(1, search.page - 1)));
  $('nextPageBtn').addEventListener('click', () => run(search.page + 1));
}
