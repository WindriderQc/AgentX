/**
 * Profiler cockpit — coverage of the hosts and models in scope.
 *
 * Read-only: for each model pinned on a host or routed to it, the state of
 * its profile and how many catalog prompts have a scored answer.
 */
(function () {
  'use strict';

  var PROFILE_LABELS = { current: 'Current', stale: 'Stale', unqualified: 'Needs a standard profile', missing: 'Missing' };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function bar(covered, total) {
    var percent = total ? Math.round((covered / total) * 100) : 0;
    return '<div class="mp-coverage-bar" role="img" aria-label="' + covered + ' of ' + total + ' prompts scored">' +
      '<span style="width:' + percent + '%"></span></div><small>' + covered + ' / ' + total + '</small>';
  }

  function scopeLabel(cell) {
    var parts = [];
    if (cell.pinned) parts.push('pinned');
    if (cell.tasks && cell.tasks.length) parts.push('routed: ' + cell.tasks.join(', '));
    return parts.join(' · ');
  }

  function categories(cell) {
    return Object.keys(cell.catalog.byCategory).sort().map(function (name) {
      var item = cell.catalog.byCategory[name];
      var state = item.covered === item.total ? 'done' : item.covered ? 'partial' : 'none';
      return '<span class="mp-coverage-cat is-' + state + '" title="' + item.covered + ' of ' + item.total + ' scored">' +
        escapeHtml(name) + '</span>';
    }).join('');
  }

  function row(cell) {
    var next = cell.next === 'profile' ? 'Profile' : cell.next === 'benchmark' ? 'Benchmark' : 'Nothing';
    return '<tr>' +
      '<td><strong>' + escapeHtml(cell.hostName) + '</strong><small>' + escapeHtml(String(cell.residency).toUpperCase()) + '</small></td>' +
      '<td><strong>' + escapeHtml(cell.model) + '</strong><small>' + escapeHtml(scopeLabel(cell)) + '</small></td>' +
      '<td><span class="mp-coverage-profile is-' + escapeHtml(cell.profile.state) + '" title="' + escapeHtml(cell.profile.reason || '') + '">' +
        escapeHtml(PROFILE_LABELS[cell.profile.state] || cell.profile.state) + '</span>' +
        (cell.profile.depth ? '<small>' + escapeHtml(cell.profile.depth) + '</small>' : '') + '</td>' +
      '<td>' + bar(cell.catalog.covered, cell.catalog.total) + '<div class="mp-coverage-cats">' + categories(cell) + '</div></td>' +
      '<td>' + (cell.complete ? '<span class="mp-coverage-done">Complete</span>' : escapeHtml(next)) + '</td>' +
      '</tr>';
  }

  function render(target, data) {
    var summary = data.summary;
    if (!data.cells.length) {
      target.innerHTML = '<p class="mp-coverage-empty">No model is pinned or routed on a known host yet.</p>';
      return;
    }
    target.innerHTML =
      '<p class="mp-coverage-summary"><strong>' + summary.percent + '%</strong> of ' + summary.prompts + ' prompt answers scored · ' +
      summary.profilesCurrent + ' of ' + summary.cells + ' profiles current · ' + summary.complete + ' of ' + summary.cells +
      ' host and model pairs complete <small>scorer ' + escapeHtml(data.scorerVersion) + '</small></p>' +
      '<table class="mp-coverage-table"><thead><tr><th>Host</th><th>Model</th><th>Profile</th><th>Catalog</th><th>Next</th></tr></thead>' +
      '<tbody>' + data.cells.map(row).join('') + '</tbody></table>';
  }

  async function load() {
    var target = document.getElementById('mp-coverage');
    if (!target) return;
    target.setAttribute('aria-busy', 'true');
    try {
      var response = await fetch('/api/benchmark/coverage', { cache: 'no-store' });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.message || 'Request failed (' + response.status + ')');
      render(target, body.data);
    } catch (error) {
      target.innerHTML = '<p class="mp-coverage-empty" role="alert">Coverage is unavailable: ' + escapeHtml(error.message) + '</p>';
    } finally {
      target.setAttribute('aria-busy', 'false');
    }
  }

  window.ProfilerCoverage = { load: load };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
