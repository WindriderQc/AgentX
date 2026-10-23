'use strict';

// Pipeline is engineering work, not the owner's personal task list. This
// selector adds a bounded read hint without restricting Main's other tools.
function requestsPipelineRead(text) {
  const input = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(?:pipeline|coding\s+team|equipe\s+(?:de\s+(?:code|codage|developpement)|coding)|pull\s+requests?)\b/.test(input)
    && /\b(?:quoi|quels?|quelles?|priorite|prioritaires?|statut|etat|status|priority|priorities|what|which|show|regarde|verifie|consulte|travaille\w*|travailler|bosse\w*|active\w*|working)\b/.test(input)
    && !/\b(?:ne\b[^.!?]{0,40}\bpas|do not|don't|explique|explain|comment|how to|histoire|story)\b/.test(input);
}
const PIPELINE_DIRECTIVE = 'For this current pipeline read, discover ecosystem_snapshot and call it with {"mode":"pipeline","maxChars":5000}. It returns a compact sanitized priority view from the canonical engineering Pipeline, distinct from personal tasks and the heavy-work queue. Use its visible task titles, states and numeric priorities; lower numeric priority runs first. Respect withheld records and incomplete counts. Report unavailable fields explicitly instead of repeatedly searching tools, memory or a specialist for the same missing data. Do not claim that an unrelated platform alert is a task blocker. Delegate only if this verified projection leaves a specific necessary capability unavailable.';
module.exports = { requestsPipelineRead, PIPELINE_DIRECTIVE };
