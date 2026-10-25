'use strict';

// Independent decoder for the documented inline wire formats. It never imports
// the production encoders. Resolve text first, then values and dictionary data.
function expandedContext(encoded) {
  const pointer = (root, ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error('Invalid inline pointer');
    return ref.slice(2).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((parent, key) => {
        if (!parent || !Object.hasOwn(parent, key)) throw new Error('Missing inline value');
        return parent[key];
      }, root);
  };
  const map = (value, visit) => Array.isArray(value) ? value.map(visit)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
  const object = value => value && typeof value === 'object' && !(value instanceof Date);
  function texts(value) {
    if (!object(value)) return value;
    if (encoded.sharedTextEncoding && Object.keys(value).length === 1 && Object.hasOwn(value, '$textRef')) {
      const result = pointer(encoded, value.$textRef);
      if (typeof result !== 'string') throw new Error('Text reference must target a retained string');
      return result;
    }
    return map(value, texts);
  }
  const withTexts = texts(encoded);
  function values(value, stack = new Set()) {
    if (!object(value)) return value;
    const keys = Object.keys(value);
    const dereference = ref => {
      if (stack.has(ref)) throw new Error('Cyclic inline value reference');
      return values(pointer(withTexts, ref), new Set([...stack, ref]));
    };
    if (encoded.sharedValueEncoding && keys.length === 1 && Object.hasOwn(value, '$valueRef')) return dereference(value.$valueRef);
    if (encoded.sharedValueEncoding && keys.length === 2 && Object.hasOwn(value, '$valueBase') && Object.hasOwn(value, '$valuePatch')) {
      return { ...dereference(value.$valueBase), ...values(value.$valuePatch, stack) };
    }
    if (encoded.evidenceEncoding && keys.length === 1 && typeof value.$ref === 'string'
        && value.$ref.startsWith('#/sharedToolEvidence/')) return dereference(value.$ref);
    return map(value, item => values(item, stack));
  }
  const result = values(withTexts);
  for (const key of ['sharedTextEncoding', 'sharedValueEncoding', 'sharedToolEvidence', 'evidenceEncoding']) delete result[key];
  return result;
}

module.exports = { expandedContext };
