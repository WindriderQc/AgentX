'use strict';

const option = (key, group, title, description, cost, surfaces) => ({ key, group, title, description, cost, surfaces });
const CATALOG = Object.freeze([
  option('profileContext', 'context', 'My profile', 'Adds the information and preferences you entered.', 'Extra context', ['playground']),
  option('historyContext', 'context', 'Conversation history', 'Sends earlier messages in the context Core provides. The transcript is kept either way.', 'Extra context', ['playground', 'nestor', 'family']),
  option('memoryContext', 'context', 'Selected memories', 'Looks up and adds memories that help the reply.', 'Search and context', ['nestor', 'family']),
  option('recapContext', 'context', 'Confirmed recap', 'Adds the session recap you confirmed, to make picking up easier.', 'Read and context', ['nestor']),
  option('knowledgeContext', 'context', 'Approved documents', 'Searches the documents allowed for this space and adds useful passages.', 'Document search', ['nestor', 'family']),
  option('householdContext', 'context', 'Family and routines', 'Adds the household members or family routines allowed for this space.', 'Read and context', ['nestor', 'family']),
  option('reviewContext', 'context', 'Review advice', 'Adds the corrections suggested by Nestor’s review to the next turn.', 'Extra context', ['nestor', 'family']),
  option('recapDraft', 'reply', 'Recap draft', 'Allows a local call when you ask for a recap. You can still write and save your own recap.', 'One model call, on request', ['nestor']),
  option('backgroundReview', 'background', 'Post-reply review', 'Prepares observations after messages. Turning it off stops new runs and discards results still in progress.', 'Model calls after replies', ['nestor', 'family']),
  option('deepReview', 'background', 'Deeper review', 'Lets the post-reply review think and write more before its observations. Off by default; personal conversations only.', 'Longer model calls after replies', ['nestor']),
]);
const NUMBERS = [
  { ...option('reviewDelaySeconds', 'background', 'Delay before review', 'Waits after the reply before starting the review. A longer delay leaves more room for the conversation.', 'Seconds · no extra call', ['nestor', 'family']), type: 'number', min: 0, max: 600, step: 'any' },
];
const GROUPS = { context: 'Reply context', reply: 'Reply compute', background: 'After messages' };
const SURFACES = ['playground', 'nestor', 'family'];
function catalogFor(surface, env = process.env) {
  const fields = [...CATALOG, ...NUMBERS].filter(item => item.surfaces.includes(surface)).map(({ surfaces, ...item }) => ({ ...item, groupTitle: GROUPS[item.group] }));
  return surface === 'nestor' ? [require('../conversationWorks/performance').profileField(env), ...fields] : fields;
}
function defaultsFor(surface, env = process.env) {
  const values = Object.fromEntries(catalogFor(surface, env).map(item => [item.key, item.type === 'enum' ? 'local' : true]));
  if (['nestor', 'family'].includes(surface)) values.backgroundReview = env.HOUSEHOLD_BRAIN_ENABLED === 'true' && (surface !== 'family' || env.HOUSEHOLD_BRAIN_FAMILY !== 'false');
  if (['nestor', 'family'].includes(surface)) values.reviewDelaySeconds = 0.8;
  if (surface === 'nestor') values.deepReview = false;
  return values;
}
module.exports = { CATALOG, SURFACES, catalogFor, defaultsFor };
