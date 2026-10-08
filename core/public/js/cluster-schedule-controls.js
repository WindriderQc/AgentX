/** Bind dashboard controls without inline event handlers (CSP forbids them). */
(function bindClusterScheduleControls() {
  document.addEventListener('DOMContentLoaded', () => {
    const on = (id, event, handler) => document.getElementById(id).addEventListener(event, handler);
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
