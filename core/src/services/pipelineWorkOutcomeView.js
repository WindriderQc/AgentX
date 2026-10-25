'use strict';
// These are observations from existing native owners, never conclusions
// inferred from issue closure, mutable prose or a task's done status.
function view(task) {
  const autonomy = task.codingAutonomy, pr = autonomy?.pr, delivery = autonomy?.delivery;
  const validPr = pr && /^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(pr.repository || '')
    && Number.isSafeInteger(pr.number) && pr.number > 0 && /^[a-f0-9]{40}$/.test(pr.head || '');
  const observed = validPr && delivery?.head === pr.head && delivery.headMatches === true;
  return { schema: 'agentx.work-outcome-observations/v1',
    taskRecord: { status: task.status, resolution: task.resolution?.kind || null, provesOutcomeAcceptance: false },
    attempts: { href: `/api/pipeline/tasks/${task.pipelineId}`, field: 'task.evidenceReferences', authority: 'core.pipeline.attempts' },
    artifacts: { href: `/api/pipeline/tasks/${task.pipelineId}/deliverables`, authority: 'core.pipeline.deliverables', provesExternalDelivery: false },
    publication: validPr ? { repository: pr.repository, number: pr.number, head: pr.head,
      href: `https://github.com/${pr.repository}/pull/${pr.number}`, authority: 'core.coding.delivery',
      observation: observed ? { merged: delivery.merged === true, state: delivery.state,
        ci: delivery.ci, observedAt: delivery.observedAt } : null,
      unassociatedObservation: Boolean(delivery && !observed) } : null,
    deployment: { state: 'not_observed_here' }, acceptance: { state: 'not_inferred' },
    meaning: 'Issue closure, task closure, stored artifacts, PR merge, installation and outcome acceptance are independent facts.' };
}
module.exports = { view };
