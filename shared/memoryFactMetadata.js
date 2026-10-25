'use strict';

// Fact time belongs to the source. Recording time belongs to the store. In
// particular a missing validFrom must never be filled from an ingestion date.
function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_MEMORY_FACT_METADATA', statusCode: 400 });
}

function isoInstant(value, field) {
  if (typeof value !== 'string' || value.length > 40
      || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))
      || !new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(value.slice(0, 10))) {
    throw invalid(`${field} must be an ISO instant with a timezone, or null`);
  }
  return new Date(value).toISOString();
}

function memoryFactInput(input = {}) {
  const result = {};
  if (Object.hasOwn(input, 'validFrom') && input.validFrom !== undefined) {
    const value = input.validFrom;
    result.validFrom = value == null ? null : isoInstant(value, 'validFrom');
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

// When a fact stopped holding, and which record replaced it, are named only by
// an explicit correction or replacement. Ordinary fact metadata never sets them.
function memoryValidityInput(input = {}) {
  const result = {};
  if (Object.hasOwn(input, 'invalidatedAt') && input.invalidatedAt !== undefined) {
    result.invalidatedAt = input.invalidatedAt == null ? null : isoInstant(input.invalidatedAt, 'invalidatedAt');
  }
  if (Object.hasOwn(input, 'supersededBy') && input.supersededBy !== undefined) {
    const value = input.supersededBy;
    if (value != null && (typeof value !== 'string' || !value.trim() || value.length > 300
        || /[\x00-\x1f\x7f]/.test(value))) {
      throw invalid('supersededBy must name a bounded record id, or be null');
    }
    result.supersededBy = value ?? null;
  }
  return result;
}

function memoryValidityProjection(row = {}) {
  return {
    invalidatedAt: row.invalidatedAt ? new Date(row.invalidatedAt).toISOString() : null,
    supersededBy: row.supersededBy || null,
  };
}

// Unknown stays current; a scheduled invalidation takes effect at its instant.
function isCurrentFact(row = {}, now = new Date()) {
  return !row.invalidatedAt || new Date(row.invalidatedAt) > now;
}

// Stored validity survives an unrelated rewrite; only an explicit value changes it.
function mergeMemoryValidity(input, stored = {}, { recordId, validFrom } = {}) {
  const clean = memoryValidityInput(input);
  const previous = memoryValidityProjection(stored);
  const merged = {
    invalidatedAt: Object.hasOwn(clean, 'invalidatedAt') ? clean.invalidatedAt : previous.invalidatedAt,
    supersededBy: Object.hasOwn(clean, 'supersededBy') ? clean.supersededBy : previous.supersededBy,
  };
  if (merged.supersededBy && !merged.invalidatedAt) throw invalid('A successor link requires invalidatedAt');
  if (merged.supersededBy && recordId != null && merged.supersededBy === String(recordId)) {
    throw invalid('A record cannot replace itself');
  }
  if (merged.invalidatedAt && validFrom && new Date(merged.invalidatedAt) < new Date(validFrom)) {
    throw invalid('invalidatedAt cannot precede validFrom');
  }
  return merged;
}

module.exports = {
  memoryFactInput, memoryFactProjection, mergeMemoryFactMetadata,
  memoryValidityInput, memoryValidityProjection, isCurrentFact, mergeMemoryValidity,
};
