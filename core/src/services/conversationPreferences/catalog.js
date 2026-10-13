'use strict';

const option = (key, group, title, description, cost, surfaces) => ({ key, group, title, description, cost, surfaces });
const CATALOG = Object.freeze([
  option('profileContext', 'context', 'My profile', 'Adds the information and preferences you entered.', 'Extra context', ['playground', 'psyx']),
  option('historyContext', 'context', 'Conversation history', 'Sends earlier messages in the context Core provides. The transcript is kept either way.', 'Extra context', ['playground', 'psyx', 'nestor', 'family']),
  option('memoryContext', 'context', 'Selected memories', 'Looks up and adds memories that help the reply.', 'Search and context', ['psyx', 'nestor', 'family']),
  option('recapContext', 'context', 'Confirmed recap', 'Adds the session recap you confirmed, to make picking up easier.', 'Read and context', ['psyx', 'nestor']),
  option('previousSessionsContext', 'context', 'Previous session summaries', 'Adds the automatic summaries of your other PsyX sessions.', 'Extra context', ['psyx']),
  option('portraitContext', 'context', 'Portrait', 'Adds the portrait built between sessions.', 'Extra context', ['psyx']),
  option('experimentContext', 'context', 'Goals and experiments', 'Adds your goals, ongoing experiments and check-ins.', 'Extra context', ['psyx']),
  option('assessmentContext', 'context', 'Questionnaires', 'Adds the results and trends of completed questionnaires.', 'Extra context', ['psyx']),
  option('techniqueContext', 'context', 'Guides and techniques', 'Adds technique sheets to the reply context. The toolbox stays available.', 'Extra context', ['psyx']),
  option('timeContext', 'context', 'Time cues', 'Adds the date and the time elapsed since earlier messages.', 'Extra context', ['psyx']),
  option('knowledgeContext', 'context', 'Approved documents', 'Searches the documents allowed for this space and adds useful passages.', 'Document search', ['nestor', 'family']),
  option('householdContext', 'context', 'Family and routines', 'Adds the household members or family routines allowed for this space.', 'Read and context', ['nestor', 'family']),
  option('reviewContext', 'context', 'Review advice', 'Adds the corrections suggested by Nestor’s review to the next turn.', 'Extra context', ['nestor', 'family']),
  option('autoRecommendations', 'reply', 'Automatic adaptation', 'Lets PsyX use its review recommendations to choose mode and depth in Auto.', 'May choose longer compute', ['psyx']),
  option('deepReasoning', 'reply', 'Deep reasoning', 'Allows the Deep depth. When off, PsyX replies at normal depth.', 'Extra compute', ['psyx']),
  option('recapDraft', 'reply', 'Recap draft', 'Allows a local call when you ask for a recap. You can still write and save your own recap.', 'One model call, on request', ['psyx', 'nestor']),
  option('backgroundReview', 'background', 'Post-reply review', 'Prepares observations after messages. Turning it off stops new runs and discards results still in progress.', 'Model calls after replies', ['psyx', 'nestor', 'family']),
  option('dreamEnabled', 'background', 'Dreaming available', 'Allows building the portrait, automatically or on request. The saved portrait is kept.', 'Reflection model calls', ['psyx']),
  option('automaticDream', 'background', 'Automatic dreaming', 'Reflects between sessions and at night. Turning it off keeps the manual command available.', 'Background model calls', ['psyx']),
  option('dreamNotes', 'sources', 'Nestor’s notes', 'Lets dreaming read Nestor’s personal notes.', 'Dreaming read and context', ['psyx']),
  option('dreamTasks', 'sources', 'Tasks and reminders', 'Lets dreaming read open personal tasks.', 'Dreaming read and context', ['psyx']),
  option('dreamMail', 'sources', 'Email log', 'Lets dreaming read the email log summaries.', 'Dreaming read and context', ['psyx'])
]);
const NUMBERS = [
  { ...option('reviewDelaySeconds', 'background', 'Delay before review', 'Waits after the reply before starting the review. A longer delay leaves more room for the conversation.', 'Seconds · no extra call', ['psyx', 'nestor', 'family']), type: 'number', min: 0, max: 600, step: 'any' },
  { ...option('dreamIdleMinutes', 'background', 'Idle time before dreaming', 'Waits this long without messages before automatic dreaming.', 'Minutes · compute pace', ['psyx']), type: 'number', min: 1, max: 1440, step: 1 },
  { ...option('dreamNightHour', 'background', 'Nightly dreaming hour', 'Household local hour, from 0 to 23. A new hour applies from the next night.', 'Hour · compute pace', ['psyx']), type: 'number', min: 0, max: 23, step: 1 }
];
const GROUPS = { context: 'Reply context', reply: 'Reply compute', background: 'After messages', sources: 'Dreaming sources' };
const SURFACES = ['playground', 'psyx', 'nestor', 'family'];
function catalogFor(surface) { return [...CATALOG, ...NUMBERS].filter(item => item.surfaces.includes(surface)).map(({ surfaces, ...item }) => ({ ...item, groupTitle: GROUPS[item.group] })); }
function defaultsFor(surface, env = process.env) {
  const values = Object.fromEntries(catalogFor(surface).map(item => [item.key, true]));
  if (surface === 'psyx') { values.backgroundReview = env.PSYX_AUTO_REVIEW !== 'false'; values.automaticDream = env.PSYX_DREAM !== 'false'; values.dreamEnabled = env.PSYX_DREAM !== 'false'; }
  if (['nestor', 'family'].includes(surface)) values.backgroundReview = env.HOUSEHOLD_BRAIN_ENABLED === 'true' && (surface !== 'family' || env.HOUSEHOLD_BRAIN_FAMILY !== 'false');
  if (surface === 'psyx') Object.assign(values, { reviewDelaySeconds: Number(env.PSYX_REVIEW_DELAY_MS || 4000) / 1000, dreamIdleMinutes: 30, dreamNightHour: 3 });
  if (['nestor', 'family'].includes(surface)) values.reviewDelaySeconds = 0.8;
  return values;
}
function selectPsyxState(state, values) {
  const selected = { ...state };
  if (values.profileContext === false) selected.profile = { about: '', expectations: '' };
  if (values.portraitContext === false) selected.portrait = null;
  if (values.memoryContext === false) for (const key of ['activeThreads', 'notes', 'patterns', 'hypotheses', 'openLoops']) selected[key] = [];
  if (values.previousSessionsContext === false) selected.sessionDigests = [];
  if (values.experimentContext === false) for (const key of ['goals', 'experiments', 'checkIns']) selected[key] = [];
  if (values.assessmentContext === false) selected.assessments = [];
  selected.proposals = (state.proposals || []).filter(item =>
    (values.memoryContext !== false || !['activeThreads', 'notes', 'patterns', 'hypotheses', 'openLoops'].includes(item.kind))
    && (values.experimentContext !== false || !['goals', 'experiments', 'experimentResult'].includes(item.kind)));
  return selected;
}
module.exports = { CATALOG, SURFACES, catalogFor, defaultsFor, selectPsyxState };
