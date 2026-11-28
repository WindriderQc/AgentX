'use strict';

// Minimal store double for CPU fixtures. Real Core uses Mongo's unique _id and atomic update.
function memoryMongoose() {
  let row;
  function Schema() {}
  return { Schema, models: {}, model: () => ({
    findById() { return { lean: async () => row && { ...row } }; },
    findOneAndUpdate(query, update, options) {
      return { lean: async () => {
        const matches = (current, filter) => Object.entries(filter).every(([key, value]) => {
          if (key === '$or') return value.some(item => matches(current, item));
          if (value && typeof value === 'object') return Object.entries(value).every(([op, bound]) =>
            op === '$eq' ? current[key] === bound : op === '$ne' ? current[key] !== bound : op === '$lte' ? current[key] <= bound
              : op === '$gte' ? current[key] >= bound : op === '$gt' ? current[key] > bound : false);
          return current[key] === value;
        });
        if (!row && !options.upsert) return null;
        if (row && !matches(row, query)) {
          if (options.upsert) throw Object.assign(new Error('duplicate fixed key'), { code: 11000 });
          return null;
        }
        row = { ...row, _id: query._id, ...update.$set };
        return { ...row };
      } };
    }
  }) };
}
module.exports = { memoryMongoose };
