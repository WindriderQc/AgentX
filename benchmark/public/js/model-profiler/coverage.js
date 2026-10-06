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
      '<tbody>' + data.cells.map(row).join('') + '</tbody></table>' + jobPanel(data.job);
    var form = target.querySelector('.mp-coverage-settings');
    if (form) form.addEventListener('submit', function (event) { event.preventDefault(); save(form); });
  }

  function lastLine(job) {
    var last = job.last;
    if (!last) return 'No measurement started yet.';
    var what = (last.kind === 'profile' ? 'Profile' : (last.prompts || '') + ' prompts') + ' for ' + last.model + ' on ' + last.hostName;
    var outcome = { advanced: 'done', no_progress: 'ended without progress', not_started: 'not started: ' + (last.error || '') }[last.outcome] || 'started';
    return 'Last: ' + what + ', ' + new Date(last.at).toLocaleString() + ', ' + outcome + '.';
  }

  function jobPanel(job) {
    if (!job) return '';
    var s = job.settings;
    var check = job.lastCheck;
    var state = !s.enabled ? 'Off' : check && check.idle ? 'Measuring when a pair needs it'
      : check ? 'Waiting: ' + check.reasons.join('; ') : 'On, first check within a minute';
    return '<form class="mp-coverage-settings">' +
      '<p class="mp-coverage-job"><strong>Automatic measurement</strong> ' + escapeHtml(state) + '. ' + escapeHtml(lastLine(job)) + '</p>' +
      '<label><input type="checkbox" name="enabled"' + (s.enabled ? ' checked' : '') + '> Measure in quiet hours</label>' +
      '<label>From <input type="time" name="quietStart" required value="' + escapeHtml(s.quietStart) + '"></label>' +
      '<label>to <input type="time" name="quietEnd" required value="' + escapeHtml(s.quietEnd) + '"></label>' +
      '<label>Time zone <input name="timeZone" required size="18" value="' + escapeHtml(s.timeZone) + '"></label>' +
      '<label>Household quiet for <input type="number" name="idleMinutes" min="0" max="240" required value="' + s.idleMinutes + '"> min</label>' +
      '<label>Prompts per measurement <input type="number" name="bitePrompts" min="1" max="50" required value="' + s.bitePrompts + '"></label>' +
      '<button type="submit">Save</button><span class="mp-coverage-save" role="status" aria-live="polite"></span></form>';
  }

  async function save(form) {
    var status = form.querySelector('.mp-coverage-save');
    status.textContent = 'Saving…';
    try {
      var response = await fetch('/api/benchmark/coverage/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: form.elements.enabled.checked,
          quietStart: form.elements.quietStart.value, quietEnd: form.elements.quietEnd.value,
          timeZone: form.elements.timeZone.value.trim(),
          idleMinutes: Number(form.elements.idleMinutes.value), bitePrompts: Number(form.elements.bitePrompts.value)
        })
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.message || 'Request failed (' + response.status + ')');
      await load();
    } catch (error) {
      status.textContent = error.message;
    }
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
