'use strict';

// Standard self-report questionnaires, scored by code and never by a model.
// PHQ-9 (low mood) and GAD-7 (anxiety) are in the public domain. A score is a
// measure of symptoms over the last two weeks, not a diagnosis; its value here
// is the trend, and knowing when to suggest professional help.

const crypto = require('crypto');

const DAY = 86400000;
const ASSESSMENT_LIMIT = 60;
const DUE_AFTER_DAYS = 21;
const FREQUENCY = Object.freeze(['Jamais', 'Plusieurs jours', 'Plus de la moitié du temps', 'Presque tous les jours']);
const INTRO = 'Au cours des deux dernières semaines, à quelle fréquence as-tu été dérangé par les problèmes suivants?';

const ASSESSMENTS = Object.freeze({
  phq9: {
    title: 'Humeur (PHQ-9)', measures: 'low mood', intro: INTRO, choices: FREQUENCY,
    items: [
      'Peu d’intérêt ou de plaisir à faire les choses',
      'Être triste, déprimé ou désespéré',
      'Difficultés à s’endormir ou à rester endormi, ou dormir trop',
      'Se sentir fatigué ou manquer d’énergie',
      'Avoir peu d’appétit ou manger trop',
      'Avoir une mauvaise opinion de soi-même, ou avoir le sentiment d’être nul, ou d’avoir déçu sa famille ou s’être déçu soi-même',
      'Avoir du mal à se concentrer, par exemple pour lire le journal ou regarder la télévision',
      'Bouger ou parler si lentement que les autres auraient pu le remarquer; ou au contraire, être si agité que tu as eu du mal à tenir en place',
      'Penser qu’il vaudrait mieux mourir, ou envisager de te faire du mal d’une manière ou d’une autre'
    ],
    bands: [[0, 'minimal'], [5, 'léger'], [10, 'modéré'], [15, 'modérément sévère'], [20, 'sévère']],
    // The last item asks about thoughts of death or self-harm: any answer above "never" is a safety signal.
    safetyItem: 8
  },
  gad7: {
    title: 'Anxiété (GAD-7)', measures: 'anxiety', intro: INTRO, choices: FREQUENCY,
    items: [
      'Sentiment de nervosité, d’anxiété ou de tension',
      'Incapable d’arrêter de t’inquiéter ou de contrôler tes inquiétudes',
      'Inquiétudes excessives à propos de tout et de rien',
      'Difficulté à se détendre',
      'Agitation telle qu’il est difficile de rester tranquille',
      'Devenir facilement contrarié ou irritable',
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
  const definition = ASSESSMENTS[kind];
  if (!definition) throw invalid('Unknown questionnaire');
  if (!Array.isArray(answers) || answers.length !== definition.items.length
    || answers.some(value => !Number.isInteger(value) || value < 0 || value >= definition.choices.length)) {
    throw invalid(`Answer the ${definition.items.length} questions, each from 0 to ${definition.choices.length - 1}`);
  }
  const score = answers.reduce((sum, value) => sum + value, 0);
  const band = definition.bands.filter(([from]) => score >= from).at(-1)[1];
  return { kind, answers, score, band, safety: definition.safetyItem !== undefined && answers[definition.safetyItem] > 0 };
}

function createAssessment(kind, answers, now = new Date()) {
  return { id: crypto.randomUUID(), ...scoreAssessment(kind, answers), at: now.toISOString() };
}

// Stored results are rescored on read: the score always follows the answers.
function normalizeAssessments(value) {
  return (Array.isArray(value) ? value : []).map(item => {
    const at = new Date(item?.at);
    if (!item?.id || Number.isNaN(at.getTime())) return null;
    try { return { id: String(item.id).slice(0, 80), ...scoreAssessment(item.kind, item.answers), at: at.toISOString() }; } catch { return null; }
  }).filter(Boolean).slice(-ASSESSMENT_LIMIT);
}

// A questionnaire is offered when it was never taken or the last one is three weeks old.
function dueAssessments(state, now = new Date()) {
  return KINDS.filter(kind => {
    const last = (state.assessments || []).filter(item => item.kind === kind).at(-1);
    return !last || now.getTime() - new Date(last.at).getTime() >= DUE_AFTER_DAYS * DAY;
  });
}

// What PsyX sees: the latest score of each questionnaire, its trend, and a safety flag.
function assessmentSystemMessage(state, now = new Date()) {
  const lines = KINDS.map(kind => {
    const results = (state.assessments || []).filter(item => item.kind === kind);
    const last = results.at(-1);
    if (!last) return '';
    const max = ASSESSMENTS[kind].items.length * (ASSESSMENTS[kind].choices.length - 1);
    const days = Math.max(0, Math.round((now.getTime() - new Date(last.at).getTime()) / DAY));
    const previous = results.at(-2);
    const trend = previous ? `, was ${previous.score} before (${last.score - previous.score >= 0 ? '+' : ''}${last.score - previous.score})` : '';
    const safety = last.safety ? ' He answered above "never" to thoughts of death or self-harm: check in on it gently and directly.' : '';
    return `${ASSESSMENTS[kind].measures} ${last.score}/${max}, ${last.band}, ${days} days ago${trend}.${safety}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `QUESTIONNAIRES — his own answers to standard questionnaires, scored by code. A measure of symptoms over two weeks, never a diagnosis; a moderate or higher score that lasts is a reason to suggest professional help.\n${lines.join('\n')}`;
}

function publicDefinitions() {
  return Object.fromEntries(KINDS.map(kind => {
    const { title, intro, choices, items, bands } = ASSESSMENTS[kind];
    return [kind, { title, intro, choices, items, max: items.length * (choices.length - 1), bands }];
  }));
}

module.exports = { ASSESSMENTS, KINDS, ASSESSMENT_LIMIT, DUE_AFTER_DAYS, scoreAssessment, createAssessment, normalizeAssessments, dueAssessments, assessmentSystemMessage, publicDefinitions };
