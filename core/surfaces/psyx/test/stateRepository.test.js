'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATE_LIMITS,
  createStateRepository
} = require('../../../src/domains/psyx/stateRepository');

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
        const match = path.match(/^experiments\.\$\[experiment\]\.(.+)$/);
        if (match) {
          const id = options.arrayFilters?.[0]?.['experiment.id'];
          const item = doc.experiments?.find((entry) => entry.id === id);
          if (item) item[match[1]] = clone(value);
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

test('state infrastructure merges duplicate legacy documents before creating the unique user index', async () => {
  const harness = createHarness([
    { _id: 'new', userId: 'default', revision: 4, updatedAt: '2026-08-15T10:00:00Z', notes: ['new note'], patterns: ['same'] },
    { _id: 'old', userId: 'default', revision: 2, updatedAt: '2026-08-14T10:00:00Z', notes: ['old note'], patterns: ['same'], hypotheses: ['maybe'] }
  ]);
  await harness.repository.ensureInfrastructure();
  assert.equal(harness.collection.documents.length, 1);
  assert.deepEqual(harness.collection.documents[0].notes.map((item) => item.text), ['old note', 'new note']);
  assert.deepEqual(harness.collection.documents[0].patterns.map((item) => item.text), ['same']);
  assert.equal(harness.collection.documents[0].revision, 4);
  assert.equal(harness.collection.indexes[0].options.unique, true);
});

test('atomic item mutations remain bounded, deduplicate concurrent adds, and increment revision only on change', async () => {
  const harness = createHarness();
  await harness.repository.ensureInfrastructure();
  await Promise.all(Array.from({ length: 25 }, (_, index) => harness.repository.addItem('default', 'patterns', { text: `pattern ${index}` })));
  const afterParallel = await harness.repository.read('default');
  assert.equal(afterParallel.patterns.length, 25);
  assert.equal(afterParallel.revision, 25);

  const duplicates = await Promise.all(Array.from({ length: 8 }, () => harness.repository.addItem('default', 'patterns', { text: 'same concurrent pattern' })));
  assert.equal(duplicates.filter((result) => result.duplicate === false).length, 1);
  const afterDuplicate = await harness.repository.read('default');
  assert.equal(afterDuplicate.patterns.filter((item) => item.text === 'same concurrent pattern').length, 1);
  assert.equal(afterDuplicate.revision, 26);

  for (let index = 0; index < 130; index += 1) await harness.repository.addItem('default', 'notes', { text: `note ${index}` });
  const bounded = await harness.repository.read('default');
  assert.equal(bounded.notes.length, STATE_LIMITS.notes);
  assert.equal(bounded.notes[0].text, 'note 30');

  const revisionBeforeMissingDelete = bounded.revision;
  const missing = await harness.repository.deleteItem('default', 'notes', 'missing');
  assert.equal(missing.removed, false);
  assert.equal(missing.state.revision, revisionBeforeMissingDelete);
  const removed = await harness.repository.deleteItem('default', 'notes', bounded.notes[0].id);
  assert.equal(removed.removed, true);
  assert.equal(removed.state.revision, revisionBeforeMissingDelete + 1);
});

test('experiments validate mutations, deduplicate, and reset only the PsyX longitudinal document', async () => {
  const harness = createHarness();
  await harness.repository.ensureInfrastructure();
  const first = await harness.repository.addExperiment('default', { hypothesis: 'Sleep matters', action: 'Lights out at 10' });
  const duplicate = await harness.repository.addExperiment('default', { hypothesis: 'Sleep matters', action: 'Lights out at 10' });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.revision, 1);

  await assert.rejects(
    harness.repository.updateExperiment('default', first.item.id, { status: 'invented' }),
    /Invalid experiment status/
  );
  const missing = await harness.repository.updateExperiment('default', 'missing', { result: 'no-op' });
  assert.equal(missing.updated, false);
  assert.equal(missing.state.revision, 1);
  const updated = await harness.repository.updateExperiment('default', first.item.id, { status: 'active', result: 'Started' });
  assert.equal(updated.updated, true);
  assert.equal(updated.state.revision, 2);
  const unchanged = await harness.repository.updateExperiment('default', first.item.id, { status: 'active', result: 'Started' });
  assert.equal(unchanged.updated, false);
  assert.equal(unchanged.state.revision, 2);

  await harness.repository.addItem('default', 'openLoops', { text: 'Follow up' });
  const reset = await harness.repository.reset('default');
  for (const key of ['activeThreads', 'notes', 'patterns', 'hypotheses', 'openLoops', 'experiments']) {
    assert.deepEqual(reset[key], []);
  }
  assert.equal(reset.version, 2);
  assert.equal(reset.revision, 4);
});

