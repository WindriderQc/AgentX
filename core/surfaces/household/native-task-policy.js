'use strict';

const { requestsTaskCheck } = require('./tool-turn-guard');

function requestsTaskContextRead(text) {
  const input = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // The contextual read selects active owner actions. Review findings and
  // other explicit scopes/filters remain with Main's existing task tools.
  return requestsTaskCheck(text) && !/\b(?:termine\w*|complete\w*|done|closed|ferme\w*|annule\w*|archive\w*|pipeline|enfants?|children|kids|family|famille|revoir|review|triage|extractions?|extrait\w*|categories?|courriels?|emails?|plateforme|platform|assistant)\b/.test(input);
}

const TASK_CONTEXT_DIRECTIVE = 'For this explicit personal-task read, start with conversation_work context. Its receipt and data fields contain a verified current tasks.personal.list read from Core with scope active: owner actions, excluding findings awaiting review. totalCount describes that scope independently of pagination. Use that result for the requested task component rather than discovering or describing another task-list tool or reading the same list again. Do not treat a paginated result as a complete list. When the supplied fields or coverage are unavailable, use the existing task tools and state the actual failure if necessary. Complete any other requested work with your installed capabilities. Preserve any requested maximum number of titles in both speech and screen lists; the total count is not a request to display every title. This changes neither your other installed capabilities nor the request restrictions.';

module.exports = { requestsTaskContextRead, TASK_CONTEXT_DIRECTIVE };
