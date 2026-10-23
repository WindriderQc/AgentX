/** Bind dashboard controls without inline event handlers (CSP forbids them). */

// Rail tab counts; renderers call this after each load.
function setRailCount(name, count) {
  const badge = document.querySelector?.(`[data-rail-count="${name}"]`);
  if (badge) badge.textContent = Number(count) > 0 ? String(count) : '';
}

// One rail, three tabs (WAI-ARIA tabs: arrows move, the choice is remembered per viewer).
function bindRailTabs() {
  const tabs = [...(document.querySelectorAll?.('[data-rail-tab]') || [])];
  if (!tabs.length) return;
  const select = (tab, focus) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
    try { localStorage.setItem('cs-rail-tab', tab.dataset.railTab); } catch { /* storage is optional */ }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        select(tabs[event.key === 'Home' ? 0 : tabs.length - 1], true);
      } else if (step) {
        event.preventDefault();
        select(tabs[(index + step + tabs.length) % tabs.length], true);
      }
    });
  });
  let saved = null;
  try { saved = localStorage.getItem('cs-rail-tab'); } catch { /* storage is optional */ }
  const initial = tabs.find(tab => tab.dataset.railTab === saved);
  if (initial) select(initial, false);
}

(function bindClusterScheduleControls() {
  document.addEventListener('DOMContentLoaded', () => {
    const on = (id, event, handler) => document.getElementById(id).addEventListener(event, handler);
    const search = document.getElementById('scheduleSearch'), owner = document.getElementById('scheduleOwner');
    if (search && owner) {
      let pendingSearch;
      search.addEventListener('input', () => {clearTimeout(pendingSearch); pendingSearch = setTimeout(() => setCalendarCatalogueFilter(search.value, owner.value), 200);});
      owner.addEventListener('change', () => {clearTimeout(pendingSearch); setCalendarCatalogueFilter(search.value, owner.value);});
    }
    on('prevDateBtn', 'click', () => shiftDate(-1));
    on('nextDateBtn', 'click', () => shiftDate(1));
    on('todayBtn', 'click', goToday);
    on('viewTask', 'click', () => setViewMode('task'));
    on('viewHost', 'click', () => setViewMode('host'));
    on('refreshBtn', 'click', refreshAll);
    on('servicesToggle', 'click', toggleServices);
    on('highFreqFilter', 'change', event => setTimelineFilter('highFreq', event.target.checked));
    on('noGpuFilter', 'change', event => setTimelineFilter('noGpu', event.target.checked));
    on('btnHeatmap', 'click', () => setActualView('heatmap'));
    on('btnAvp', 'click', () => setActualView('avp'));
    on('heatmapDays', 'change', actualViewChanged);
    bindRailTabs();

    const timeline = document.getElementById('heatmapContainer');
    timeline.addEventListener('click', event => {
      const group = event.target.closest('.cs-group-header');
      if (group) toggleGroup(group.dataset.groupKey);
    });
    timeline.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const group = event.target.closest('.cs-group-header');
      if (!group) return;
      event.preventDefault();
      toggleGroup(group.dataset.groupKey);
    });
  });
}());
