/* Recorded task activity, separate from operator instructions and liveness. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipelineDossierActivity = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const time = value => value ? Date.parse(value) : NaN;
  function duration(milliseconds) {
    const minutes = Math.floor(milliseconds / 60000);
    return minutes < 1 ? 'less than a minute' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }
  function read(task, now = Date.now()) {
    const transitions = (task.transitions || []).filter(item => Number.isFinite(time(item.at)) && time(item.at) <= now)
      .slice().sort((a, b) => Number(a.seq) - Number(b.seq));
    const claims = transitions.filter(item => item.kind === 'claimed');
    const claim = claims.at(-1);
    const entries = (task.feedback || []).filter(item => Number.isFinite(time(item.at)) && time(item.at) <= now)
      .slice().sort((a, b) => time(b.at) - time(a.at));
    // Without a claim boundary, an old message cannot establish current work.
    const workerEntry = claim ? entries.find(item => time(item.at) >= time(claim.at)
      && ['coding-team', 'guarded-dispatch', task.assignee].filter(Boolean).includes(item.by)) : null;
    const instruction = entries.find(item => item.by === 'operator' && !item.workerOutcome && !item.reportOutcome);
    const ended = claim && transitions.find(item => Number(item.seq) > Number(claim.seq)
      && item.from === 'in_progress' && item.to !== 'in_progress');
    return { claim, workerEntry, instruction, earlierClaims: Math.max(0, claims.length - 1),
      elapsed: claim && (task.status === 'in_progress' || ended) ? duration((ended ? time(ended.at) : now) - time(claim.at)) : null };
  }
  function markup(task, activity, formatDate) {
    if (!['in_progress', 'blocked'].includes(task.status)) return '';
    const row = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
    return `<section class="pipeline-dossier-activity" aria-label="Execution timing">
      <dl>${row('Task created', formatDate(task.createdAt))}
      ${row(task.status === 'in_progress' ? 'Current run' : 'Last run', activity.claim
        ? `${formatDate(activity.claim.at)}${activity.elapsed ? ` · ${activity.elapsed}${task.status === 'in_progress' ? ' elapsed' : ' before leaving in progress'}` : ''}` : 'Start time not recorded')}
      ${row('Earlier runs', activity.earlierClaims ? `${activity.earlierClaims} earlier worker claim${activity.earlierClaims === 1 ? '' : 's'} recorded` : 'No earlier worker claim recorded')}
      ${row('Last worker update for this run', activity.workerEntry ? formatDate(activity.workerEntry.at) : 'None recorded')}</dl>
      <p>Elapsed time and worker signals do not measure completed work.</p>
    </section>`;
  }
  function inspect(body) {
    const technical = body?.querySelector('[data-drawer-section="technical"]');
    if (!technical) return;
    technical.open = true;
    const diagnosis = technical.querySelector('[data-stall-task]');
    const target = diagnosis || technical.querySelector('[data-drawer-section="help"]') || technical;
    if (target !== technical) target.open = true;
    const summary = target.querySelector('summary');
    summary?.focus();
    target.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
  if (typeof document !== 'undefined') document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-inspect-pipeline-activity]');
    if (button) inspect(button.closest('.pipeline-drawer-body'));
  });
  return { read, markup, inspect };
});