test('background review proposals wait for the user, then enter memory as PsyX items or stay rejected', async () => {
  const { readReview } = require('../../../src/domains/psyx/review');
  const { stateForPrompt } = require('../../../src/domains/psyx/stateRepository');
  const harness = createHarness();
  await harness.repository.ensureInfrastructure();
  await harness.repository.addItem('default', 'patterns', { text: 'Already known pattern' });

  const raw = JSON.stringify({
    digest: { summary: 'Talked about the evening conflict.', themes: ['conflict'], commitment: 'Pause before replying' },
    proposals: [
      { kind: 'patterns', text: 'Already known pattern', evidence: ['quote'] },
      { kind: 'hypotheses', text: 'Fatigue lowers tolerance', evidence: ['I was exhausted'], confidence: 0.6 },
      { kind: 'openLoops', text: 'No evidence given' },
      { kind: 'experiments', hypothesis: 'A pause helps', action: 'Wait ten seconds', evidence: ['I snapped'] },
      { kind: 'invented', text: 'Ignored', evidence: ['x'] }
    ]
  });
  const review = readReview(`Here you go: ${raw}`, { conversationId: 'c1' });
  assert.equal(review.proposals.length, 3);
  const recorded = await harness.repository.recordReview('default', { conversationId: 'c1', ...review });
  assert.equal(recorded.added, 2);
  assert.deepEqual(recorded.state.proposals.map((item) => item.kind), ['hypotheses', 'experiments']);
  assert.equal(recorded.state.patterns.length, 1);

  // A later review of the same conversation replaces its digest and skips pending duplicates.
  const again = await harness.repository.recordReview('default', {
    conversationId: 'c1', ...readReview(raw.replace('evening conflict', 'evening conflict again'), { conversationId: 'c1' })
  });
  assert.equal(again.added, 0);
  assert.equal(again.state.sessionDigests.length, 1);
  assert.match(again.state.sessionDigests[0].summary, /again/);

  const [hypothesis, experiment] = again.state.proposals;
  const accepted = await harness.repository.acceptProposal('default', hypothesis.id, { text: 'Fatigue lowers my tolerance' });
  assert.equal(accepted.state.hypotheses[0].text, 'Fatigue lowers my tolerance');
  assert.equal(accepted.state.hypotheses[0].source, 'psyx');
  assert.equal(accepted.state.hypotheses[0].status, 'working');
  assert.deepEqual(accepted.state.hypotheses[0].evidence, ['I was exhausted']);
  await assert.rejects(harness.repository.acceptProposal('default', hypothesis.id), /proposal not found/);

  const rejected = await harness.repository.rejectProposal('default', experiment.id);
  assert.deepEqual(rejected.state.proposals, []);
  const proposedAgain = await harness.repository.recordReview('default', {
    conversationId: 'c2', ...readReview(raw, { conversationId: 'c2', settled: rejected.state.settledProposals })
  });
  assert.equal(proposedAgain.added, 0, 'rejected and accepted proposals are not proposed again');

  const prompt = stateForPrompt(proposedAgain.state, { conversationId: 'c2' });
  assert.deepEqual(prompt.recentSessions.map((item) => item.summary), ['Talked about the evening conflict again.']);
  assert.equal('proposals' in prompt, false, 'pending proposals never reach the conversation prompt');

  const reset = await harness.repository.reset('default');
  for (const key of ['proposals', 'settledProposals', 'sessionDigests']) assert.deepEqual(reset[key], []);
});

test('a stored item without confidence stays unknown instead of reading as zero', () => {
  const { normalizeStateItem } = require('../../../src/domains/psyx/stateRepository');
  assert.equal(normalizeStateItem({ text: 'note', confidence: null }, 'notes').confidence, null);
  assert.equal(normalizeStateItem({ text: 'note', confidence: 0 }, 'notes').confidence, 0);
});
