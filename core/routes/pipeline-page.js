'use strict';

// Nestor's screen (#924) frames this page from the same origin. Only the
// screen view relaxes the frame policy, and only for AgentX itself.
function allowSameOriginFrame(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const policy = res.getHeader('Content-Security-Policy');
  if (policy) res.setHeader('Content-Security-Policy', String(policy).replace(/frame-ancestors [^;]*/, "frame-ancestors 'self'"));
}

function registerPipelinePage(app) {
  app.get('/js/pipeline-report-selection.js', (_req, res) => res.sendFile(require.resolve('../../shared/pipelineReportSelection')));
  app.get('/pipeline', (req, res) => {
    const screen = req.query.view === 'screen';
    if (screen) allowSameOriginFrame(res);
    res.render('layouts/main', {
      ...(screen && { showNav: false, bodyClass: 'pipeline-screen' }),
      pageView: '../pages/pipeline',
      title: 'AgentX - Pipeline',
      service: 'core',
      activePage: 'pipeline',
      headCss: [
        '<link rel="stylesheet" href="/styles.css">',
        '<link rel="stylesheet" href="/css/pipeline.css"><link rel="stylesheet" href="/css/pipeline-diagnostics.css"><link rel="stylesheet" href="/css/pipeline-attention.css"><link rel="stylesheet" href="/css/pipeline-evidence-references.css"><link rel="stylesheet" href="/css/pipeline-phase-durations.css"><link rel="stylesheet" href="/css/pipeline-plan.css"><link rel="stylesheet" href="/css/pipeline-stall-diagnosis.css">',
        '<link rel="stylesheet" href="/css/pipeline-editor.css"><link rel="stylesheet" href="/css/pipeline-deliverables.css"><link rel="stylesheet" href="/css/pipeline-resume.css"><link rel="stylesheet" href="/css/pipeline-code-steps.css">',
        '<link rel="stylesheet" href="/css/cockpit-help.css">',
        '<link rel="stylesheet" href="/css/pipeline-screen.css">'
      ].join('\n'),
      footerJs: [
        '<script src="/js/cockpit-help.js"></script>',
        '<script src="/js/pipeline-editor.js"></script><script src="/js/pipeline-deliverables.js"></script>',
        '<script src="/js/pipeline-eligibility.js"></script><script src="/js/pipeline-report-selection.js"></script><script src="/js/pipeline-launch.js"></script><script src="/js/pipeline-report-resume.js"></script><script src="/js/pipeline-attention.js"></script><script src="/js/pipeline-evidence-references.js"></script><script src="/js/pipeline-phase-durations.js"></script><script src="/js/pipeline-plan.js"></script><script src="/js/pipeline-stall-diagnosis.js"></script>',
        '<script src="/js/pipeline-worker-outcome.js"></script><script src="/js/code-step-summary.js"></script><script src="/js/pipeline-code-steps.js"></script><script src="/js/code-step-graph-summary.js"></script><script src="/js/pipeline-code-step-graph.js"></script><script src="/js/pipeline-worker-monitor.js"></script><script src="/js/pipeline-delivery.js"></script><script src="/js/pipeline-board.js"></script><script src="/js/pipeline-attempt-dossier.js"></script><script src="/js/pipeline-dossier-activity.js"></script><script src="/js/pipeline-drawer.js"></script><script src="/js/pipeline.js"></script>'
      ].join('\n')
    });
  });
}

module.exports = registerPipelinePage;
module.exports.allowSameOriginFrame = allowSameOriginFrame;
