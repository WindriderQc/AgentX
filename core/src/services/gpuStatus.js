'use strict';

/**
 * Compact, read-only GPU status for Nestor, from the Data hardware telemetry
 * Core already reads for the Nerve Center (`gpuTelemetryService`).
 *
 * Only a host Data calls fresh carries values. A stale or silent host is
 * returned with its state and the age of its last sample, and no numbers: an
 * old reading is never presented as the present.
 */

const { readLatest, projectHost } = require('./gpuTelemetryService');
const { ageLabel } = require('./storageIndex');

const MAX_HOSTS = 8;
const MAX_GPUS = 8;
const OCCUPANCY_TIMEOUT_MS = 3000;
const HOST_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENTS' });
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function label(value, max = 64) {
  return [...String(value || '')].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, max);
}

function shortAge(ms) {
  if (ms === null) return 'âge inconnu';
  return ms < 60000 ? `il y a ${Math.round(ms / 1000)} s` : `il y a ${ageLabel(ms)}`;
}

function gib(mib) {
  return (mib / 1024).toFixed(1).replace('.', ',');
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('arguments must be an object');
  const unknown = Object.keys(input).filter((key) => !['host', 'includeOccupancy'].includes(key));
  if (unknown.length) throw invalid(`unknown argument: ${unknown[0].slice(0, 40)}`);
  if (input.host !== undefined && (typeof input.host !== 'string' || !HOST_PATTERN.test(input.host))) {
    throw invalid('host must be 1-64 letters, digits, ., - or _');
  }
  if (input.includeOccupancy !== undefined && typeof input.includeOccupancy !== 'boolean') {
    throw invalid('includeOccupancy must be a boolean');
  }
  return { host: input.host ? input.host.toLowerCase() : '', includeOccupancy: input.includeOccupancy === true };
}

function projectStatusHost(dataHost) {
  const { telemetry, gpus } = projectHost(dataHost);
  const state = ['fresh', 'stale'].includes(telemetry.status) ? telemetry.status : 'no_data';
  return {
    host: label(dataHost.name || dataHost.hostId),
    hostId: label(dataHost.hostId),
    state,
    sampledAt: telemetry.sampledAt,
    ageMs: number(telemetry.ageMs),
    lastError: state === 'fresh' ? null : (telemetry.lastError ? label(telemetry.lastError, 160) : null),
    // projectHost returns GPUs for a fresh host only.
    gpus: gpus.slice(0, MAX_GPUS).map((gpu) => ({
      index: gpu.index,
      name: label(gpu.name, 80),
      utilizationPct: number(gpu.utilization),
      vramUsedMiB: gpu.vramTotal > 0 ? number(gpu.vramUsed) : null,
      vramTotalMiB: gpu.vramTotal > 0 ? number(gpu.vramTotal) : null,
      temperatureC: number(gpu.temperature),
      powerW: number(gpu.powerDraw),
      powerLimitW: number(gpu.powerLimit)
    })),
    gpusTruncated: gpus.length > MAX_GPUS
  };
}

function hostSentence(host) {
  if (host.state === 'stale') return `${host.host} : données périmées (dernier échantillon ${shortAge(host.ageMs)}), aucune valeur actuelle`;
  if (host.state === 'no_data') return `${host.host} : aucune donnée, état actuel inconnu`;
  if (!host.gpus.length) return `${host.host} : à jour (${shortAge(host.ageMs)}), aucun GPU rapporté`;
  const busiest = Math.max(...host.gpus.map((gpu) => gpu.utilizationPct ?? 0));
  const measured = host.gpus.filter((gpu) => gpu.vramTotalMiB !== null);
  const vram = measured.length
    ? `, VRAM ${gib(measured.reduce((sum, gpu) => sum + gpu.vramUsedMiB, 0))}/${gib(measured.reduce((sum, gpu) => sum + gpu.vramTotalMiB, 0))} Go`
    : '';
  return `${host.host} : ${host.gpus.length} GPU, utilisation max ${busiest} %${vram} (${shortAge(host.ageMs)})`;
}

function projectOccupancy(body, wanted) {
  const hosts = Array.isArray(body?.hosts) ? body.hosts : [];
  return {
    available: true,
    windowHours: number(body?.windowMs) ? Math.round(body.windowMs / 3600000) : null,
    busyAtPct: number(body?.busyAtPct),
    hosts: hosts.filter((host) => wanted.has(String(host.hostId))).slice(0, MAX_HOSTS).map((host) => ({
      host: label(host.name || host.hostId),
      hostId: label(host.hostId),
      gpus: (Array.isArray(host.gpus) ? host.gpus : []).slice(0, MAX_GPUS).map((gpu) => ({
        index: gpu.index ?? null,
        name: label(gpu.name, 80),
        busyShare: number(gpu.busy?.share),
        // Share of the window with samples: a low value means the busy share is partial.
        coverage: number(gpu.coverage)
      }))
    }))
  };
}

function projectGpuStatus({ dataHosts, host = '', occupancy = null }) {
  const all = (Array.isArray(dataHosts) ? dataHosts : []).filter((item) => item && item.hostId);
  const selected = host
    ? all.filter((item) => String(item.hostId).toLowerCase() === host || String(item.name || '').toLowerCase() === host)
    : all;
  const hosts = selected.slice(0, MAX_HOSTS).map(projectStatusHost);
  const knownHosts = all.slice(0, MAX_HOSTS).map((item) => label(item.name || item.hostId));
  const summary = hosts.length ? `${hosts.map(hostSentence).join(' ; ')}.`
    : host ? `Aucun hôte de ce nom dans la télémétrie GPU. Hôtes connus : ${knownHosts.join(', ') || 'aucun'}.`
      : 'Aucun hôte GPU connu de la télémétrie.';
  return {
    summary,
    counts: {
      hosts: hosts.length,
      fresh: hosts.filter((item) => item.state === 'fresh').length,
      stale: hosts.filter((item) => item.state === 'stale').length,
      noData: hosts.filter((item) => item.state === 'no_data').length
    },
    truncated: selected.length > MAX_HOSTS,
    knownHosts,
    hosts,
    ...(occupancy ? { occupancy } : {})
  };
}

async function readGpuStatus(input = {}, deps = {}) {
  const { host, includeOccupancy } = validate(input);
  const fetchData = deps.fetchData || require('./dataServiceClient').fetchData;
  const latest = await readLatest(fetchData);
  if (!latest.ok) {
    throw Object.assign(new Error(`Data GPU telemetry is unavailable: ${String(latest.error || 'no answer').slice(0, 160)}`), { code: 'DATA_UNAVAILABLE' });
  }
  const first = projectGpuStatus({ dataHosts: latest.hosts, host });
  if (!includeOccupancy || !first.hosts.length) return first;
  // The 24-hour busy share is an extra: when it fails, the status still answers and says so.
  let occupancy;
  try {
    const { response, body } = await fetchData('/api/v1/hardware/occupancy', { timeoutMs: OCCUPANCY_TIMEOUT_MS });
    if (!response.ok || !body?.data) throw new Error('unavailable');
    occupancy = projectOccupancy(body.data, new Set(first.hosts.map((item) => item.hostId)));
  } catch {
    occupancy = { available: false };
  }
  return { ...first, occupancy };
}

module.exports = { MAX_HOSTS, MAX_GPUS, projectGpuStatus, projectOccupancy, readGpuStatus };
