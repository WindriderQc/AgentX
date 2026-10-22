'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// pipeline.js creates its sections from these scripts, which the page loads first.
const PIPELINE_PARTS = ['pipeline-launch.js', 'pipeline-code-steps.js', 'pipeline-code-step-graph.js', 'pipeline-worker-monitor.js', 'pipeline-delivery.js', 'pipeline-board.js', 'pipeline-attempt-dossier.js', 'pipeline-dossier-activity.js', 'pipeline-drawer.js'];
const jsDir = path.resolve(__dirname, '../../public/js');

function readPipelineScript(name = 'pipeline.js') {
  return fs.readFileSync(path.join(jsDir, name), 'utf8');
}

// The whole pipeline page script, for assertions on its source text.
function readPipelineSource() {
  return [...PIPELINE_PARTS, 'pipeline.js'].map(readPipelineScript).join('\n');
}

// Runs the parts in a vm context, as the page does before pipeline.js.
function loadPipelineParts(context) {
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../shared/pipelineReportSelection.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../shared/pipelineWorkerOutcome.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../shared/codeStepSummary.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../shared/codeStepGraphSummary.js'), 'utf8'), context);
  for (const part of PIPELINE_PARTS) vm.runInNewContext(readPipelineScript(part), context);
  return context;
}

module.exports = { PIPELINE_PARTS, readPipelineScript, readPipelineSource, loadPipelineParts };
