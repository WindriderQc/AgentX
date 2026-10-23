'use strict';

// Fact time belongs to the source. Recording time belongs to the store. In
// particular a missing validFrom must never be filled from an ingestion date.
function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_MEMORY_FACT_METADATA', statusCode: 400 });
}

function memoryFactInput(input = {}) {
  const result = {};
  if (Object.hasOwn(input, 'validFrom') && input.validFrom !== undefined) {
    const value = input.validFrom;
    if (value == null) result.validFrom = null;
    else {
      if (typeof value !== 'string' || value.length > 40
          || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
          || !Number.isFinite(Date.parse(value))
          || !new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(value.slice(0, 10))) {
        throw invalid('validFrom must be an ISO instant with a timezone, or null');
      }
      result.validFrom = new Date(value).toISOString();
    }
  }
  if (Object.hasOwn(input, 'sourceRefs') && input.sourceRefs !== undefined) {
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 20) throw invalid('sourceRefs must contain at most 20 references');
    result.sourceRefs = input.sourceRefs.map(ref => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)
          || Object.keys(ref).some(key => !['system', 'id'].includes(key))
          || typeof ref.system !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(ref.system)
          || typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 200
          || /[\x00-\x1f\x7f]/.test(ref.id)) throw invalid('sourceRefs must name a bounded system and id');
      return { system: ref.system, id: ref.id };
    });
  }
  return result;
}

function memoryFactProjection(row = {}) {
  return {
    validFrom: row.validFrom || null,
    // Mongo already stores the original creation time. An edit's updatedAt
    // is not a new recording time and says nothing about when a fact held.
    recordedAt: Object.hasOwn(row, 'recordedAt') ? row.recordedAt || null : row.createdAt || null,
    sourceRefs: Array.from(row.sourceRefs || [], ref => ({ system: ref.system, id: ref.id })),
  };
}

function mergeMemoryFactMetadata(input, stored = {}) {
  const clean = memoryFactInput(input);
  const previous = memoryFactProjection(stored);
  const refs = new Map([...previous.sourceRefs, ...(clean.sourceRefs || [])]
    .map(ref => [JSON.stringify([ref.system, ref.id]), ref]));
  const validFrom = Object.hasOwn(clean, 'validFrom') ? clean.validFrom : previous.validFrom;
  return {
    validFrom: validFrom ? new Date(validFrom).toISOString() : null,
    sourceRefs: [...refs.values()].slice(-20),
  };
}

module.exports = { memoryFactInput, memoryFactProjection, mergeMemoryFactMetadata };
