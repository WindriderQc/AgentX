'use strict';

// Category suggestions for uncategorized descriptions. A local model proposes a
// category from the fixed list and short tags; nothing is saved until the owner
// accepts a suggestion, which then becomes an ordinary rule. Only descriptions
// go to the model, never amounts or account numbers.

const { CATEGORIES, uncategorized, descriptionKey } = require('./financeCategories');

const SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          label: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
          tags: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['haute', 'moyenne', 'basse'] }
        },
        required: ['index', 'label', 'category', 'confidence']
      }
    }
  },
  required: ['suggestions']
};

function prompt(items) {
  return `Tu classes des libellés de transactions bancaires québécoises (français). Pour chaque libellé numéroté,
choisis UNE catégorie dans la liste fermée et au plus 3 tags courts en minuscules (ex. marchand, activité).
Catégories : ${CATEGORIES.join(', ')}.
Repères : épiceries et Costco alimentaire = Épicerie; restaurants, cafés, fast-food = Restaurants; essence,
stationnement, STM/RTC = Transport; garage, pièces, SAAQ = Auto; pharmacie, dentiste, clinique = Santé;
Netflix, Spotify, téléphone, internet = Abonnements; frais de service = Frais bancaires; retraits au guichet =
Retraits. Ambigus, donc confidence "basse" : paiements de carte de crédit depuis le compte (« Paiement facture …
/ Visa », « / Mastercard », « / Costco », « / carte crédit »), dépôts et virements sans nom, retraits au comptoir.
Si le libellé est ambigu, mets confidence "basse" plutôt que d'inventer.
Pour chaque réponse, recopie le libellé exact dans "label" avec son numéro dans "index".
Réponds en JSON seulement.

${items.map((item, index) => `${index}. ${item}`).join('\n')}`;
}

function sameLabel(echoed, description) {
  const a = descriptionKey(echoed).replace(/[^a-z0-9]+/g, '');
  const b = descriptionKey(description).replace(/[^a-z0-9]+/g, '');
  const head = b.slice(0, Math.min(12, b.length));
  return Boolean(a) && Boolean(head) && (a.startsWith(head) || b.startsWith(a.slice(0, Math.min(12, a.length))));
}

/**
 * Suggests categories for the `limit` heaviest uncategorized descriptions.
 * Returns { suggestions: [{ pattern, description, count, totalCents, category,
 * tags, confidence }] } without saving anything.
 */
async function suggest({ limit } = {}, {
  execute = require('../inferenceService').executeInference,
  model = process.env.FINANCE_EXTRACTION_MODEL || ''
} = {}) {
  const max = Math.min(Math.max(Number.parseInt(limit, 10) || 15, 1), 25);
  const pending = (await uncategorized({ limit: max })).descriptions;
  if (!pending.length) return { suggestions: [] };
  const result = await execute({
    callerDetail: 'finance-suggestions',
    ...(model ? { model } : { taskType: 'analysis' }),
    messages: [{ role: 'user', content: prompt(pending.map((group) => group.description)) }],
    stream: false,
    think: false,
    format: SCHEMA,
    options: { temperature: 0, num_predict: 4000 }
  }, { timeoutMs: 300000 });
  if (!result?.ok) {
    throw Object.assign(new Error(result?.body?.message || 'Local inference is unavailable'),
      { status: result?.status || 503, code: result?.body?.code || 'FINANCE_INFERENCE_UNAVAILABLE' });
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.body?.message?.content ?? result.body?.response ?? '').trim());
  } catch {
    throw Object.assign(new Error('The model did not return valid suggestions'), { status: 502, code: 'FINANCE_SUGGESTIONS_INVALID' });
  }
  const byIndex = new Map((parsed.suggestions || []).map((item) => [item.index, item]));
  return {
    suggestions: pending.map((group, index) => {
      const item = byIndex.get(index);
      // The echoed label must match the description at that index, or the
      // model answered for another line: keep the category only as a hint.
      const aligned = Boolean(item) && sameLabel(item.label, group.description);
      const category = CATEGORIES.includes(item?.category) ? item.category : null;
      return {
        pattern: group.suggestedPattern || descriptionKey(group.description),
        description: group.description,
        count: group.count,
        totalCents: group.totalCents,
        category,
        tags: (Array.isArray(item?.tags) ? item.tags : []).map((tag) => descriptionKey(tag).replace(/[^a-z0-9-]+/g, '-')).filter(Boolean).slice(0, 3),
        confidence: category && aligned ? (item?.confidence || 'basse') : 'basse',
        aligned
      };
    })
  };
}

module.exports = { suggest };
