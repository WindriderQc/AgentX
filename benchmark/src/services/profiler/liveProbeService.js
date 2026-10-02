'use strict';

const hostProfileService = require('./hostProfileService');
const { checkHost } = require('../hostTestService');
const { listRunning } = require('../../clients/ollamaClient');
const { getConfiguredHosts, normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../helpers/ollamaTargetAdmission');
const { readHostHardware } = require('./hardwareCollectorClient');
const { ADVANCED_METRICS, projectCollectorEvidence } = require('./hardwareTelemetryProjection');

function parseUrlHost(hostUrl) {
  try {
    return new URL(hostUrl).hostname.toLowerCase();
  } catch {
    const match = String(hostUrl || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return match ? match[1].toLowerCase() : '';
  }
}

function hostIdFromUrl(hostUrl) {
  const normalized = normalizeHostUrl(hostUrl);
  const host = parseUrlHost(normalized);
  let port = '11434';
  try { port = new URL(normalized).port || '11434'; } catch {}
  const slug = `${host}-${port}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `custom-${slug || 'ollama-host'}`;
}

function sameUrl(a, b) {
  const left = normalizeHostUrl(a || '');
  const right = normalizeHostUrl(b || '');
  return Boolean(left && right && left.replace(/\/+$/, '') === right.replace(/\/+$/, ''));
}

function summarizeTelemetry(ollamaPs, profile, hardware = null) {
  const models = Array.isArray(ollamaPs?.models) ? ollamaPs.models : [];
  const usedBytes = models.reduce((sum, model) => sum + Number(model.size_vram || 0), 0);
  const psObserved = ollamaPs?.ok === true;
  const evidence = projectCollectorEvidence(hardware);
  const observed = evidence.observed ? evidence.fields : null;
  const psUsedMiB = psObserved ? Math.round(usedBytes / (1024 * 1024)) : null;
  const usedMiB = observed?.vramUsedMiB ?? psUsedMiB;
  const configuredTotal = Number(profile?.gpu?.vramTotalMiB || 0);
  const totalMiB = observed?.vramTotalMiB ?? (configuredTotal > 0 ? configuredTotal : null);
  const source = psObserved ? 'ollama-ps' : observed ? 'nvidia-smi' : totalMiB != null ? 'static-profile' : 'none';
  const vramPressurePct = totalMiB && usedMiB != null
    ? Math.round((usedMiB / totalMiB) * 100)
    : null;

  const unknownMetrics = ADVANCED_METRICS.filter((metric) => evidence.metrics[metric].status === 'unknown');
  const partial = psObserved || totalMiB != null || evidence.observed;
  const capability = {
    contract: 'agentx.profiler-hardware-capability/v1',
    status: evidence.observed && unknownMetrics.length === 0 ? 'available' : partial ? 'partial' : 'unavailable',
    qualificationAuthority: 'none',
    collector: evidence.collector,
    metrics: {
      runtimeResidency: { status: psObserved ? 'observed' : 'unknown', source: psObserved ? 'ollama-ps' : 'none' },
      vramUsedMiB: observed?.vramUsedMiB != null
        ? { status: 'observed', source: 'nvidia-smi' }
        : { status: psObserved ? 'observed' : 'unknown', source: psObserved ? 'ollama-ps' : 'none' },
      vramTotalMiB: observed?.vramTotalMiB != null
        ? { status: 'observed', source: 'nvidia-smi' }
        : { status: totalMiB != null ? 'configured' : 'unknown', source: totalMiB != null ? 'host-profile' : 'none' },
      ...evidence.metrics
    },
    unknownMetrics
  };

  const diagnostics = evidence.observed
    ? { vramPressurePct, ...evidence.diagnostics }
    : {
      vramPressurePct,
      gpuUtilizationPct: null,
      gpuImbalancePct: null,
      pcieWarning: null,
      thermalWarning: null,
      powerWarning: null,
      notes: []
    };
  if (vramPressurePct != null && vramPressurePct >= 90) diagnostics.notes = [`VRAM pressure ${vramPressurePct}%`, ...diagnostics.notes];

  return {
    ok: source !== 'none',
    source,
    capability,
    gpuName: observed?.gpuName || profile?.gpu?.name || '',
    utilization: observed?.utilization ?? null,
    temperature: observed?.temperature ?? null,
    powerDrawW: observed?.powerDrawW ?? null,
    pcieGen: observed?.pcieGen ?? null,
    pcieGenMax: observed?.pcieGenMax ?? null,
    pcieWidth: observed?.pcieWidth ?? null,
    pcieWidthMax: observed?.pcieWidthMax ?? null,
    topology: null,
    gpuCount: observed?.gpuCount ?? null,
    gpus: observed?.gpus || [],
    diagnostics,
    vramUsedMiB: usedMiB,
    vramTotalMiB: totalMiB,
    runningModels: models.map((model) => ({
      name: model.name,
      sizeVramMiB: model.size_vram ? Math.round(model.size_vram / (1024 * 1024)) : null,
      sizeTotalMiB: model.size ? Math.round(model.size / (1024 * 1024)) : null
    })),
    error: ollamaPs?.ok === false ? ollamaPs.error || 'Ollama runtime telemetry unavailable' : null,
    actionRequired: capability.status !== 'available'
  };
}

async function detectOllamaHost({ hostUrl, displayName } = {}) {
  const normalized = await admitOllamaTargetResolved(hostUrl || '', {
    configuredHosts: getConfiguredHosts()
  });

  const check = await checkHost(normalized);
  if (!check.available) {
    const error = new Error(check.error || 'Ollama host is unreachable');
    error.statusCode = 503;
    error.data = { hostUrl: normalized, available: false, latency: check.latency || 0 };
    throw error;
  }

  const configured = getConfiguredHosts().find((host) => sameUrl(host.url, normalized));
  const existing = await hostProfileService.getByUrl(normalized);
  const hostId = existing?.hostId || configured?.id || hostIdFromUrl(normalized);
  const name = String(displayName || '').trim()
    || existing?.displayName
    || configured?.name
    || parseUrlHost(normalized)
    || 'Ollama host';

  const profile = await hostProfileService.upsertMetadata({
    hostId,
    hostUrl: normalized,
    displayName: name,
    gpu: { vramTotalMiB: configured?.vramMb || existing?.gpu?.vramTotalMiB || 0 },
    status: 'online',
    lastSeenAt: new Date(),
    modelCount: check.models.length
  });

  return {
    host: profile.toObject ? profile.toObject() : profile,
    detection: {
      available: true,
      latency: check.latency,
      modelCount: check.models.length,
      models: check.models
    }
  };
}

async function getLiveProbeStatus(hostId) {
  let hosts;
  if (hostId) {
    const host = await hostProfileService.getById(hostId);
    if (!host) {
      const error = new Error(`Host not found: ${hostId}`);
      error.statusCode = 404;
      throw error;
    }
    hosts = [host];
  } else {
    hosts = await hostProfileService.getAll();
  }

  const data = await Promise.all(hosts.map(async (host) => {
    const [checkResult, psResult, hardwareResult] = await Promise.allSettled([
      checkHost(host.hostUrl),
      listRunning(host.hostUrl, { timeoutMs: 4000 }),
      readHostHardware(host.hostUrl)
    ]);
    const check = checkResult.status === 'fulfilled'
      ? checkResult.value
      : { available: false, models: [], latency: 0, error: checkResult.reason?.message || 'Ollama check failed' };
    const ollamaPs = psResult.status === 'fulfilled'
      ? { ok: true, models: Array.isArray(psResult.value?.models) ? psResult.value.models : [] }
      : { ok: false, models: [], error: psResult.reason?.message || 'Ollama /api/ps failed' };

    return {
      hostId: host.hostId,
      displayName: host.displayName,
      hostUrl: host.hostUrl,
      status: check.available ? 'ready' : 'offline',
      checkedAt: new Date().toISOString(),
      ollama: {
        ok: Boolean(check.available),
        latency: check.latency || 0,
        modelCount: check.models?.length || 0,
        error: check.error || null
      },
      ollamaPs,
      telemetry: summarizeTelemetry(ollamaPs, host, hardwareResult.status === 'fulfilled' ? hardwareResult.value : null)
    };
  }));

  return hostId ? data[0] : { hosts: data, total: data.length };
}

module.exports = {
  detectOllamaHost,
  getLiveProbeStatus,
  hostIdFromUrl,
  _internal: { parseUrlHost, sameUrl, summarizeTelemetry }
};
