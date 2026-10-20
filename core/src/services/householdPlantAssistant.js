'use strict';

// Model help for plant cards (#867): identify a plant from its photo, then
// draft its care sheet from bounded web searches. Each step runs once per plant
// at a time, records its state on the card and only proposes: the parent
// chooses the species and applies or edits the draft. Nothing is published here.

const Plant = require('../../models/HouseholdPlant');
const plants = require('./householdPlantService');
const { CARE_SCHEMA, IDENTIFY_SCHEMA, careDraft, identificationCandidates } = require('../domains/household/plantDrafts');
const { managedPlant } = require('../domains/household/plants');

const STALE_MS = 10 * 60 * 1000;
const MAX_SEARCHES = 3;
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

const IDENTIFY_PROMPT = [
  'You identify houseplants from one photo for a family plant card.',
  'Return up to three candidates, most likely first, as JSON matching the schema.',
  'commonName is the usual Canadian French name (e.g. "Pothos doré"); latinName is the botanical name.',
  'confidence is your honest probability from 0 to 1; the three need not sum to 1. When the photo is unclear, say so with low confidence.',
  'traits names, in French and in a few words, the visible features that support the candidate.',
  'If the photo shows no plant, return an empty candidates list.'
].join(' ');

const CARE_PROMPT = [
  'You draft the care card of one houseplant for a Quebec family with children. Write every text in simple Canadian French.',
  'Use the numbered web results as evidence and cite them by number in each sources list; cite nothing you did not use.',
  'If there are no results, rely on well-established knowledge and leave every sources list empty.',
  'careSheet: one or two short sentences per entry (light, water, humidity, soil, repotting, fertilizer, mistakes).',
  'toxicity: level none, mild or toxic for children, cats and dogs, with a short note. When evidence is unclear, choose the safer level.',
  'funFact: one surprising, true sentence a child would enjoy.',
  'carePlan: two to four recurring actions a child can do, titled as the child will read them with the plant species (e.g. "Arroser le pothos").',
  'Use cadence interval with intervalDays (and winterIntervalDays when winter care differs) for watering; weekly otherwise.',
  'minAgeBand: little only for gentle tasks such as checking the soil with a finger; anything with tools, fertilizer, pesticides or repotting is at least school.'
].join(' ');

function assistantError(error) {
  if (error?.code === 'INFERENCE_VISION_REQUIRED') return { code: 'PLANT_VISION_UNAVAILABLE', message: 'The model routed for plant_identify cannot read images.' };
  if (error?.status && error?.code) return { code: error.code, message: error.message };
  return { code: error?.code || 'PLANT_ASSIST_FAILED', message: 'The model could not complete this step.' };
}

