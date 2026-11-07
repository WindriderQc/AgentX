'use strict';

const { createStateRepository } = require('../../../../src/domains/psyx/stateRepository');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function valueAt(doc, path) {
  const parts = path.split('.');
  let current = doc;
  for (const part of parts) {
    if (Array.isArray(current)) return current.map((item) => item?.[part]);
    current = current?.[part];
  }
  return current;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([path, expected]) => {
    if (path === '$or') return expected.some((clause) => matches(doc, clause));
    const actual = valueAt(doc, path);
    if (expected && typeof expected === 'object' && '$elemMatch' in expected) {
      return Array.isArray(actual) && actual.some((item) => matches(item, expected.$elemMatch));
    }
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return Array.isArray(actual)
        ? !actual.flat(Infinity).some((value) => String(value) === String(expected.$ne))
        : String(actual) !== String(expected.$ne);
    }
    if (Array.isArray(actual)) return actual.flat(Infinity).some((value) => String(value) === String(expected));
    return String(actual) === String(expected);
  });
}

class MemoryCursor {
  constructor(documents) {
    this.documents = documents;
    this.max = null;
  }

  sort(spec) {
    const [[key, direction]] = Object.entries(spec);
    this.documents.sort((left, right) => {
      const a = new Date(left[key] || 0).getTime();
      const b = new Date(right[key] || 0).getTime();
      return direction < 0 ? b - a : a - b;
    });
    return this;
  }

  limit(value) { this.max = value; return this; }
  project() { return this; }
  async toArray() { return clone(this.max ? this.documents.slice(0, this.max) : this.documents); }
}

class MemoryCollection {
  constructor(documents = []) {
    this.documents = clone(documents);
    this.nextId = 1000;
    this.indexes = [];
  }

  find(filter = {}) {
    return new MemoryCursor(this.documents.filter((doc) => matches(doc, filter)));
  }

  async findOne(filter = {}) {
    return clone(this.documents.find((doc) => matches(doc, filter)) || null);
  }

  async createIndex(keys, options) {
    this.indexes.push({ keys, options });
    if (options?.unique) {
      const seen = new Set();
      for (const doc of this.documents) {
        const value = doc[Object.keys(keys)[0]];
        if (seen.has(value)) throw new Error('duplicate key');
        seen.add(value);
      }
    }
    return options?.name || 'index';
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((doc) => matches(doc, filter));
    if (index < 0) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    return { deletedCount: 1 };
  }

  async updateOne(filter, update, options = {}) {
    let index = this.documents.findIndex((doc) => matches(doc, filter));
    let inserted = false;
    if (index < 0 && options.upsert) {
      const seed = {};
      for (const [key, value] of Object.entries(filter)) {
        if (!key.includes('.') && (typeof value !== 'object' || value === null)) seed[key] = value;
      }
      seed._id = `memory-${this.nextId++}`;
      this.documents.push(seed);
      index = this.documents.length - 1;
      inserted = true;
    }
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 };

    const doc = this.documents[index];
    const before = JSON.stringify(doc);
    if (inserted && update.$setOnInsert) Object.assign(doc, clone(update.$setOnInsert));
    if (update.$set) {
      for (const [path, value] of Object.entries(update.$set)) {
        const match = path.match(/^(\w+)\.\$\[(\w+)\]\.(.+)$/);
        if (match) {
          const id = options.arrayFilters?.[0]?.[`${match[2]}.id`];
          const item = doc[match[1]]?.find((entry) => entry.id === id);
          if (item) item[match[3]] = clone(value);
        } else {
          doc[path] = clone(value);
        }
      }
    }
    if (update.$push) {
      for (const [key, specification] of Object.entries(update.$push)) {
        if (!Array.isArray(doc[key])) doc[key] = [];
        if (specification && Array.isArray(specification.$each)) {
          doc[key].push(...clone(specification.$each));
          if (Number.isInteger(specification.$slice) && specification.$slice < 0) {
            doc[key] = doc[key].slice(specification.$slice);
          }
        } else {
          doc[key].push(clone(specification));
        }
      }
    }
    if (update.$pull) {
      for (const [key, condition] of Object.entries(update.$pull)) {
        doc[key] = (doc[key] || []).filter((entry) => !matches(entry, condition));
      }
    }
    if (update.$inc) {
      for (const [key, value] of Object.entries(update.$inc)) doc[key] = Number(doc[key] || 0) + value;
    }
    return {
      matchedCount: 1,
      modifiedCount: before === JSON.stringify(doc) ? 0 : 1,
      upsertedCount: inserted ? 1 : 0
    };
  }
}

function createHarness(documents = []) {
  const collection = new MemoryCollection(documents);
  return { collection, repository: createStateRepository({ collection, logger: null }) };
}

module.exports = { MemoryCollection, createHarness };
