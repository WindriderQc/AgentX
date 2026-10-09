/**
 * Storage trends rules that need no database: the bounded folder rule, the
 * growth summary and the query bounds.
 */
const trends = require('../../services/storageTrends');

const group = (top, second, files, bytes) => ({ _id: { top, second }, files, bytes });

describe('buildFolders', () => {
  test('few top-level folders: both levels, each level adding up to its total', () => {
    const built = trends.buildFolders([
      group(null, null, 2, 20),            // files directly in the root
      group('Movies', null, 1, 10),        // files directly in Movies
      group('Movies', 'Action', 5, 500),
      group('Movies', 'Drama', 3, 300),
      group('Music', null, 4, 40)          // no subfolder
    ]);
    expect(built).toMatchObject({ files: 15, bytes: 870, topLevelFolders: 2, secondLevel: true });
    expect(built.folders).toEqual([
      { key: 'Movies', name: 'Movies', parent: null, depth: 1, kind: 'folder', files: 9, bytes: 810 },
      { key: 'Music', name: 'Music', parent: null, depth: 1, kind: 'folder', files: 4, bytes: 40 },
      { key: '/files', name: null, parent: null, depth: 1, kind: 'files', files: 2, bytes: 20 },
      { key: 'Movies/Action', name: 'Action', parent: 'Movies', depth: 2, kind: 'folder', files: 5, bytes: 500 },
      { key: 'Movies/Drama', name: 'Drama', parent: 'Movies', depth: 2, kind: 'folder', files: 3, bytes: 300 },
      { key: 'Movies//files', name: null, parent: 'Movies', depth: 2, kind: 'files', files: 1, bytes: 10 }
    ]);
    const top = built.folders.filter(folder => folder.depth === 1);
    expect(top.reduce((sum, folder) => sum + folder.bytes, 0)).toBe(built.bytes);
    expect(top.reduce((sum, folder) => sum + folder.files, 0)).toBe(built.files);
  });

  test('many top-level folders: the 40 largest, the rest folded into "other", no second level', () => {
    const groups = Array.from({ length: 55 }, (_, i) => group(`F${String(i).padStart(2, '0')}`, 'Sub', 1, 1000 - i));
    const built = trends.buildFolders(groups);
    expect(built).toMatchObject({ files: 55, topLevelFolders: 55, secondLevel: false });
    expect(built.folders).toHaveLength(41);
    expect(built.folders[0]).toMatchObject({ key: 'F00', bytes: 1000 });
    expect(built.folders[39]).toMatchObject({ key: 'F39', bytes: 961 });
    expect(built.folders[40]).toEqual({
      key: '/other', name: null, parent: null, depth: 1, kind: 'other', folders: 15,
      files: 15, bytes: Array.from({ length: 15 }, (_, i) => 1000 - 40 - i).reduce((a, b) => a + b, 0)
    });
    expect(built.folders.every(folder => folder.depth === 1)).toBe(true);
    expect(built.folders.reduce((sum, folder) => sum + folder.bytes, 0)).toBe(built.bytes);
  });

  test('a folder with many children keeps its 20 largest and an "other" entry', () => {
    const groups = Array.from({ length: 30 }, (_, i) => group('Series', `S${String(i).padStart(2, '0')}`, 2, 100 - i));
    const built = trends.buildFolders(groups);
    const children = built.folders.filter(folder => folder.parent === 'Series');
    expect(children).toHaveLength(21);
    expect(children[20]).toMatchObject({ key: 'Series//other', kind: 'other', folders: 10, files: 20 });
    expect(children.reduce((sum, folder) => sum + folder.files, 0)).toBe(60);
    // Stored entries stay bounded: 5 folders x (20 + other + files) + 5 + files.
    expect(built.folders.length).toBeLessThanOrEqual(trends.MAX_TOP_FOLDERS + 2 + trends.SECOND_LEVEL_MAX_TOPS * (trends.MAX_SECOND_PER_TOP + 2));
  });

  test('an empty root is a zero snapshot', () => {
    expect(trends.buildFolders([])).toEqual({ files: 0, bytes: 0, topLevelFolders: 0, secondLevel: false, folders: [] });
  });
});

describe('snapshotEligible', () => {
  test.each([
    ['complete', true], ['completed', true], ['partial', false], ['failed', false], ['stopped', false], ['running', false]
  ])('%s -> %s', (status, expected) => {
    expect(trends.snapshotEligible({ status, config: { roots: ['/mnt/media'] } })).toBe(expected);
  });

  test('a scan without roots is not eligible', () => {
    expect(trends.snapshotEligible({ status: 'complete', config: {} })).toBe(false);
    expect(trends.snapshotEligible(null)).toBe(false);
  });
});

