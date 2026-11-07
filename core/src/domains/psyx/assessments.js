'use strict';

// Standard self-report questionnaires, scored by code and never by a model.
// A score is a measure of symptoms over the last two weeks, not a diagnosis;
// its value here is the trend, and knowing when to suggest professional help.
//
// The wording is the official "French for Canada" translation published on
// phqscreeners.com, reproduced word for word; each form states that no
// permission is required to reproduce, translate, display or distribute it.
// Only the paper instruction to tick a box is left out. A new result records
// the version it was answered with. Results saved before versioning carry
// none: their wording was written from memory and matches no official form.
// Changing a text means a new version, never an edit under the same one.

const crypto = require('crypto');

const DAY = 86400000;
const ASSESSMENT_LIMIT = 60;
const DUE_AFTER_DAYS = 21;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,79}$/i;
const SOURCE_FOLDER = 'https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412';

const ASSESSMENTS = Object.freeze({
  phq9: {
    title: 'Humeur (PHQ-9)', measures: 'low mood',
    version: 'phq9-fr-CA-phqscreeners-201412',
    // sha256 of the PDF the text was compared against, retrieved on 2026-11-07.
    source: { name: 'PHQ-9, French for Canada (phqscreeners.com)', url: `${SOURCE_FOLDER}/PHQ9_French%20for%20Canada.pdf`,
      sha256: '74f61665b170d90ba5eef3cb63bd5375fe0c635e20159d6a9c703595b697e121' },
    intro: 'Au cours des deux dernières semaines, à quelle fréquence avez-vous été dérangé(e) par les problèmes suivants?',
    choices: ['Jamais', 'Plusieurs jours', 'Plus de sept jours', 'Presque tous les jours'],
    items: [
      'Peu d’intérêt ou de plaisir à faire des choses',
      'Se sentir triste, déprimé(e) ou désespéré(e)',
      'Difficultés à s’endormir ou à rester endormi(e), ou trop dormir',
      'Se sentir fatigué(e) ou avoir peu d’énergie',
      'Peu d’appétit ou trop manger',
      'Mauvaise perception de vous-même — ou vous pensez que vous êtes un perdant ou que vous n’avez pas satisfait vos propres attentes ou celles de votre famille',
      'Difficultés à se concentrer sur des choses telles que lire le journal ou regarder la télévision',
      'Vous bougez ou parlez si lentement que les autres personnes ont pu le remarquer. Ou au contraire — vous êtes si agité(e) que vous bougez beaucoup plus que d’habitude',
      'Vous avez pensé que vous seriez mieux mort(e) ou pensé à vous blesser d’une façon ou d’une autre'
    ],
    bands: [[0, 'minimal'], [5, 'léger'], [10, 'modéré'], [15, 'modérément sévère'], [20, 'sévère']],
    // The last item asks about thoughts of death or self-harm: any answer above "never" is a safety signal.
    safetyItem: 8
  },
  gad7: {
    title: 'Anxiété (GAD-7)', measures: 'anxiety',
    version: 'gad7-fr-CA-phqscreeners-201412',
    source: { name: 'GAD-7, French for Canada (phqscreeners.com)', url: `${SOURCE_FOLDER}/GAD7_French%20for%20Canada.pdf`,
      sha256: '090c86b5b2126691cad92fef9002cfd698c8446c2e53b0bed67fd66d5c542e04' },
    intro: 'Au cours des 14 derniers jours, à quelle fréquence avez-vous été dérangé(e) par les problèmes suivants?',
    choices: ['Jamais', 'Plusieurs jours', 'Plus de la moitié des jours', 'Presque tous les jours'],
    items: [
      'Sentiment de nervosité, d’anxiété ou de tension',
      'Incapable d’arrêter de vous inquiéter ou de contrôler vos inquiétudes',
      'Inquiétudes excessives à propos de tout et de rien',
      'Difficulté à se détendre',
      'Agitation telle qu’il est difficile de rester tranquille',
      'Devenir facilement contrarié(e) ou irritable',
      'Avoir peur que quelque chose d’épouvantable puisse arriver'
    ],
    bands: [[0, 'minimal'], [5, 'léger'], [10, 'modéré'], [15, 'sévère']]
  }
});
const KINDS = Object.freeze(Object.keys(ASSESSMENTS));

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// -> { kind, answers, score, band, safety } or throws 400.
function scoreAssessment(kind, answers) {
  if (typeof kind !== 'string' || !Object.hasOwn(ASSESSMENTS, kind)) throw invalid('Unknown questionnaire');
  const definition = ASSESSMENTS[kind];
  if (!Array.isArray(answers) || answers.length !== definition.items.length
    || answers.some(value => !Number.isInteger(value) || value < 0 || value >= definition.choices.length)) {
    throw invalid(`Answer the ${definition.items.length} questions, each from 0 to ${definition.choices.length - 1}`);
  }
  const score = answers.reduce((sum, value) => sum + value, 0);
  const band = definition.bands.filter(([from]) => score >= from).at(-1)[1];
  return { kind, answers, score, band, safety: definition.safetyItem !== undefined && answers[definition.safetyItem] > 0 };
}

