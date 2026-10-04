'use strict';

const option = (key, group, title, description, cost, surfaces) => ({ key, group, title, description, cost, surfaces });
const CATALOG = Object.freeze([
  option('profileContext', 'context', 'Mon profil', 'Ajoute les informations et préférences que tu as renseignées.', 'Contexte supplémentaire', ['playground', 'psyx']),
  option('historyContext', 'context', 'Historique de cet échange', 'Envoie les échanges précédents dans le contexte fourni par Core. Le transcript reste conservé.', 'Contexte supplémentaire', ['playground', 'psyx', 'nestor', 'family']),
  option('memoryContext', 'context', 'Souvenirs sélectionnés', 'Consulte et ajoute les souvenirs utiles à la réponse.', 'Recherche et contexte', ['psyx', 'nestor', 'family']),
  option('recapContext', 'context', 'Point confirmé', 'Ajoute le résumé de séance que tu as confirmé pour faciliter la reprise.', 'Lecture et contexte', ['psyx', 'nestor']),
  option('previousSessionsContext', 'context', 'Résumés des séances précédentes', 'Ajoute les résumés automatiques des autres séances PsyX.', 'Contexte supplémentaire', ['psyx']),
  option('portraitContext', 'context', 'Portrait', 'Ajoute le portrait construit entre les séances.', 'Contexte supplémentaire', ['psyx']),
  option('experimentContext', 'context', 'Objectifs et essais', 'Ajoute tes objectifs, essais en cours et points de suivi.', 'Contexte supplémentaire', ['psyx']),
  option('assessmentContext', 'context', 'Questionnaires', 'Ajoute les résultats et tendances des questionnaires renseignés.', 'Contexte supplémentaire', ['psyx']),
  option('techniqueContext', 'context', 'Repères et techniques', 'Ajoute les fiches de techniques au contexte de réponse. La boîte à outils reste accessible.', 'Contexte supplémentaire', ['psyx']),
  option('timeContext', 'context', 'Repères de temps', 'Ajoute la date et le temps écoulé depuis les échanges.', 'Contexte supplémentaire', ['psyx']),
  option('knowledgeContext', 'context', 'Documents approuvés', 'Recherche les documents autorisés pour cet espace et ajoute les passages utiles.', 'Recherche documentaire', ['nestor', 'family']),
  option('householdContext', 'context', 'Famille et routines', 'Ajoute les membres du foyer ou les routines familiales autorisées pour cet espace.', 'Lecture et contexte', ['nestor', 'family']),
  option('reviewContext', 'context', 'Conseils de la revue', 'Ajoute les corrections proposées par la revue de Nestor au tour suivant.', 'Contexte supplémentaire', ['nestor', 'family']),
  option('autoRecommendations', 'reply', 'Adaptation automatique', 'Laisse PsyX utiliser les recommandations de sa revue pour choisir le mode et la profondeur en Auto.', 'Peut choisir un calcul plus long', ['psyx']),
  option('deepReasoning', 'reply', 'Réflexion approfondie', 'Autorise la profondeur « Profonde ». Désactivée, PsyX répond en profondeur normale.', 'Calcul supplémentaire', ['psyx']),
  option('recapDraft', 'reply', 'Proposition de résumé', 'Autorise un appel local lorsque tu demandes un résumé. Écrire et enregistrer ton point reste possible.', 'Un appel modèle, sur demande', ['psyx', 'nestor']),
  option('backgroundReview', 'background', 'Revue après réponse', 'Prépare des observations après les échanges. La désactivation empêche les nouveaux calculs et écarte les résultats encore en cours.', 'Appels modèle après les réponses', ['psyx', 'nestor', 'family']),
  option('dreamEnabled', 'background', 'Rêverie disponible', 'Autorise la construction du portrait, automatiquement ou sur demande. Le portrait déjà enregistré est conservé.', 'Appels modèle de réflexion', ['psyx']),
  option('automaticDream', 'background', 'Rêverie automatique', 'Réfléchit entre les séances et la nuit. Désactiver cette option garde la commande manuelle « Approfondir maintenant ».', 'Appels modèle en arrière-plan', ['psyx']),
  option('dreamNotes', 'sources', 'Notes de Nestor', 'Autorise la rêverie à consulter les notes personnelles de Nestor.', 'Lecture et contexte de rêverie', ['psyx']),
  option('dreamTasks', 'sources', 'Tâches et rappels', 'Autorise la rêverie à consulter les tâches personnelles ouvertes.', 'Lecture et contexte de rêverie', ['psyx']),
  option('dreamMail', 'sources', 'Journal de courriels', 'Autorise la rêverie à consulter les résumés du journal de courriels.', 'Lecture et contexte de rêverie', ['psyx'])
]);
const NUMBERS = [
  { ...option('reviewDelaySeconds', 'background', 'Délai avant la revue', 'Attend après la réponse avant de lancer la revue. Un délai plus long laisse davantage de place à la conversation.', 'Secondes · sans appel supplémentaire', ['psyx', 'nestor', 'family']), type: 'number', min: 0, max: 600, step: 'any' },
  { ...option('dreamIdleMinutes', 'background', 'Repos avant la rêverie', 'Attend cette durée sans échange avant une rêverie automatique.', 'Minutes · rythme des calculs', ['psyx']), type: 'number', min: 1, max: 1440, step: 1 },
  { ...option('dreamNightHour', 'background', 'Heure de la rêverie nocturne', 'Heure locale du foyer, de 0 à 23. La nouvelle heure vaut pour les prochaines nuits.', 'Heure · rythme des calculs', ['psyx']), type: 'number', min: 0, max: 23, step: 1 }
];
const GROUPS = { context: 'Contexte de la réponse', reply: 'Calcul de la réponse', background: 'Après les échanges', sources: 'Sources de la rêverie' };
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
  return selected;
}
module.exports = { CATALOG, SURFACES, catalogFor, defaultsFor, selectPsyxState };