describe('parseQuery', () => {
  const now = new Date('2026-10-08T15:00:00Z');

  test('defaults to the last 90 days and 12 folder series', () => {
    expect(trends.parseQuery({ root: '/mnt/media/' }, now)).toEqual({
      root: '/mnt/media', folder: null, from: '2026-07-10', to: '2026-10-08', days: 91, limit: 12
    });
    expect(trends.parseQuery({}, now)).toMatchObject({ root: null, folder: null });
  });

  test('accepts ISO dates, a folder key and the widest window', () => {
    expect(trends.parseQuery({
      root: '/mnt/media', folder: 'Movies/Action', from: '2024-07-31', to: '2026-10-08T23:00:00Z', limit: '42'
    }, now)).toEqual({ root: '/mnt/media', folder: 'Movies/Action', from: '2024-07-31', to: '2026-10-08', days: 800, limit: 42 });
  });

  test.each([
    [{ root: 'mnt/media' }, /absolute path/],
    [{ root: ['/a'] }, /absolute path/],
    [{ root: `/${'a'.repeat(1024)}` }, /absolute path/],
    [{ root: '/mnt/me\u0000dia' }, /absolute path/],
    [{ folder: 'Movies' }, /folder requires root/],
    [{ root: '/mnt/media', folder: 'x'.repeat(601) }, /folder must be/],
    [{ root: '/mnt/media', folder: { $gt: '' } }, /folder must be/],
    [{ root: '/mnt/media', from: 'soon' }, /from must be a date/],
    [{ root: '/mnt/media', to: ['2026-01-01'] }, /to must be a date/],
    [{ root: '/mnt/media', from: '2026-10-09', to: '2026-10-08' }, /from must not be after to/],
    [{ root: '/mnt/media', from: '2024-07-30', to: '2026-10-08' }, /at most 800 days/],
    [{ root: '/mnt/media', limit: '0' }, /limit must be/],
    [{ root: '/mnt/media', limit: '43' }, /limit must be/],
    [{ root: '/mnt/media', limit: '2.5' }, /limit must be/]
  ])('refuses %j', (query, pattern) => {
    let error;
    try { trends.parseQuery(query, now); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ statusCode: 400 });
    expect(error.message).toMatch(pattern);
  });
});

describe('growthBetween', () => {
  const folder = (key, bytes, files, extra = {}) => {
    const parts = key.split('/');
    return { key, name: parts[parts.length - 1], parent: parts.length > 1 ? parts[0] : null, depth: parts.length, kind: 'folder', files, bytes, ...extra };
  };
  const first = { day: '2026-09-01', files: 100, bytes: 1000, folders: [folder('Movies', 600, 60), folder('Music', 400, 40), folder('Movies/Action', 600, 60)] };
  const last = {
    day: '2026-10-01', files: 130, bytes: 1900,
    folders: [folder('Movies', 1200, 80), folder('Music', 350, 30), folder('Photos', 350, 20), folder('Movies/Action', 700, 62), folder('Movies/Drama', 500, 18)]
  };

  test('totals added and the folders that grew the most, a new folder counting from zero', () => {
    expect(trends.growthBetween(first, last, null)).toEqual({
      from: { day: '2026-09-01', files: 100, bytes: 1000 },
      to: { day: '2026-10-01', files: 130, bytes: 1900 },
      days: 30, filesAdded: 30, bytesAdded: 900,
      folders: [
        { key: 'Movies', name: 'Movies', parent: null, depth: 1, kind: 'folder', fromBytes: 600, toBytes: 1200, bytesAdded: 600, filesAdded: 20 },
        { key: 'Photos', name: 'Photos', parent: null, depth: 1, kind: 'folder', fromBytes: 0, toBytes: 350, bytesAdded: 350, filesAdded: 20 }
      ]
    });
  });

  test('inside one folder: its own growth and its children', () => {
    const growth = trends.growthBetween(first, last, 'Movies');
    expect(growth).toMatchObject({ filesAdded: 20, bytesAdded: 600 });
    expect(growth.folders.map(item => [item.key, item.bytesAdded])).toEqual([['Movies/Drama', 500], ['Movies/Action', 100]]);
  });

  test('a folder absent from a first snapshot that had an "other" bucket is not counted from zero', () => {
    const truncated = { ...first, folders: [...first.folders, { key: '/other', name: null, parent: null, depth: 1, kind: 'other', files: 5, bytes: 50, folders: 3 }] };
    expect(trends.growthBetween(truncated, last, null).folders.map(item => item.key)).toEqual(['Movies']);
  });

  test('no summary with fewer than two days', () => {
    expect(trends.growthBetween(first, first, null)).toBeNull();
    expect(trends.growthBetween(null, last, null)).toBeNull();
  });
});