// A new result names the wording it was answered with.
function createAssessment(kind, answers, now = new Date()) {
  const scored = scoreAssessment(kind, answers);
  return { id: crypto.randomUUID(), ...scored, version: ASSESSMENTS[kind].version, at: now.toISOString() };
}

// Stored results are rescored on read: the score always follows the answers.
// A recorded version is kept as it was; a result without one stays without one.
function normalizeAssessments(value) {
  return (Array.isArray(value) ? value : []).map(item => {
    const at = new Date(item?.at);
    if (!item?.id || Number.isNaN(at.getTime())) return null;
    const version = typeof item.version === 'string' && VERSION_PATTERN.test(item.version) ? { version: item.version } : {};
    try { return { id: String(item.id).slice(0, 80), ...scoreAssessment(item.kind, item.answers), ...version, at: at.toISOString() }; } catch { return null; }
  }).filter(Boolean).slice(-ASSESSMENT_LIMIT);
}

// A questionnaire is offered when it was never taken or the last one is three weeks old.
function dueAssessments(state, now = new Date()) {
  return KINDS.filter(kind => {
    const last = (state.assessments || []).filter(item => item.kind === kind).at(-1);
    return !last || now.getTime() - new Date(last.at).getTime() >= DUE_AFTER_DAYS * DAY;
  });
}

// What PsyX sees: the latest score of each questionnaire, its trend, and a
// safety flag. The flag holds for three weeks from any answer that raised it:
// retaking the questionnaire does not erase it, and it does not last forever.
function assessmentSystemMessage(state, at = null) {
  const now = at instanceof Date ? at : new Date();
  const recent = item => now.getTime() - new Date(item.at).getTime() < DUE_AFTER_DAYS * DAY;
  const lines = KINDS.map(kind => {
    const results = (state.assessments || []).filter(item => item.kind === kind);
    const last = results.at(-1);
    if (!last) return '';
    const max = ASSESSMENTS[kind].items.length * (ASSESSMENTS[kind].choices.length - 1);
    const days = Math.max(0, Math.round((now.getTime() - new Date(last.at).getTime()) / DAY));
    const previous = results.at(-2);
    const trend = previous ? `, was ${previous.score} before (${last.score - previous.score >= 0 ? '+' : ''}${last.score - previous.score})` : '';
    const safety = results.some(item => item.safety && recent(item))
      ? ' In the last three weeks he answered above "never" to thoughts of death or self-harm: check in on it gently and directly, and suggest professional help now.' : '';
    return `${ASSESSMENTS[kind].measures} ${last.score}/${max}, ${last.band}, ${days === 1 ? '1 day' : `${days} days`} ago${trend}.${safety}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `QUESTIONNAIRES — his own answers to standard questionnaires, scored by code. A measure of symptoms over two weeks, never a diagnosis. A moderate or higher score that lasts is a reason to suggest professional help; a severe one is a reason to suggest it now.\n${lines.join('\n')}`;
}

function publicDefinitions() {
  return Object.fromEntries(KINDS.map(kind => {
    const { title, version, intro, choices, items, bands } = ASSESSMENTS[kind];
    return [kind, { title, version, intro, choices, items, max: items.length * (choices.length - 1), bands }];
  }));
}

module.exports = { ASSESSMENTS, KINDS, ASSESSMENT_LIMIT, DUE_AFTER_DAYS, scoreAssessment, createAssessment, normalizeAssessments, dueAssessments, assessmentSystemMessage, publicDefinitions };
