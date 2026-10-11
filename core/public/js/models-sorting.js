/**
 * Models library sorting: one sort state shared by the sort menu and the
 * column headers. Missing values are unknown, so they sort after every
 * known value in both directions instead of counting as zero.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ModelsSorting = api;
}(typeof window !== 'undefined' ? window : null, () => {
  // Menu choices that read naturally from the largest value first.
  const DEFAULT_DIRECTION = { score: 'desc', size: 'desc', speed: 'desc', newest: 'desc', params: 'desc', context: 'desc' };

  function parseParams(value) {
    const match = String(value || '').trim().match(/^([\d.]+)\s*([KMBT]?)/i);
    if (!match) return null;
    const scale = { K: 1e-6, M: 1e-3, B: 1, T: 1e3, '': 1 }[match[2].toUpperCase()];
    const number = Number(match[1]) * scale;
    return Number.isFinite(number) ? number : null;
  }

  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function sortValue(model, key) {
    switch (key) {
      case 'name': return String(model.name || '').toLowerCase() || null;
      case 'host': return String(model.source?.hostName || model.source?.url || '').toLowerCase() || null;
      case 'params': return parseParams(model.details?.parameter_size || model.parameterSize || model.parameters);
      case 'context': return positive(model.executionOverrides?.num_ctx || model.capabilities?.maxContext || model.details?.context_length);
      case 'score': return positive(model.benchmarkStats?.avgCompositeScore);
      case 'speed': return positive(model.capabilities?.avgTokensPerSec);
      case 'size': return positive(model.size);
      case 'newest': {
        const time = new Date(model.modified_at || 0).getTime();
        return time > 0 ? time : null;
      }
      default: return null;
    }
  }

  function defaultDirection(key) {
    return DEFAULT_DIRECTION[key] || 'asc';
  }

  function sortModels(models, sort = {}) {
    const key = sort.key || 'name';
    const factor = (sort.direction || defaultDirection(key)) === 'desc' ? -1 : 1;
    return [...(models || [])].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av === null || bv === null) {
        if (av === bv) return String(a.name || '').localeCompare(String(b.name || ''));
        return av === null ? 1 : -1;
      }
      const order = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return order * factor || String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  return Object.freeze({ sortModels, sortValue, defaultDirection, parseParams });
}));
