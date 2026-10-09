'use strict';

/**
 * Projected VRAM overflows for Cluster Schedule.
 *
 * Overlapping slots are a conflict only when the distinct models they need,
 * plus the host's resident (continuous) models, provably exceed the host's
 * configured VRAM. A model shared by concurrent jobs loads once. Missing
 * capacity or model sizes never create a conflict: the known sizes must
 * already exceed capacity on their own.
 */

function toMillis(value) {
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isResident(task) {
  return (task.slots || []).some(slot => slot?.continuous);
}

function taskSummary(task, resident) {
  return {
    id: task.id,
    name: task.name,
    taskType: task.taskType,
    model: task.model,
    vramMb: positiveNumber(task.vramMb),
    resident
  };
}

// Sum one footprint per distinct model; a model with no declared size counts
// as unknown rather than zero.
function modelDemand(tasks) {
  const byModel = new Map();
  for (const task of tasks) {
    const size = positiveNumber(task.vramMb);
    const known = byModel.has(task.model) ? byModel.get(task.model) : null;
    byModel.set(task.model, size === null ? known : Math.max(known ?? 0, size));
  }
  let requiredVramMb = 0;
  const unknownModels = [];
  for (const [model, size] of byModel) {
    if (size === null) unknownModels.push(model);
    else requiredVramMb += size;
  }
  return { requiredVramMb, unknownModels };
}

function hostOverflows(host) {
  const capacityVramMb = positiveNumber(host.vramCapacityMb);
  if (!capacityVramMb) return [];

  const modelTasks = (host.tasks || []).filter(task => task.model);
  const residents = modelTasks.filter(isResident);
  const intervals = [];
  for (const task of modelTasks.filter(task => !isResident(task))) {
    for (const slot of (task.slots || [])) {
      const start = toMillis(slot?.start);
      const end = toMillis(slot?.end);
      if (start !== null && end !== null && end > start) intervals.push({ start, end, task });
    }
  }

  const boundaries = [...new Set(intervals.flatMap(i => [i.start, i.end]))].sort((a, b) => a - b);
  const overflows = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const active = intervals.filter(i => i.start < end && i.end > start).map(i => i.task);
    if (!active.length) continue;
    const { requiredVramMb, unknownModels } = modelDemand([...residents, ...active]);
    if (requiredVramMb <= capacityVramMb) continue;

    const key = active.map(task => String(task.id)).sort().join('|');
    const previous = overflows[overflows.length - 1];
    if (previous && previous.key === key && previous.end === start) {
      previous.end = end;
      previous.requiredVramMb = Math.max(previous.requiredVramMb, requiredVramMb);
      continue;
    }
    overflows.push({
      key,
      hostId: host.hostId,
      hostName: host.hostName,
      start,
      end,
      capacityVramMb,
      requiredVramMb,
      unknownVramModels: unknownModels,
      tasks: [
        ...residents.map(task => taskSummary(task, true)),
        ...[...new Set(active)].map(task => taskSummary(task, false))
      ]
    });
  }

  return overflows.map(({ key, start, end, ...overflow }) => ({
    ...overflow,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString()
  }));
}

function detectVramOverflows(hosts) {
  return (hosts || [])
    .filter(host => host.hostId !== 'unassigned')
    .flatMap(hostOverflows);
}

module.exports = { detectVramOverflows };
