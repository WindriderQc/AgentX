jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  realpath: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
  rm: jest.fn(),
  unlink: jest.fn()
}));

jest.mock('mammoth', () => ({
  extractRawText: jest.fn()
}));

jest.mock('pdf-parse', () => ({ PDFParse: jest.fn() }));
jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());

const fs = require('fs/promises');
const { PDFParse } = require('pdf-parse');
const fetchWithTimeout = require('../../src/utils/fetchWithTimeout');
const { validateIngestionPolicy } = require('../../../shared/ingestionPolicy');

const {
  INGEST_API_TIMEOUT_MS,
  IngestWorker,
  buildTags,
  createIngestApiClient,
  deriveSourceTag,
  describeSkip,
  extractPdfText,
  needsReindex
} = require('../../src/services/ingestWorker');

describe('PDF extraction', () => {
  let parser;
  const buffer = Buffer.from('synthetic PDF input');

  beforeEach(() => {
    jest.clearAllMocks();
    parser = {
      getText: jest.fn().mockResolvedValue({ text: 'extracted content' }),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    PDFParse.mockImplementation(() => parser);
    fs.readFile.mockResolvedValue(buffer);
  });

  it('uses successful pdftotext output without opening a second parser', async () => {
    await expect(extractPdfText('sample.pdf', {
      commandRunner: async () => ({ stdout: 'native PDF text' }),
    })).resolves.toBe('native PDF text');
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(PDFParse).not.toHaveBeenCalled();
  });

  it('falls back on empty pdftotext output and releases the PDF worker', async () => {
    await expect(extractPdfText('sample.pdf', {
      commandRunner: async () => ({ stdout: '  ' }),
    })).resolves.toBe('extracted content');
    expect(PDFParse).toHaveBeenCalledWith({ data: buffer });
    expect(parser.destroy).toHaveBeenCalledTimes(1);
  });

  it('propagates invalid PDF errors and releases the PDF worker', async () => {
    const failure = new Error('Invalid PDF structure');
    parser.getText.mockRejectedValue(failure);
    await expect(extractPdfText('sample.pdf', {
      commandRunner: async () => { throw new Error('pdftotext unavailable'); },
    })).rejects.toBe(failure);
    expect(parser.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('ingestWorker utilities', () => {
  beforeEach(() => fetchWithTimeout.mockReset());

  it('submits API ingestion through the exact bounded worker operation', async () => {
    fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { documentId: 'doc-1' } }),
    });
    const ingest = createIngestApiClient({
      baseUrl: 'http://rag.test:3082',
    });

    await expect(ingest({ text: 'hello', source: 'worker' })).resolves.toEqual({
      documentId: 'doc-1',
    });
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      'http://rag.test:3082/api/rag/ingest',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
      INGEST_API_TIMEOUT_MS,
      {
        expectedOrigins: ['http://rag.test:3082'],
        operationId: 'rag.ingest-worker.submit',
      }
    );
  });

  it('rejects a configurable ingest path escape before dispatch', () => {
    expect(() => createIngestApiClient({
      baseUrl: 'http://rag.test:3082',
      ingestPath: '//other.test/ingest',
    })).toThrow('supports only the product ingest endpoint');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('derives a stable source tag and tags from the first folder beneath the configured root', () => {
    const filePath = '/data/imports/finance-docs/2026/plan.md';
    const roots = ['/data/imports', '/external/imports'];

    expect(deriveSourceTag(filePath, roots)).toBe('finance-docs');
    expect(buildTags(filePath, roots)).toEqual(['auto-ingested', 'finance-docs']);
  });

  it('marks records for reindex when mtime is newer than indexed_at', () => {
    expect(needsReindex({
      mtime: 1710000000,
      indexed_at: '2024-03-08T15:59:59.000Z'
    })).toBe(true);

    expect(needsReindex({
      mtime: 1710000000,
      indexed_at: '2024-03-09T17:00:01.000Z'
    })).toBe(false);
  });

  it('skips keys directories and oversized files', () => {
    expect(describeSkip({
      path: '/data/imports/docs/keys/private.txt',
      ext: 'txt',
      size: 128
    }, {
      roots: ['/data/imports/docs'],
      maxFileSizeBytes: 1024
    })).toEqual({ skip: true, reason: 'excluded_directory' });

    expect(describeSkip({
      path: '/data/imports/docs/big.txt',
      ext: 'txt',
      size: 4096
    }, {
      roots: ['/data/imports/docs'],
      maxFileSizeBytes: 1024
    })).toEqual({ skip: true, reason: 'oversized' });
  });

  it('excludes secret names, generated exports, and private roots deterministically', () => {
    expect(describeSkip({
      path: '/data/imports/docs/.env', ext: '', size: 10
    }, { roots: ['/data/imports/docs'] })).toEqual({ skip: true, reason: 'secret_material' });

    expect(describeSkip({
      path: '/data/imports/docs/generated_export.md', ext: 'md', size: 10
    }, { roots: ['/data/imports/docs'] })).toEqual({ skip: true, reason: 'generated_export' });

    expect(describeSkip({
      path: '/private/imports/accounts.md', ext: 'md', size: 10
    }, { roots: ['/private/imports'] })).toEqual({ skip: true, reason: 'outside_source' });
  });
});

function mockCursor(records) {
  let index = 0;
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    close: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (index < records.length) {
            return Promise.resolve({ value: records[index++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    }
  };
  return cursor;
}

describe('IngestWorker', () => {
  let collection;
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.realpath.mockImplementation(async (value) => value);
    fs.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => true });

    collection = {
      find: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
    };

    db = {
      collection: jest.fn().mockReturnValue(collection)
    };
  });

  it('ingests new files and updates indexed_at metadata in nas_files', async () => {
    const record = {
      _id: 'doc-1',
      path: '/data/imports/docs/report.md',
      ext: 'md',
      size: 512,
      mtime: 1710000000
    };

    collection.find.mockReturnValue(mockCursor([record]));
    fs.readFile.mockResolvedValue('# Quarterly update');

    const ingestDocument = jest.fn().mockResolvedValue({
      documentId: record.path,
      chunkCount: 2,
      status: 'created'
    });

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument,
      batchDelayMs: 0
    });

    const summary = await worker.run();

    expect(summary.totalCandidates).toBe(1);
    expect(summary.ingested).toBe(1);
    expect(summary.failed).toBe(0);
    expect(ingestDocument).toHaveBeenCalledWith(expect.objectContaining({
      text: '# Quarterly update',
      source: 'docs',
      tags: ['auto-ingested', 'docs'],
      documentId: record.path
    }));
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          indexed_status: 'ingested',
          indexed_document_id: record.path,
          indexed_source: 'docs',
          indexed_tags: ['auto-ingested', 'docs'],
          indexed_error: null
        })
      })
    );
  });

  it('re-ingests changed files and reports them as updated', async () => {
    const record = {
      _id: 'doc-2',
      path: '/data/imports/docs/guide.txt',
      ext: 'txt',
      size: 64,
      mtime: 1710001000,
      indexed_at: '2024-03-09T15:00:00.000Z'
    };

    collection.find.mockReturnValue(mockCursor([record]));
    fs.readFile.mockResolvedValue('Updated guide content');

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn().mockResolvedValue({
        documentId: record.path,
        chunkCount: 1,
        status: 'created'
      }),
      batchDelayMs: 0
    });

    const summary = await worker.run();

    expect(summary.updated).toBe(1);
    expect(summary.ingested).toBe(0);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-2' },
      expect.objectContaining({
        $set: expect.objectContaining({
          indexed_status: 'updated'
        })
      })
    );
  });

  it('records the canonical document ID returned by the ingestion boundary', async () => {
    const record = {
      _id: 'doc-duplicate',
      path: '/data/imports/docs/copy.md',
      ext: 'md',
      size: 64,
      mtime: 1710001000
    };
    fs.readFile.mockResolvedValue('Same exact content');
    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn().mockResolvedValue({
        documentId: '/data/imports/docs/original.md',
        requestedDocumentId: record.path,
        chunkCount: 1,
        unchanged: true,
        deduplicated: true
      }),
      batchDelayMs: 0
    });

    const result = await worker.processRecord(record);

    expect(result).toMatchObject({
      status: 'unchanged',
      documentId: '/data/imports/docs/original.md',
      deduplicated: true
    });
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-duplicate' },
      expect.objectContaining({
        $set: expect.objectContaining({
          indexed_status: 'unchanged',
          indexed_document_id: '/data/imports/docs/original.md'
        })
      })
    );
  });

  it('records extraction errors and continues instead of throwing', async () => {
    const record = {
      _id: 'doc-3',
      path: '/data/imports/docs/broken.txt',
      ext: 'txt',
      size: 32,
      mtime: 1710002000
    };

    fs.readFile.mockRejectedValue(new Error('ENOENT'));

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn(),
      batchDelayMs: 0
    });

    const result = await worker.processRecord(record);

    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      reason: 'ENOENT',
      path: record.path,
      source: 'docs'
    }));
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-3' },
      expect.objectContaining({
        $set: expect.objectContaining({
          indexed_error: 'ENOENT',
          indexed_document_id: record.path
        })
      })
    );
  });

  it('rejects symlink traversal before reading file content', async () => {
    const record = {
      _id: 'doc-symlink',
      path: '/data/imports/docs/linked-note.md',
      ext: 'md',
      size: 64,
      mtime: 1710003000
    };
    fs.realpath.mockImplementation(async (value) => (
      value === record.path ? '/etc/linked-secret.md' : value
    ));

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn(),
      batchDelayMs: 0
    });
    const result = await worker.processRecord(record);

    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/Symlink traversal/) });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('fails closed before querying Mongo when the approved root is absent', async () => {
    fs.realpath.mockRejectedValueOnce(new Error('ENOENT'));
    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn(),
      batchDelayMs: 0
    });

    await expect(worker.run()).rejects.toMatchObject({ code: 'INGEST_ROOT_UNAVAILABLE' });
    expect(collection.find).not.toHaveBeenCalled();
  });

  it('labels files under a classified root and leaves other files unlabelled', async () => {
    const policy = {
      schemaVersion: 1,
      source: { containerRoot: '/data/imports' },
      ingestion: {
        approvedRoots: ['/data/imports'],
        allowedExtensions: ['md'],
        maxFileSizeBytes: 1024,
        classifiedRoots: [{ root: '/data/imports/docs/maison', scope: 'household', sensitivity: 'normal' }]
      }
    };
    const records = [
      { _id: 'house', path: '/data/imports/docs/maison/guide.md', ext: 'md', size: 64 },
      { _id: 'other', path: '/data/imports/docs/notes.md', ext: 'md', size: 64 }
    ];
    collection.find.mockReturnValue(mockCursor(records));
    fs.readFile.mockResolvedValue('Synthetic text');
    const ingestDocument = jest.fn().mockResolvedValue({ chunkCount: 1 });
    const worker = new IngestWorker({ db, policy, roots: ['/data/imports/docs'], ingestDocument, batchDelayMs: 0 });

    await worker.run();
    expect(ingestDocument.mock.calls[0][0]).toMatchObject({ scope: 'household', sensitivity: 'normal' });
    expect(ingestDocument.mock.calls[1][0]).not.toHaveProperty('scope');
    expect(ingestDocument.mock.calls[1][0]).not.toHaveProperty('sensitivity');
  });

  it('rejects classified roots outside approved roots or with unknown labels', () => {
    const base = {
      schemaVersion: 1,
      source: { containerRoot: '/data/imports' },
      ingestion: { approvedRoots: ['/data/imports/docs'] }
    };
    const withRoots = (classifiedRoots) => ({ ...base, ingestion: { ...base.ingestion, classifiedRoots } });
    expect(() => validateIngestionPolicy(withRoots([
      { root: '/data/imports/docs/maison', scope: 'household', sensitivity: 'normal' }
    ]))).not.toThrow();
    expect(() => validateIngestionPolicy(withRoots([
      { root: '/data/imports/private', scope: 'household', sensitivity: 'normal' }
    ]))).toThrow('under an approved root');
    expect(() => validateIngestionPolicy(withRoots([
      { root: '/data/imports/docs/maison', scope: 'kids' }
    ]))).toThrow('memory policy vocabulary');
  });

  describe('Markdown notes', () => {
    const policy = {
      schemaVersion: 1,
      source: { containerRoot: '/data/imports' },
      ingestion: {
        approvedRoots: ['/data/imports'],
        allowedExtensions: ['md', 'txt'],
        maxFileSizeBytes: 1024,
        classifiedRoots: [{ root: '/data/imports/docs/maison', scope: 'household', sensitivity: 'normal' }]
      }
    };
    const run = async (record, text) => {
      collection.find.mockReturnValue(mockCursor([record]));
      fs.readFile.mockResolvedValue(text);
      const ingestDocument = jest.fn().mockResolvedValue({ chunkCount: 1 });
      const removeDocument = jest.fn().mockResolvedValue(true);
      const worker = new IngestWorker({ db, policy, roots: ['/data/imports/docs'], ingestDocument, removeDocument, batchDelayMs: 0 });
      const summary = await worker.run();
      return { summary, ingestDocument, removeDocument };
    };

    it('ingests notes as Markdown with labels a note may narrow', async () => {
      const { ingestDocument } = await run(
        { _id: 'n', path: '/data/imports/docs/maison/four.md', ext: 'md', size: 64 },
        '---\nsensitivity: private\n---\nTexte'
      );
      expect(ingestDocument.mock.calls[0][0]).toMatchObject({
        format: 'markdown', scope: 'household', sensitivity: 'private'
      });
    });

    it('does not read plain text files as Markdown', async () => {
      const { ingestDocument } = await run(
        { _id: 't', path: '/data/imports/docs/maison/notes.txt', ext: 'txt', size: 64 }, '---\nscope: owner\n---\n'
      );
      expect(ingestDocument.mock.calls[0][0]).not.toHaveProperty('format');
      expect(ingestDocument.mock.calls[0][0]).toMatchObject({ scope: 'household' });
    });

    it('removes a previously indexed note marked rag: false', async () => {
      const { summary, ingestDocument, removeDocument } = await run(
        { _id: 'x', path: '/data/imports/docs/maison/brouillon.md', ext: 'md', size: 64, indexed_document_id: '/data/imports/docs/maison/brouillon.md' },
        '---\nrag: false\n---\nTexte'
      );
      expect(ingestDocument).not.toHaveBeenCalled();
      expect(removeDocument).toHaveBeenCalledWith('/data/imports/docs/maison/brouillon.md');
      expect(summary.results[0]).toMatchObject({ status: 'skipped', reason: 'excluded_by_note' });
      expect(collection.updateOne).toHaveBeenCalledWith({ _id: 'x' }, { $set: expect.objectContaining({
        indexed_status: 'skipped-note', indexed_error: 'excluded_by_note'
      }) });
    });

    it('skips a note claiming household labels outside the household folder', async () => {
      const { summary, ingestDocument, removeDocument } = await run(
        { _id: 'w', path: '/data/imports/docs/notes.md', ext: 'md', size: 64 }, '---\nscope: household\nsensitivity: normal\n---\nTexte'
      );
      expect(ingestDocument).not.toHaveBeenCalled();
      expect(removeDocument).not.toHaveBeenCalled();
      expect(summary.results[0].reason).toBe('note_classification_widening');
    });
  });

  it('does not mutate imported files while ingesting', async () => {
    const record = {
      _id: 'doc-read-only',
      path: '/data/imports/docs/read-only.md',
      ext: 'md',
      size: 64,
      mtime: 1710004000
    };
    collection.find.mockReturnValue(mockCursor([record]));
    fs.readFile.mockResolvedValue('Read-only corpus');
    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn().mockResolvedValue({ chunkCount: 1 }),
      batchDelayMs: 0
    });

    await worker.run();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });
});
