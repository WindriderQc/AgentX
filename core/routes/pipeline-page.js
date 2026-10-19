'use strict';

module.exports = function registerPipelinePage(app) {
  app.get('/js/pipeline-report-selection.js', (_req, res) => res.sendFile(require.resolve('../../shared/pipelineReportSelection')));
  app.get('/pipeline', (req, res) => {
    res.render('layouts/main', {
      pageView: '../pages/pipeline',
      title: 'AgentX - Pipeline',
      service: 'core',
      activePage: 'pipeline',
      headCss: [
        '<link rel="stylesheet" href="/styles.css">',
        '<link rel="stylesheet" href="/css/pipeline.css"><link rel="stylesheet" href="/css/pipeline-diagnostics.css"><link rel="stylesheet" href="/css/pipeline-attention.css"><link rel="stylesheet" href="/css/pipeline-evidence-references.css"><link rel="stylesheet" href="/css/pipeline-phase-durations.css"><link rel="stylesheet" href="/css/pipeline-plan.css"><link rel="stylesheet" href="/css/pipeline-stall-diagnosis.css">',
        '<link rel="stylesheet" href="/css/pipeline-editor.css"><link rel="stylesheet" href="/css/pipeline-deliverables.css"><link rel="stylesheet" href="/css/pipeline-resume.css">',
        '<link rel="stylesheet" href="/css/cockpit-help.css">'
      ].join('\n'),
      footerJs: [
        '<script src="/js/cockpit-help.js"></script>',
        '<script src="/js/pipeline-editor.js"></script><script src="/js/pipeline-deliverables.js"></script>',
        '<script src="/js/pipeline-eligibility.js"></script><script src="/js/pipeline-report-selection.js"></script><script src="/js/pipeline-launch.js"></script><script src="/js/pipeline-report-resume.js"></script><script src="/js/pipeline-attention.js"></script><script src="/js/pipeline-evidence-references.js"></script><script src="/js/pipeline-phase-durations.js"></script><script src="/js/pipeline-plan.js"></script><script src="/js/pipeline-stall-diagnosis.js"></script>',
        '<script src="/js/pipeline-worker-outcome.js"></script><script src="/js/pipeline-worker-monitor.js"></script><script src="/js/pipeline-delivery.js"></script><script src="/js/pipeline-board.js"></script><script src="/js/pipeline-attempt-dossier.js"></script><script src="/js/pipeline-dossier-activity.js"></script><script src="/js/pipeline-drawer.js"></script><script src="/js/pipeline.js"></script>'
      ].join('\n')
    });
  });
};
