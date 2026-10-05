'use strict';

const equal = (a, b) => String(a) === String(b);
const values = (value, parts) => !parts.length ? [value] : Array.isArray(value)
  ? value.flatMap(entry => values(entry, parts)) : values(value?.[parts[0]], parts.slice(1));
function matches(value, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(branch => matches(value, branch));
    if (key === '$and') return expected.every(branch => matches(value, branch));
    if (key === '$nor') return expected.every(branch => !matches(value, branch));
    const actual = values(value, key.split('.'));
    if (expected && typeof expected === 'object' && !Array.isArray(expected)
      && !(expected instanceof Date) && !expected._bsontype) {
      return Object.entries(expected).every(([op, operand]) => {
        if (op === '$exists') return actual.some(item => item !== undefined) === operand;
        if (op === '$ne') return actual.every(item => !equal(item, operand));
        if (op === '$in') return actual.some(item => operand.some(candidate => equal(item, candidate)));
        if (op === '$lt') return actual.some(item => item != null && item < operand);
        if (op === '$lte') return actual.some(item => item != null && item <= operand);
        if (op === '$gt') return actual.some(item => item != null && item > operand);
        if (op === '$gte') return actual.some(item => item != null && item >= operand);
        if (op === '$eq') return actual.some(item => equal(item, operand));
        throw new Error(`Unsupported transcript array condition: ${op}`);
      });
    }
    return actual.some(item => expected == null ? item == null : equal(item, expected));
  });
}

function applyAt(target, path, operator, operand) {
  for (const part of path.slice(0, -1)) {
    if (target[part] == null) target[part] = {};
    target = target[part];
  }
  const key = path.at(-1);
  if (operator === '$set') target[key] = operand;
  else if (operator === '$unset') delete target[key];
  else if (operator === '$inc') target[key] = (Number(target[key]) || 0) + operand;
  else throw new Error(`Unsupported transcript update: ${operator}`);
}

function applyMessageUpdate(messages, update, arrayFilters = []) {
  const selected = new Map(arrayFilters.map(filter => {
    const name = Object.keys(filter).find(key => key.includes('.'))?.split('.')[0];
    const mapped = Object.fromEntries(Object.entries(filter).map(([key, value]) => [key.replace(`${name}.`, ''), value]));
    return [name, messages.filter(message => matches(message, mapped))];
  }));
  for (const [operator, fields] of Object.entries(update)) {
    for (const [path, operand] of Object.entries(fields)) {
      if (path === 'messages') {
        if (operator === '$push') {
          if (operand?.$slice != null || operand?.$position != null || operand?.$sort != null) {
            throw new Error('Transcript pushes must append whole messages without slicing.');
          }
          messages.push(...(operand?.$each || [operand]));
        } else if (operator === '$set') messages = operand;
        else if (operator === '$unset') messages = [];
        else throw new Error(`Unsupported whole transcript update: ${operator}`);
      } else if (path.startsWith('messages.')) {
        const parts = path.split('.').slice(1);
        const selector = parts.shift();
        if (/^\$\[.+\]$/.test(selector)) {
          const name = selector.slice(2, -1);
          const filter = arrayFilters.find(row => Object.keys(row).some(key => key.startsWith(`${name}.`)));
          if (!filter) throw new Error('Transcript array filter is required.');
          for (const message of selected.get(name)) applyAt(message, parts, operator, operand);
        } else if (/^\d+$/.test(selector) && messages[Number(selector)]) {
          applyAt(messages[Number(selector)], parts, operator, operand);
        } else throw new Error('Unsupported transcript positional update.');
      }
    }
  }
  return messages;
}

module.exports = { applyMessageUpdate };
