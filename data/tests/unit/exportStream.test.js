/**
 * Stream-integrity tests for the full JSON export, on a real temporary directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamReport, reportSource } = require('../../controllers/exportController');

async function streamFullReport(db, target) {
  const { rowCount, skippedFiles } = await streamReport(target, await reportSource(db, 'full'), 'json');
  return { totalFiles: rowCount, skippedFiles };
}

function dbWith(cursor) {
  return { collection: () => ({ find: () => ({ sort: () => cursor }) }) };
}

function cursorOf(docs, { failAfter } = {}) {
  let index = 0;
  return {
    next: jest.fn(async () => {
      if (failAfter !== undefined && index === failAfter) throw new Error('cursor lost');
      return index < docs.length ? docs[index++] : null;
    }),
    close: jest.fn().mockResolvedValue()
  };
}

describe('streamReport (full JSON)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-stream-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a skipped first document leaves valid JSON and is counted separately', async () => {
    const target = path.join(dir, 'full.json');
    const cursor = cursorOf([
      { dirname: '/safe', filename: 'bad.bin', size: 10n },
      { dirname: '/safe', filename: 'a.txt', size: 1 },
      { dirname: '/safe', filename: 'b.txt', size: 2 }
    ]);
    const result = await streamFullReport(dbWith(cursor), target);
    const report = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(result).toEqual({ totalFiles: 2, skippedFiles: 1 });
    expect(report.files.map(f => f.filename)).toEqual(['a.txt', 'b.txt']);
    expect(report).toMatchObject({ totalFiles: 2, skippedFiles: 1 });
    expect(cursor.close).toHaveBeenCalled();
  });

  test('never overwrites an existing export', async () => {
    const target = path.join(dir, 'full.json');
    fs.writeFileSync(target, 'previous export');
    const cursor = cursorOf([{ dirname: '/safe', filename: 'a.txt', size: 1 }]);
    await expect(streamFullReport(dbWith(cursor), target)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(target, 'utf8')).toBe('previous export');
    expect(cursor.close).toHaveBeenCalled();
  });

  test('a cursor failure closes the cursor and removes the partial file', async () => {
    const target = path.join(dir, 'full.json');
    const cursor = cursorOf([
      { dirname: '/safe', filename: 'a.txt', size: 1 },
      { dirname: '/safe', filename: 'b.txt', size: 2 }
    ], { failAfter: 1 });
    await expect(streamFullReport(dbWith(cursor), target)).rejects.toThrow('cursor lost');
    expect(fs.existsSync(target)).toBe(false);
    expect(cursor.close).toHaveBeenCalled();
  });
});
