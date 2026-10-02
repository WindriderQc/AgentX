(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipelineAttention = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  // Paginated "Needs attention" queue fed by GET /api/pipeline/attention.
  // Known total (server), loaded window and displayed page stay distinct. A
  // read never claims work; only a newly observed actionable key is announced.
  const SCHEMA = 'agentx.pipeline-attention/v1';
  const PAGE_SIZE = 10;
  const WINDOW_SIZE = 50;
  const SCOPES = { engineering: 'Engineering', private: 'Private lanes' };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  // Board filters + Agent Ops focus → query. A conflicting status focus cannot
  // match anything, so it is resolved locally without a read.
  function buildQuery({ filters = {}, context = null } = {}) {
    const status = context?.status || filters.status || '';
    if (context?.status && filters.status && context.status !== filters.status) return null;
    const params = { status, service: filters.service, lane: filters.lane, epic: filters.epic, search: filters.search,
      task: context?.task, assignee: context?.assignee, alias: context?.alias };
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value));
  }

  function windowOffset(pageIndex) {
    return Math.floor((pageIndex * PAGE_SIZE) / WINDOW_SIZE) * WINDOW_SIZE;
  }

  function validCoverage(coverage) {
    return coverage?.complete === true
      ? Number.isSafeInteger(coverage.total) && coverage.total >= 0
      : coverage?.complete === false && coverage.total == null
        && Number.isSafeInteger(coverage.lowerBound) && coverage.lowerBound >= 0;
  }

  function validPayload(value) {
    return value?.schema === SCHEMA && value.authority === 'core.pipeline' && Array.isArray(value.items)
      && value.page && validCoverage(value.coverage) && Array.isArray(value.signal?.keys);
  }

  // Signal only when an actionable key appears that the previous observation of
  // the same scope and filters did not contain. Baselines and removals are silent.
  function diffSignal(previous, next) {
    if (!previous || previous.basis !== next.basis) return { changed: true, newKeys: [], announce: false };
    if (previous.fingerprint === next.fingerprint) return { changed: false, newKeys: [], announce: false };
    const seen = new Set(previous.keys);
    const newKeys = next.keys.filter(key => !seen.has(key));
    return { changed: true, newKeys, announce: newKeys.length > 0 };
  }

  function lastPageIndex(view) {
    const known = view.coverage.total ?? view.coverage.lowerBound ?? 0;
    return Math.max(0, Math.ceil(known / PAGE_SIZE) - 1);
  }

  function pageItems(view, pageIndex) {
    const start = pageIndex * PAGE_SIZE - view.page.offset;
    return view.items.slice(Math.max(0, start), Math.max(0, start) + PAGE_SIZE);
  }

  function totalLabel(coverage) {
    if (coverage.complete && Number.isFinite(coverage.total)) return `${plural(coverage.total, 'item')} need action (exact)`;
    return `At least ${coverage.lowerBound} need action · total unknown`;
  }

  function bannerState(coverage) {
    if (!validCoverage(coverage)) return { tone: 'attention', icon: 'fa-triangle-exclamation',
      title: 'Engineering attention unknown', detail: 'Open Needs attention to refresh its count.' };
    if (!coverage.complete) return { tone: 'attention', icon: 'fa-triangle-exclamation',
      title: 'Engineering attention total unknown',
      detail: `At least ${coverage.lowerBound} engineering tasks need action; the bounded scan has partial coverage.` };
    const total = coverage.total;
    if (total > 0) return { tone: 'attention', icon: 'fa-triangle-exclamation',
      title: `${plural(total, 'engineering task')} need action`,
      detail: 'Exact total for the current engineering filters. See Needs attention for the next step.' };
    return { tone: 'ready', icon: 'fa-circle-check', title: 'Engineering queue clear',
      detail: 'No engineering task needs action for the current filters.' };
  }

  function describe(view, pageIndex) {
    const shown = pageItems(view, pageIndex);
    const loadedFrom = view.page.offset + 1;
    const loadedTo = view.page.offset + view.items.length;
    const shownFrom = pageIndex * PAGE_SIZE + 1;
    const parts = [totalLabel(view.coverage)];
    if (view.items.length) {
      parts.push(`${view.items.length} loaded (${loadedFrom}–${loadedTo})`);
      parts.push(`showing ${shown.length ? `${shownFrom}–${shownFrom + shown.length - 1}` : 'none'}`);
    }
    return parts.join(' · ');
  }

  function coverageNote(view) {
    const coverage = view.coverage;
    if (coverage.complete) return '';
    return `Partial coverage: ${coverage.scannedCount} of ${coverage.candidateCount} open tasks were projected (${coverage.order}). Items beyond that bound are not listed.`;
  }

  // The other queue is never scanned to produce this note: its count is shown
  // only from an observation this page already made with the same filters.
  function scopeNote(view, known) {
    const other = view.otherScope?.scope;
    if (!other) return '';
    const label = other === 'private' ? 'private or household lane' : 'engineering';
    if (!known) return other === 'private' ? 'Private and household lanes are a separate queue, not counted here.' : '';
    if (!known.count) return '';
    return `${plural(known.count, `${label} item`)}${known.complete ? '' : '+'} at last view stay in their own queue.`;
  }

  function itemMarkup(item, isNew) {
    return `<button type="button" class="pipeline-attention-item tone-${esc(item.tone)}${isNew ? ' is-new' : ''}" data-pipeline-task="${esc(item.pipelineId)}">
        <i class="fas ${esc(item.icon)}" aria-hidden="true"></i>
        <span class="pipeline-attention-copy">
          <strong>${isNew ? '<span class="pipeline-attention-new">New</span> ' : ''}${esc(item.pipelineId)} ${esc(item.label)}</strong>
          <span>${esc(item.title)} · ${esc(item.detail)}</span>
          <em>${esc(item.action)}</em>
        </span>
        <i class="fas fa-arrow-right pipeline-attention-arrow" aria-hidden="true"></i>
      </button>`;
  }

  function emptyMarkup(view, filtered) {
    const copy = filtered ? 'No attention items match the current filters in this scope.'
      : view.scope === 'private' ? 'No private-lane item needs attention.'
        : 'All clear — no blocked, review, stale, or overdue engineering work.';
    return `<div class="pipeline-empty"><i class="fas fa-circle-check" aria-hidden="true"></i> ${esc(copy)}</div>`;
  }

  class Controller {
    constructor({ elements, fetchJson, filters, onChange }) {
      this.el = elements;
      this.fetchJson = fetchJson;
      this.onChange = onChange || (() => {});
      this.scope = 'engineering';
      this.pageIndex = 0;
      this.query = buildQuery(filters);
      this.view = null;
      this.error = null;
      this.signals = {};
      this.counts = {};
      this.newKeys = new Set();
      this.version = 0;
      this.rendered = '';
      this.bind();
    }

    basis() { return `${this.scope}|${JSON.stringify(this.query)}`; }
    engineeringCoverage() {
      return this.scope === 'engineering' && !this.error && this.view?.scope === 'engineering'
        ? this.view.coverage : null;
    }

    // Called on every board render; reads only when the filter basis changes.
    // Periodic and manual refreshes call refresh() directly.
    setFilters(input) {
      const query = buildQuery(input);
      if (JSON.stringify(query) === JSON.stringify(this.query)) return;
      this.query = query;
      this.pageIndex = 0;
      this.view = null;
      this.error = null;
      this.newKeys = new Set();
      ++this.version;
      this.onChange();
      this.render();
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.refresh(), 250);
    }

    // The pressed scope and a pending list render before the read completes.
    setScope(scope) {
      if (!SCOPES[scope] || scope === this.scope) return;
      this.scope = scope;
      this.pageIndex = 0;
      this.view = null;
      this.error = null;
      this.newKeys = new Set();
      ++this.version;
      this.onChange();
      this.render();
      this.refresh();
    }

    goTo(pageIndex) {
      if (!this.view) return;
      const target = Math.min(Math.max(0, pageIndex), lastPageIndex(this.view));
      if (target === this.pageIndex) return;
      this.pageIndex = target;
      if (windowOffset(target) !== this.view.page.offset) this.refresh();
      else this.render();
    }

    async refresh() {
      clearTimeout(this.debounce);
      const version = ++this.version;
      if (this.query === null) {
        this.view = { scope: this.scope, items: [], page: { offset: 0 }, coverage: { complete: true, total: 0, lowerBound: 0 }, signal: { keys: [] } };
        this.error = null;
        this.render();
        this.onChange();
        return;
      }
      this.setBusy(true);
      const params = new URLSearchParams({ ...this.query, scope: this.scope, offset: String(windowOffset(this.pageIndex)), limit: String(WINDOW_SIZE) });
      try {
        const payload = await this.fetchJson(`/api/pipeline/attention?${params}`);
        if (version !== this.version) return;
        const view = payload?.data?.attention;
        if (!validPayload(view)) throw new Error('Attention evidence unavailable or in an unknown format.');
        const basis = this.basis();
        const diff = diffSignal(this.signals[basis], { basis, fingerprint: view.signal.fingerprint, keys: view.signal.keys });
        this.signals[basis] = { basis, fingerprint: view.signal.fingerprint, keys: view.signal.keys };
        this.counts[basis] = { count: view.coverage.total ?? view.coverage.lowerBound, complete: Boolean(view.coverage.complete) };
        if (diff.changed) this.newKeys = new Set(diff.newKeys);
        if (diff.announce) this.announce(`${plural(diff.newKeys.length, 'new item')} need${diff.newKeys.length === 1 ? 's' : ''} attention.`);
        this.view = view;
        this.error = null;
        this.pageIndex = Math.min(this.pageIndex, lastPageIndex(view));
        if (windowOffset(this.pageIndex) !== view.page.offset) this.pageIndex = Math.floor(view.page.offset / PAGE_SIZE);
      } catch (error) {
        if (version !== this.version) return;
        this.error = error;
      } finally {
        if (version === this.version) {
          this.setBusy(false);
          this.render();
          this.onChange();
        }
      }
    }

    announce(message) {
      if (this.el.live) this.el.live.textContent = message;
    }

    setBusy(busy) {
      this.el.list?.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    render() {
      const { list, meta, pager, scopes, notes } = this.el;
      const filtered = Boolean(this.query && Object.keys(this.query).length) || this.query === null;
      let listHtml;
      let metaText;
      let noteText = '';
      let pagerHtml = '';
      if (this.error && !this.view) {
        metaText = 'Attention evidence unavailable';
        listHtml = `<div class="pipeline-error">${esc(this.error.message || this.error)} <button type="button" class="pipeline-btn compact" data-attention-retry><i class="fas fa-rotate" aria-hidden="true"></i><span>Retry</span></button></div>`;
      } else if (!this.view) {
        metaText = `Loading ${SCOPES[this.scope]}…`;
        listHtml = `<div class="pipeline-empty">Loading ${esc(SCOPES[this.scope].toLowerCase())} attention items&hellip;</div>`;
      } else {
        const view = this.view;
        const items = pageItems(view, this.pageIndex);
        metaText = describe(view, this.pageIndex);
        if (this.error) metaText = `Refresh failed · last observation retained · ${metaText}`;
        const otherBasis = view.otherScope ? `${view.otherScope.scope}|${JSON.stringify(this.query)}` : '';
        noteText = [coverageNote(view), scopeNote(view, this.counts[otherBasis])].filter(Boolean).join(' ');
        listHtml = items.length ? items.map(item => itemMarkup(item, this.newKeys.has(item.key))).join('') : emptyMarkup(view, filtered);
        const last = lastPageIndex(view);
        if (last > 0 || this.pageIndex > 0) {
          const pages = view.coverage.complete ? `${last + 1}` : `at least ${last + 1}`;
          pagerHtml = `<button type="button" class="pipeline-btn compact" data-attention-page="prev"${this.pageIndex === 0 ? ' disabled' : ''}><i class="fas fa-chevron-left" aria-hidden="true"></i><span>Previous</span></button>
            <span class="pipeline-attention-pageinfo">Page ${this.pageIndex + 1} of ${pages}</span>
            <button type="button" class="pipeline-btn compact" data-attention-page="next"${this.pageIndex >= last ? ' disabled' : ''}><span>Next</span><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;
        }
        if (this.error) pagerHtml += ' <button type="button" class="pipeline-btn compact" data-attention-retry><i class="fas fa-rotate" aria-hidden="true"></i><span>Retry</span></button>';
      }
      const signature = JSON.stringify([listHtml, metaText, noteText, pagerHtml, this.scope]);
      if (signature === this.rendered) return;
      this.rendered = signature;
      const focused = pager?.contains(document.activeElement) ? document.activeElement.dataset.attentionPage : null;
      if (meta) meta.textContent = metaText;
      if (notes) { notes.textContent = noteText; notes.hidden = !noteText; }
      if (list) list.innerHTML = listHtml;
      if (pager) { pager.innerHTML = pagerHtml; pager.hidden = !pagerHtml; }
      if (scopes) {
        scopes.querySelectorAll('[data-attention-scope]').forEach((button) => {
          const active = button.dataset.attentionScope === this.scope;
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
          button.classList.toggle('active', active);
        });
      }
      if (focused && pager) {
        const target = pager.querySelector(`[data-attention-page="${focused}"]:not([disabled])`)
          || pager.querySelector('[data-attention-page]:not([disabled])');
        target?.focus();
      }
    }

    bind() {
      this.el.pager?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-attention-page]');
        if (button) this.goTo(this.pageIndex + (button.dataset.attentionPage === 'next' ? 1 : -1));
      });
      this.el.scopes?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-attention-scope]');
        if (button) this.setScope(button.dataset.attentionScope);
      });
      const retry = (event) => { if (event.target.closest('[data-attention-retry]')) this.refresh(); };
      this.el.list?.addEventListener('click', retry);
      this.el.pager?.addEventListener('click', retry);
    }
  }

  return { Controller, bannerState, buildQuery, diffSignal, describe, scopeNote, pageItems, lastPageIndex, windowOffset, validPayload, PAGE_SIZE, WINDOW_SIZE };
});
