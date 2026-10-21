// In-memory stand-in for the Mongo embedding profile document, with the same
// compare-and-set rules.
function memoryProfileRepository() {
  let doc = null;
  const copy = (value) => (value ? JSON.parse(JSON.stringify(value)) : null);
  return {
    get doc() { return copy(doc); },
    async load(seed) {
      if (!doc) doc = { active: { ...seed }, previous: null, revision: 0, freeze: null, activatedAt: null, activatedBy: null };
      return copy(doc);
    },
    async freeze(expectedRevision, freeze, now) {
      if (doc.revision !== expectedRevision || (doc.freeze && Date.parse(doc.freeze.until) > now.getTime())) return null;
      doc.freeze = { buildId: freeze.buildId, since: freeze.since.toISOString(), until: freeze.until.toISOString() };
      return copy(doc);
    },
    async thaw(buildId) {
      if (doc.freeze?.buildId === buildId) doc.freeze = null;
    },
    async forgetPrevious(expectedRevision, collection) {
      if (doc.revision !== expectedRevision || doc.previous?.collection !== collection) return null;
      doc.previous = null;
      return copy(doc);
    },
    async swap(expectedRevision, next, { buildId, actor, now }) {
      if (doc.revision !== expectedRevision || doc.freeze?.buildId !== buildId) return null;
      doc = { ...doc, previous: doc.active, active: { ...next }, freeze: null, revision: doc.revision + 1, activatedAt: now.toISOString(), activatedBy: actor };
      return copy(doc);
    }
  };
}

module.exports = { memoryProfileRepository };
