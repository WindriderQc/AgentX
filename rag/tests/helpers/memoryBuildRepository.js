// In-memory stand-in for the embedding_builds collection.
function memoryBuildRepository() {
  const rows = new Map();
  const copy = (value) => (value ? JSON.parse(JSON.stringify(value)) : null);
  const inProgress = (row) => ['copying', 'finalizing'].includes(row.status);
  return {
    rows,
    get: async (id) => copy(rows.get(id)),
    latest: async () => copy([...rows.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]),
    findInProgress: async () => copy([...rows.values()].find(inProgress)),
    listInProgress: async () => [...rows.values()].filter(inProgress).map(copy),
    async create(doc) {
      if (!rows.has(doc._id)) rows.set(doc._id, copy(doc));
      return copy(rows.get(doc._id));
    },
    async update(id, fromStatuses, set) {
      const row = rows.get(id);
      if (!row || !fromStatuses.includes(row.status)) return null;
      Object.assign(row, copy(set));
      return copy(row);
    }
  };
}

module.exports = { memoryBuildRepository };
