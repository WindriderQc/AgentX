'use strict';

// Principal choice is the existing first host pin and the existing task routes.
// The two models it offers are the operator's stored choices
// (principalModelChoices); the product names none. Normal restoration and
// routing remain owners.
const routerConfig = require('./modelRouterConfig');
const hostPrefs = require('./hostPreferenceService');
const { replacePrimaryPin } = require('./hostPinService');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const { runRuntimeMutation } = require('./runtimeMutationLeaseService');
const { hasActiveSessionHold } = require('./hostSessionHoldService');
const { hostHeldByWorkload } = require('./runtimeWorkloadAdmission');
const { invalidateRoutingSnapshots } = require('./routing/routingSnapshotCache');
const { modelsMatch } = require('../helpers/modelNameNormalization');
const choicesStore = require('./principalModelChoices');

const { PRINCIPAL_MODEL_ALIAS, resolvePrincipalAlias } = require('../../integrations/runtime-bridges/principal-model');
function refusal(message, code = 'PRINCIPAL_MODEL_UNAVAILABLE') {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

async function getPrincipalModel() {
  await routerConfig.ensureTaskModelOverridesLoaded();
  const defaults = routerConfig.getDefaultTaskModels().daily_operator;
  const hostUrl = routerConfig.HOSTS[defaults?.host];
  const pref = hostUrl && await hostPrefs.getByHost(hostUrl);
  const pins = hostPrefs.getPinnedEntries(pref);
  const choices = await choicesStore.getChoices({ pinnedModel: pins[0]?.model });
  const options = choicesStore.PRINCIPAL_OPTIONS.map(({ value, label }) => ({ value, label, model: choices[value] }));
  const selected = options.find(option => option.model && option.model === pins[0]?.model);
  const divergent = divergentRoutes(routerConfig.getEffectiveTaskModels(), { hostKey: defaults?.host, pinnedModels: pins });
  return { available: Boolean(selected && pins[0]?.contextSize > 0), divergentRoutes: divergent,
    selected: selected?.value || null, model: pins[0]?.model || null,
    contextSize: pins[0]?.contextSize || null, hostUrl, hostKey: defaults?.host,
    alias: PRINCIPAL_MODEL_ALIAS, options, choicesRevision: choices.revision, choicesSource: choices.source,
    pinnedModels: pins, status: pref?.status || 'unconfigured' };
}

// The host pin owns what its host loads (#829): every route the principal
// host serves with the principal model follows it, and a route there naming
// an unpinned model would evict the pin, so it blocks the switch.
function followedRoutes(config, current) {
  return Object.entries(config).filter(([, entry]) => entry.model === current.model && entry.host === current.hostKey);
}

function divergentRoutes(config, current) {
  return Object.entries(config || {}).filter(([, entry]) => entry?.host === current.hostKey && entry.model
    && !(current.pinnedModels || []).some(pin => modelsMatch(pin.model, entry.model))).map(([task]) => task);
}

async function selectPrincipalModel({ selected, expectedModel, principal, requestId } = {}) {
  const initial = await getPrincipalModel();
  const choice = initial.options.find(option => option.value === selected);
  if (!choice) throw Object.assign(refusal('Choose Standard or Abliterated', 'PRINCIPAL_MODEL_INVALID'), { statusCode: 400 });
  if (!choice.model) throw refusal(`Choose the ${choice.label} model first`, 'PRINCIPAL_CHOICE_UNSET');
  if (!initial.available) throw refusal('Configure the principal pin and its context first');
  if (!expectedModel || expectedModel !== initial.model) throw refusal('Principal model changed; reload and retry', 'HOST_PIN_CONFLICT');
  if (choice.model === initial.model) return initial;
  return movePrincipal({ targetModel: choice.model, expectedModel, principal, requestId });
}

/**
 * Name the model of one option. Changing the option in use moves the pin
 * through the same verified switch, and the new name is stored only once the
 * model is resident and the routes follow it; a failure there rolls both back.
 */
async function saveChoice({ option, model, expectedRevision, expectedModel, principal, requestId } = {},
  { listInstalledModels = defaultInstalledModels } = {}) {
  const initial = await getPrincipalModel();
  const name = choicesStore.validateChoice(choicesStoreView(initial), { option, model });
  if (expectedRevision !== initial.choicesRevision) throw refusal('The choices changed; reload and retry', 'PRINCIPAL_CHOICES_CHANGED');
  if (!initial.hostUrl) throw refusal('The principal host is not configured');
  if (require('./runtimeTopologyParking').isParkedHost(initial.hostUrl)) {
    throw refusal('The principal host is parked: its topology mode is not running. Switch the topology first.', 'PRINCIPAL_HOST_PARKED');
  }
  const installed = await listInstalledModels(initial.hostUrl);
  if (!installed.length) {
    throw Object.assign(refusal(`Cannot list the models of ${initial.hostUrl}; retry when it answers`, 'PRINCIPAL_HOST_UNREACHABLE'), { statusCode: 503 });
  }
  if (!installed.some(entry => modelsMatch(entry, name))) {
    throw refusal(`${name} is not installed on ${initial.hostUrl}`, 'PRINCIPAL_MODEL_NOT_INSTALLED');
  }
  const save = () => choicesStore.saveChoice({ option, model: name, expectedRevision, principal });
  const inUse = initial.selected === option;
  if (!inUse || name === initial.model) {
    await save();
    return getPrincipalModel();
  }
  if (!initial.available) throw refusal('Configure the principal pin and its context first');
  if (!expectedModel || expectedModel !== initial.model) throw refusal('Principal model changed; reload and retry', 'HOST_PIN_CONFLICT');
  return movePrincipal({ targetModel: name, expectedModel, principal, requestId, afterVerified: save });
}

function choicesStoreView(principalModel) {
  return Object.fromEntries(principalModel.options.map(option => [option.value, option.model]));
}

async function defaultInstalledModels(hostUrl) {
  const models = await require('./modelAggregator').fetchOllamaModels(hostUrl);
  return [...new Set(models.map(entry => entry.name || entry.model).filter(Boolean))];
}

/** The models installed on the principal host, for the Nerve Center picker. */
async function listPrincipalHostModels({ listInstalledModels = defaultInstalledModels } = {}) {
  const { hostUrl } = await getPrincipalModel();
  if (!hostUrl) return { hostUrl: null, models: [] };
  return { hostUrl, models: (await listInstalledModels(hostUrl)).sort((a, b) => a.localeCompare(b)) };
}

const ROLLBACK_CODES = ['HOST_PIN_RESTORE_FAILED', 'PRINCIPAL_ROUTES_UNVERIFIED', 'PRINCIPAL_CHOICES_CHANGED'];

async function movePrincipal({ targetModel, expectedModel, principal, requestId, afterVerified = null }) {
  const outcome = await runRuntimeMutation({ principal, requestId, scope: 'principal-model:select' }, async ({ signal, assertActive }) => {
    const current = await getPrincipalModel();
    if (current.model !== expectedModel) return { error: refusal('Principal model changed; reload and retry', 'HOST_PIN_CONFLICT') };
    const preference = await hostPrefs.getByHost(current.hostUrl);
    // A Benchmark workload on the host, even one that only shares it to judge
    // with the pinned model, keeps the pin until the workload ends.
    if (hasActiveSessionHold(preference) || hostPrefs.hasActiveBenchmarkClaim(preference)
      || await hostHeldByWorkload(current.hostUrl)) {
      return { error: refusal('The principal host has an active session or workload; retry when it finishes', 'PRINCIPAL_HOST_BUSY') };
    }
    if (require('./runtimeTopologyParking').isParkedHost(current.hostUrl)) {
      return { error: refusal('The principal host is parked: its topology mode is not running. Switch the topology first.', 'PRINCIPAL_HOST_PARKED') };
    }
    const configs = routerConfig.getEffectiveTaskModels();
    if (current.divergentRoutes.length) {
      return { error: refusal(`Routes on the principal host name an unpinned model: ${current.divergentRoutes.join(', ')}`, 'PRINCIPAL_ROUTES_DIVERGE') };
    }
    const routes = followedRoutes(configs, current);
    if (!routes.some(([task]) => task === 'daily_operator')) return { error: refusal('The principal route has a dedicated override') };
    // Routes without a stored route already follow the pin; storing one for
    // them would freeze a model name the next switch must rewrite.
    const pinFollowers = new Set(routerConfig.getHostPinFollowers());
    const stored = routes.filter(([task]) => !pinFollowers.has(task));
    const documents = await RouterTaskConfig.find({ taskType: { $in: stored.map(([task]) => task) } }).lean();
    try {
      const updated = await replacePrimaryPin(current.hostUrl, expectedModel, targetModel);
      if (!updated) return { error: refusal('Principal host preference is missing') };
    } catch (error) {
      if (['HOST_PIN_CONFLICT', 'HOST_PIN_INVALID', 'HOST_PIN_CAPACITY'].includes(error.code)) return { error };
      throw error; // Uncertain persistence retains native quarantine.
    }
    const restore = () => hostPrefs.restorePinnedModels(current.hostUrl, { signal, assertAuthorityActive: assertActive });
    try {
      const resident = await restore();
      if (resident?.verified !== true) throw refusal(resident?.error || 'Principal model residency was not verified', 'HOST_PIN_RESTORE_FAILED');
      // Persistence failure is ambiguous: keep the native fence for recovery.
      if (stored.length) {
        await RouterTaskConfig.bulkWrite(stored.map(([taskType, entry]) => ({
          updateOne: { filter: { taskType }, update: { $set: { model: targetModel, host: entry.host } }, upsert: true }
        })));
      }
      await routerConfig.refreshPinCacheNow();
      await routerConfig.ensureTaskModelOverridesLoaded({ force: true });
      invalidateRoutingSnapshots();
      const verified = routerConfig.getEffectiveTaskModels();
      if (routes.some(([task]) => verified[task]?.model !== targetModel)) throw refusal('Principal routes could not be verified', 'PRINCIPAL_ROUTES_UNVERIFIED');
      if (afterVerified) await afterVerified();
      return { ...await getPrincipalModel(), verification: resident.verification || { verified: true } };
    } catch (error) {
      assertActive();
      if (signal.aborted || !ROLLBACK_CODES.includes(error.code)) throw error;
      // Only known terminal failures can roll back under the same authority.
      const previous = new Map(documents.map(doc => [doc.taskType, doc]));
      if (stored.length) {
        await RouterTaskConfig.bulkWrite(stored.map(([taskType]) => previous.has(taskType)
          ? { replaceOne: { filter: { taskType }, replacement: previous.get(taskType), upsert: true } }
          : { deleteOne: { filter: { taskType } } }));
      }
      await replacePrimaryPin(current.hostUrl, targetModel, expectedModel);
      const rollback = await restore();
      await routerConfig.refreshPinCacheNow();
      await routerConfig.ensureTaskModelOverridesLoaded({ force: true });
      invalidateRoutingSnapshots();
      if (rollback?.verified !== true) throw error;
      error.rollback = 'verified';
      error.message += '; previous principal model restored';
      return { error };
    }
  });
  if (outcome.error) throw outcome.error;
  return outcome;
}

module.exports = { PRINCIPAL_MODEL_ALIAS, getPrincipalModel, selectPrincipalModel, saveChoice, listPrincipalHostModels,
  resolvePrincipalAlias, followedRoutes, divergentRoutes };
