const { sortModels, parseParams, defaultDirection } = require('../../public/js/models-sorting.js');

const model = (name, overrides = {}) => ({ name, ...overrides });

describe('Models library sorting', () => {
  const models = [
    model('slow', { capabilities: { avgTokensPerSec: 12 } }),
    model('unknown-speed'),
    model('fast', { capabilities: { avgTokensPerSec: 70 } })
  ];

  test('sorts unknown values last in both directions', () => {
    expect(sortModels(models, { key: 'speed', direction: 'desc' }).map(m => m.name)).toEqual(['fast', 'slow', 'unknown-speed']);
    expect(sortModels(models, { key: 'speed', direction: 'asc' }).map(m => m.name)).toEqual(['slow', 'fast', 'unknown-speed']);
  });

  test('reads parameter sizes with their unit', () => {
    expect(parseParams('137M')).toBeCloseTo(0.137);
    expect(parseParams('32B')).toBe(32);
    expect(parseParams('-')).toBeNull();
    const sorted = sortModels([
      model('a', { details: { parameter_size: '8B' } }),
      model('b', { details: { parameter_size: '137M' } }),
      model('c', { details: { parameter_size: '32B' } })
    ], { key: 'params', direction: 'desc' });
    expect(sorted.map(m => m.name)).toEqual(['c', 'a', 'b']);
  });

  test('uses natural default directions and a stable name tie-break', () => {
    expect(defaultDirection('name')).toBe('asc');
    expect(defaultDirection('score')).toBe('desc');
    const tied = sortModels([model('b'), model('a')], { key: 'score' });
    expect(tied.map(m => m.name)).toEqual(['a', 'b']);
  });

  test('does not mutate the input list', () => {
    const input = [model('b'), model('a')];
    sortModels(input, { key: 'name' });
    expect(input.map(m => m.name)).toEqual(['b', 'a']);
  });
});
