'use strict';

// Model calls also participate, including helpers outside the HTTP router.
// Raw collection access is reserved for the native repair executor and the
// ingestion insert already enclosed by its guarded service.
const access = require('./financeAccess');
module.exports = function guardModel(model) {
  if (Object.hasOwn(model, '$financeGuarded')) return model;
  Object.defineProperty(model, '$financeGuarded', { value: true });
  const exec = model.Query.prototype.exec;
  model.Query.prototype.exec = function (...args) { return access.withAccess(() => exec.apply(this, args)); };
  const cursor = model.Query.prototype.cursor;
  model.Query.prototype.cursor = function (...args) {
    access.requireCursorScope();
    return cursor.apply(this, args);
  };
  for (const method of ['insertMany', 'bulkWrite']) {
    const fn = model[method];
    model[method] = function (...args) { return access.withAccess(() => fn.apply(this, args)); };
  }
  const save = model.prototype.save;
  model.prototype.save = function (...args) { return access.withAccess(() => save.apply(this, args)); };
  const aggregate = model.aggregate;
  model.aggregate = function (...args) {
    const result = aggregate.apply(this, args);
    const exec = result.exec;
    result.exec = function (...args) { return access.withAccess(() => exec.apply(this, args)); };
    const cursor = result.cursor;
    result.cursor = function (...args) { access.requireCursorScope(); return cursor.apply(this, args); };
    return result;
  };
  return model;
};
