'use strict';

// Scheduled comparison of the three places that name what a pinned host loads
// (#829): the routes, the runtime export and the installed OpenClaw config.
// Each must agree with the HostPreference pin. Read-only: a disagreement is an
// alert for the operator, never a correction.

const fs = require('fs/promises');
const path = require('path');
const { buildRuntimeConfigExport, compareOpenClawConfig } = require('./runtime-config');
const { runSshJson } = require('./openclaw/agentInventory');

const METRIC = 'pin_drift';
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const FIRST_DELAY_MS = 2 * 60 * 1000;

function intervalMs(env = process.env) {
  const raw = env.PIN_DRIFT_CHECK_MS;
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

// Only provider endpoints, model ids/contexts and agent model references
// leave the host: credentials and the rest of openclaw.json stay there.
function projectOpenClawConfig(raw = {}) {
  const providers = {};
  for (const [id, provider] of Object.entries(raw?.models?.providers || {})) {
    if (!provider || typeof provider !== 'object') continue;
    providers[id] = {
      baseUrl: provider.baseUrl || provider.baseURL || provider.apiBase || provider.url || null,
      models: (Array.isArray(provider.models) ? provider.models : []).map(model => ({
        id: model?.id,
        contextWindow: model?.contextWindow,
        ...(model?.params?.num_ctx !== undefined && { params: { num_ctx: model.params.num_ctx } })
      }))
    };
  }
  const agents = raw?.agents && typeof raw.agents === 'object' ? raw.agents : {};
  const pickModel = model => (model && typeof model === 'object'
    ? { primary: model.primary, fallbacks: model.fallbacks } : model);
  const list = agents.entries && typeof agents.entries === 'object' && !Array.isArray(agents.entries)
    ? Object.entries(agents.entries).map(([id, agent]) => ({ id, model: pickModel(agent?.model) }))
    : (Array.isArray(agents.list) ? agents.list : []).map(agent => ({ id: agent?.id, model: pickModel(agent?.model) }));
  return { models: { providers }, agents: { defaults: { model: pickModel(agents.defaults?.model) }, list } };
}

function remoteProjectionCommand(openclawHome) {
  const home = `'${String(openclawHome).replace(/'/g, `'\\''`)}'`;
  return `AGENTX_OPENCLAW_HOME=${home} python3 - <<'PY'
import json, os, pathlib
raw = json.load((pathlib.Path(os.environ["AGENTX_OPENCLAW_HOME"]) / "openclaw.json").open("r", encoding="utf-8"))
def model(value):
    return {k: value[k] for k in ("primary", "fallbacks") if k in value} if isinstance(value, dict) else value
providers = {}
for pid, p in ((raw.get("models") or {}).get("providers") or {}).items():
    if not isinstance(p, dict):
        continue
    providers[pid] = {"baseUrl": p.get("baseUrl") or p.get("baseURL") or p.get("apiBase") or p.get("url"),
        "models": [dict({"id": m.get("id"), "contextWindow": m.get("contextWindow")},
            **({"params": {"num_ctx": m["params"]["num_ctx"]}} if isinstance(m.get("params"), dict) and "num_ctx" in m["params"] else {}))
            for m in p.get("models") or [] if isinstance(m, dict)]}
agents = raw.get("agents") if isinstance(raw.get("agents"), dict) else {}
entries = agents.get("entries")
items = [dict(v, id=k) for k, v in entries.items() if isinstance(v, dict)] if isinstance(entries, dict) else agents.get("list") or []
listed = [{"id": a.get("id"), "model": model(a.get("model"))} for a in items if isinstance(a, dict)]
print(json.dumps({"models": {"providers": providers}, "agents": {"defaults": {"model": model((agents.get("defaults") or {}).get("model"))}, "list": listed}}))
PY`;
}

/** The installed OpenClaw config, projected; null when no source is configured. */
async function readInstalledOpenClawConfig(env = process.env, deps = {}) {
  const target = env.OPENCLAW_INVENTORY_SSH_TARGET;
  if (target) {
    const home = env.OPENCLAW_INVENTORY_REMOTE_HOME || '/home/agentx/.openclaw';
    return (deps.runSshJson || runSshJson)(target, remoteProjectionCommand(home), {});
  }
  const file = env.OPENCLAW_CONFIG_PATH || (env.OPENCLAW_HOME && path.join(env.OPENCLAW_HOME, 'openclaw.json'));
  if (!file) return null;
  return projectOpenClawConfig(JSON.parse(await (deps.readFile || fs.readFile)(file, 'utf8')));
}

function unpinnedRoutes(snapshot) {
  return Object.values(snapshot?.tasks || {})
    .filter(task => task?.model && task.hostPreference?.pinnedModels?.length && task.pinAligned !== true)
    .map(task => ({ taskType: task.taskType, model: task.configuredModel || task.model, hostKey: task.hostKey,
      pinnedModels: task.hostPreference.pinnedModels.map(pin => pin.model) }));
}

async function checkPinDrift({ runtimeServices, readConfig = readInstalledOpenClawConfig, now = () => new Date() } = {}) {
  const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
  const routes = unpinnedRoutes(snapshot);
  const exported = await buildRuntimeConfigExport(runtimeServices, { includeCandidates: false });
  const lanes = Object.values(exported.lanes).filter(lane => lane.model && lane.hostPreference?.pinnedModels?.length
    && !lane.pinAligned).map(lane => ({ role: lane.role, model: lane.model, hostKey: lane.hostKey }));
  let openclaw;
  try {
    const installed = await readConfig();
    openclaw = installed ? compareOpenClawConfig(installed, exported.openclaw)
      : { status: 'not_checked', drift: [], reason: 'no OpenClaw config source is configured' };
  } catch (error) {
    openclaw = { status: 'not_checked', drift: [], reason: `installed OpenClaw config unreadable: ${error.message}` };
  }
  const findings = routes.length + lanes.length + (openclaw.drift?.length || 0);
  return {
    checkedAt: now().toISOString(),
    status: findings ? 'drift' : (openclaw.status === 'not_checked' ? 'partial' : 'ok'),
    unpinnedRoutes: routes,
    unpinnedExportLanes: lanes,
    openclaw: { status: openclaw.status, drift: openclaw.drift || [], ...(openclaw.reason && { reason: openclaw.reason }),
      ...(openclaw.agentModels && { degradedAgents: openclaw.agentModels.degraded }) }
  };
}

function summarize(result) {
  return [
    ...result.unpinnedRoutes.map(route => `route ${route.taskType} names ${route.model} on ${route.hostKey}`),
    ...result.unpinnedExportLanes.map(lane => `export lane ${lane.role} names ${lane.model}`),
    ...result.openclaw.drift.map(row => `OpenClaw ${row.path}`)
  ].slice(0, 8).join('; ');
}

function createPinDriftWatch({ runtimeServices, logger, alertService, env = process.env, check = checkPinDrift } = {}) {
  let last = null;
  let timer = null;
  let first = null;
  const run = async () => {
    try {
      last = await check({ runtimeServices });
    } catch (error) {
      last = { checkedAt: new Date().toISOString(), status: 'error', error: error.message };
    }
    if (last.status === 'drift') {
      const summary = summarize(last);
      logger?.warn?.('Host pin drift detected', { summary });
      await alertService?.evaluateEvent?.({ component: 'host-pin', metric: METRIC, value: 1, threshold: 0,
        source: 'pin-drift-check', additionalData: { summary } }).catch(() => {});
    }
    return last;
  };
  return {
    run,
    last: () => last,
    start() {
      const every = intervalMs(env);
      if (!every || timer || first) return false;
      first = setTimeout(() => { first = null; void run(); timer = setInterval(() => void run(), every); timer.unref?.(); },
        Math.min(FIRST_DELAY_MS, every));
      first.unref?.();
      return true;
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = timer = null;
    }
  };
}

module.exports = { METRIC, checkPinDrift, createPinDriftWatch, intervalMs, projectOpenClawConfig, readInstalledOpenClawConfig, remoteProjectionCommand, unpinnedRoutes };
