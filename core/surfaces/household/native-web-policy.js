'use strict';
const { requestsReadEffects } = require('./native-specialist-policy');

// Migration selection only. Native permissions still authorize every tool.
// Effects, personal records and local service checks keep their existing owner.
function requestsWebRead(text) {
  const input = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (requestsReadEffects(input)) return false;
  if (/\bne\b[^.!?]{0,16}\b(?:cherch\w*|recherch\w*|verifi\w*|consult\w*|lis|lire|ouvre|regarde)\b[^.!?]{0,16}\bpas\b/.test(input)
      || /\b(?:do not|don't)\s+(?:search|look|read|check|fetch)\b/.test(input)) return false;
  const explicit = /\b(?:cherch\w*|recherch\w*|search|verifi\w*|check|consult\w*|lis|lire|read|ouvre|open|regarde|look|fetch)\b/.test(input)
    && /\b(?:web|internet|en ligne|online)\b|https?:\/\//.test(input);
  if (explicit) return true;
  if (/\b(?:taches?|tasks?|courriels?|e[ -]?mails?|gmail|serveurs?|servers?|services?|gpu|modeles?|models?|agentx|openclaw)\b/.test(input)) return false;
  const current = /\b(?:ce soir|aujourd['’]hui|demain|actuel\w*|recent\w*|dernier\w*|en direct|maintenant|tonight|today|tomorrow|current|latest|live|right now)\b/.test(input);
  const publicFact = /\b(?:joue\w*|play\w*|match\w*|games?|scores?|resultats?|results?|horaire\w*|schedules?|meteo|weather|prevision\w*|forecast\w*|temperatures?|actualites?|news|prix|prices?|cours|stocks?|trafic|traffic|vols?|flights?|ouvert\w*|ferme\w*|opening|closing)\b/.test(input);
  return current && publicFact;
}

const WEB_DIRECTIVE = 'The user requested current public information. Use the available native web_search or web_fetch and return the checked answer with its source. tool_search discovers tool definitions; it never searches web pages. Discover the capability by its name (web_search or web_fetch), then invoke the discovered id through tool_call with the actual research query or URL. Do not send the sports, weather or news question to tool_search. Check a primary source when possible, preserve the requested local date, and report an actual lookup failure rather than claiming Nestor has no web access. This read is already requested; complete it without asking permission to search. Keep this simple consultation bounded: at most four web calls and eight tool calls including discovery. Use a precise dated search, then only URLs returned by that search or a verified official URL. Do not guess API endpoints or keep trying URL variants. A navigation page is not a schedule. Stop as soon as the answer is verified; if those reads cannot verify it, return a concise explanation of that actual limitation with the sources tried. Never prolong the run to find a perfect answer.';

function webCheckObserved(evidence, runId) {
  const checks = evidence?.toolChecks;
  return checks?.status === 'observed' && checks.runId === runId && !checks.loop
    && checks.completedTools?.some(tool => ['web_search', 'web_fetch'].includes(tool)) === true;
}

module.exports = { requestsWebRead, WEB_DIRECTIVE, webCheckObserved };
