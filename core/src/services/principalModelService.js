'use strict';

// Principal choice is the existing first host pin and the existing task routes.
// No parallel preference store: normal restoration and routing remain owners.
const routerConfig = require('./modelRouterConfig');
const hostPrefs = require('./hostPreferenceService');
const { replacePrimaryPin } = require('./hostPinService');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const { runRuntimeMutation } = require('./runtimeMutationLeaseService');
const { hasActiveSessionHold } = require('./hostSessionHoldService');
const { invalidateRoutingSnapshots } = require('./routing/routingSnapshotCache');
const { PRODUCT_PERMISSIVE_MODEL } = require('./modelRouterDefaults');
const { modelsMatch } = require('../helpers/modelNameNormalization');

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
  const options = [
    { value: 'standard', model: defaults?.model, label: 'Standard' },
    { value: 'abliterated', label: 'Abliterated', model: process.env.HOUSEHOLD_PERMISSIVE_PRIMARY_MODEL || PRODUCT_PERMISSIVE_MODEL }
  ];
  const selected = options.find(option => option.model === pins[0]?.model);
  const divergent = divergentRoutes(routerConfig.getEffectiveTaskModels(), { hostKey: defaults?.host, pinnedModels: pins });
  return { available: Boolean(selected && pins[0]?.contextSize > 0), divergentRoutes: divergent,
    selected: selected?.value || null, model: pins[0]?.model || null,
    contextSize: pins[0]?.contextSize || null, hostUrl, hostKey: defaults?.host,
    alias: PRINCIPAL_MODEL_ALIAS, options, pinnedModels: pins, status: pref?.status || 'unconfigured' };
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
  if (!initial.available) throw refusal('Configure the principal pin and its context first');
  if (!expectedModel || expectedModel !== initial.model) throw refusal('Principal model changed; reload and retry', 'HOST_PIN_CONFLICT');
  if (choice.model === initial.model) return initial;
  const outcome = await runRuntimeMutation({ principal, requestId, scope: 'principal-model:select' }, async ({ signal, assertActive }) => {
    const current = await getPrincipalModel();
    if (current.model !== expectedModel) return { error: refusal('Principal model changed; reload and retry', 'HOST_PIN_CONFLICT') };
    const preference = await hostPrefs.getByHost(current.hostUrl);
    if (hasActiveSessionHold(preference) || hostPrefs.hasActiveBenchmarkClaim(preference)) {
      return { error: refusal('The principal host has an active session or workload; retry when it finishes', 'PRINCIPAL_HOST_BUSY') };
    }
    const configs = routerConfig.getEffectiveTaskModels();
    if (current.divergentRoutes.length) {
      return { error: refusal(`Routes on the principal host name an unpinned model: ${current.divergentRoutes.join(', ')}`, 'PRINCIPAL_ROUTES_DIVERGE') };
    }
    const routes = followedRoutes(configs, current);
    if (!routes.some(([task]) => task === 'daily_operator')) return { error: refusal('The principal route has a dedicated override') };
    const documents = await RouterTaskConfig.find({ taskType: { $in: routes.map(([task]) => task) } }).lean();
    try {
      const updated = await replacePrimaryPin(current.hostUrl, expectedModel, choice.model);
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
      await RouterTaskConfig.bulkWrite(routes.map(([taskType, entry]) => ({
        updateOne: { filter: { taskType }, update: { $set: { model: choice.model, host: entry.host } }, upsert: true }
      })));
      await routerConfig.ensureTaskModelOverridesLoaded({ force: true });
      invalidateRoutingSnapshots();
      const verified = routerConfig.getEffectiveTaskModels();
      if (routes.some(([task]) => verified[task]?.model !== choice.model)) throw refusal('Principal routes could not be verified', 'PRINCIPAL_ROUTES_UNVERIFIED');
      return { ...await getPrincipalModel(), verification: resident.verification || { verified: true } };
    } catch (error) {
      assertActive();
      if (signal.aborted || !['HOST_PIN_RESTORE_FAILED', 'PRINCIPAL_ROUTES_UNVERIFIED'].includes(error.code)) throw error;
      // Only known terminal failures can roll back under the same authority.
      const previous = new Map(documents.map(doc => [doc.taskType, doc]));
      await RouterTaskConfig.bulkWrite(routes.map(([taskType]) => previous.has(taskType)
        ? { replaceOne: { filter: { taskType }, replacement: previous.get(taskType), upsert: true } }
        : { deleteOne: { filter: { taskType } } }));
      await replacePrimaryPin(current.hostUrl, choice.model, expectedModel);
      const rollback = await restore();
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

module.exports = { PRINCIPAL_MODEL_ALIAS, getPrincipalModel, selectPrincipalModel, resolvePrincipalAlias, followedRoutes, divergentRoutes };