function createPlantAssistant({ inference, consumerContract, searchWeb = require('./webSearch').searchWeb,
  untrustedSearchMessage = require('./webSearch').untrustedSearchMessage, logger = null, now = () => new Date() } = {}) {
  if (!inference?.execute) throw new Error('Plant assistant requires routed inference');

  // Claims one step for one plant. A step left running by a stopped process is stale after ten minutes.
  async function claim(id, step) {
    const { plant } = await plants.get({ id, view: 'manage' });
    if (plant.status === 'retired') throw failure(409, 'PLANT_RETIRED', 'This plant is retired.');
    const startedAt = now();
    const claimed = await Plant.findOneAndUpdate({ _id: plant.id, status: { $ne: 'retired' }, $or: [
      { [`assistant.${step}.state`]: { $ne: 'running' } },
      { [`assistant.${step}.startedAt`]: { $lt: new Date(startedAt.getTime() - STALE_MS) } }
    ] }, { $set: { [`assistant.${step}`]: { state: 'running', startedAt } } }, { new: true }).lean();
    if (!claimed) throw failure(409, 'PLANT_ASSIST_RUNNING', 'This step is already running for this plant.');
    return claimed;
  }

  async function finish(id, step, fields) {
    await Plant.updateOne({ _id: id, [`assistant.${step}.state`]: 'running' },
      { $set: Object.fromEntries(Object.entries({ ...fields, finishedAt: now() }).map(([key, value]) => [`assistant.${step}.${key}`, value])) });
  }

  // Runs a claimed step; the HTTP caller gets the running state at once unless it waits.
  async function run(id, step, work, wait) {
    const task = work().then(fields => finish(id, step, { state: 'completed', ...fields }), async error => {
      const reported = assistantError(error);
      logger?.warn?.('Plant assistant step failed', { step, code: reported.code });
      await finish(id, step, { state: 'failed', error: `${reported.code}: ${reported.message}` });
    }).catch(error => logger?.error?.('Plant assistant state not recorded', { step, error: error.message }));
    if (wait) await task;
    return { plant: managedPlant(await Plant.findById(id).lean()) };
  }

  async function chat(taskType, messages, format, callerDetail) {
    const result = await inference.execute({ mode: 'chat', stream: false, think: false, taskType, format, messages,
      options: { temperature: 0.2, num_predict: taskType === 'plant_identify' ? 800 : 2500 }, timeoutMs: 180000, callerDetail },
    { consumerContract });
    if (!result?.ok) throw failure(502, 'PLANT_ASSIST_FAILED', 'The model did not answer.');
    return { content: result.body?.message?.content || result.body?.response || '', model: result.metadata?.model || null };
  }

  /** Proposes up to three species from a photo (the first one unless photoId names another). */
  async function identify(input = {}) {
    const claimed = await claim(input.id, 'identify');
    const id = String(claimed._id);
    return run(id, 'identify', async () => {
      const photoId = input.photoId || claimed.photos?.[0]?._id;
      if (!photoId) throw failure(409, 'PLANT_PHOTO_REQUIRED', 'Add a photo before identifying the plant.');
      const photo = await plants.photo({ id, photoId, view: 'manage' });
      const answer = await chat('plant_identify', [
        { role: 'system', content: IDENTIFY_PROMPT },
        { role: 'user', content: 'Identifie cette plante d’intérieur.', images: [photo.data.toString('base64')] }
      ], IDENTIFY_SCHEMA, 'agentx-household/plants/identify');
      return { candidates: identificationCandidates(answer.content), model: answer.model };
    }, input.wait === true);
  }

  /** Drafts the care sheet, toxicity, fun fact and care plan for the species the parent chose. */
  async function draftCare(input = {}) {
    const { plant } = await plants.get({ id: input.id, view: 'manage' });
    if (!plant.identification?.commonName) throw failure(409, 'PLANT_SPECIES_REQUIRED', 'Choose the species before drafting its care.');
    const claimed = await claim(input.id, 'care');
    const id = String(claimed._id);
    return run(id, 'care', async () => {
      const { commonName, latinName } = plant.identification;
      const name = latinName || commonName;
      const queries = [`${name} houseplant care light water humidity`, `${name} toxicity cats dogs children`,
        `${commonName} entretien plante d'intérieur arrosage`].slice(0, MAX_SEARCHES);
      const results = [];
      for (const query of queries) {
        const found = await searchWeb(query, { maxResults: 4 });
        for (const result of found.results || []) {
          if (results.length < 10 && /^https?:\/\//.test(result.url || '') && !results.some(entry => entry.url === result.url)) results.push(result);
        }
      }
      const numbered = results.map((result, index) => `[${index + 1}] ${result.title}\n${result.url}\n${result.snippet || ''}`).join('\n\n');
      const answer = await chat('plant_care_draft', [
        { role: 'system', content: CARE_PROMPT },
        { role: 'user', content: `Plante : ${commonName}${latinName ? ` (${latinName})` : ''}.` },
        ...(numbered ? [{ role: 'user', content: untrustedSearchMessage(numbered) }] : [])
      ], CARE_SCHEMA, 'agentx-household/plants/care');
      const { unsourced, ...draft } = careDraft(answer.content, results);
      return { draft, unsourced, model: answer.model };
    }, input.wait === true);
  }

  return Object.freeze({ identify, draftCare });
}

module.exports = { createPlantAssistant };
