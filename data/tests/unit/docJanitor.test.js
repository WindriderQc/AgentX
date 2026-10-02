const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const docJanitor = require('../../services/devtools/docJanitor');

function write(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('DocJanitor lifecycle and authority classification', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docjanitor-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('uses frontmatter, docs-map, and the real docs index', () => {
    write(repoRoot, 'docs/INDEX.md', [
      '# Index',
      '',
      '- [Permanent](ai-ops/permanent.md)',
      '- [Mapped](ai-ops/mapped.md)',
      '- [Historical](ai-ops/historical.md)'
    ].join('\n'));
    write(repoRoot, 'docs/ai-ops/permanent.md', [
      '---',
      'doc_type: permanent',
      'status: active',
      '---',
      '',
      '# Permanent'
    ].join('\n'));
    write(repoRoot, 'docs/ai-ops/historical.md', [
      '---',
      'doc_type: historical',
      'status: superseded',
      '---',
      '',
      '# Historical'
    ].join('\n'));
    write(repoRoot, 'docs/ai-ops/mapped.md', '# Mapped\n');
    write(repoRoot, 'config/docs-map.yml', [
      'topics:',
      '  - id: example',
      '    canonical: ./docs/ai-ops/mapped.md',
      '    verify_against:',
      '      - ./LEAD.md',
      '    supporting:',
      '      - ./docs/ai-ops/permanent.md',
      '    historical_allowed:',
      '      - ./docs/ai-ops/historical.md'
    ].join('\n'));
    write(repoRoot, 'LEAD.md', '# Lead\n');

    const result = docJanitor.scan({ targetRepo: repoRoot });
    const byPath = Object.fromEntries(result.files.map(file => [file.path, file]));

    expect(result.index_path).toBe('docs/INDEX.md');
    expect(result.docs_map_path).toBe('config/docs-map.yml');
    expect(result.summary.index_links).toBe(3);
    expect(result.summary.broken_index_links).toBe(0);
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'missing_docs_index' })
    ]));
    expect(result.recommendations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Create docs/INDEX.md as canonical authority' })
    ]));
    expect(byPath['docs/ai-ops/permanent.md']).toMatchObject({
      category: 'PERMANENT',
      referenced_by_index: true
    });
    expect(byPath['docs/ai-ops/mapped.md']).toMatchObject({
      category: 'PERMANENT',
      reason: 'Canonical in config/docs-map.yml',
      referenced_by_index: true
    });
    expect(byPath['docs/ai-ops/historical.md']).toMatchObject({
      category: 'TRANSIENT',
      referenced_by_index: true
    });
    expect(byPath['LEAD.md']).toMatchObject({
      category: 'PERMANENT',
      reason: 'Verification authority in config/docs-map.yml'
    });
  });

  test('uses the lifecycle inventory for legacy docs without frontmatter', () => {
    write(repoRoot, 'docs/INDEX.md', '# Index\n');
    write(repoRoot, 'docs/ai-ops/legacy-review.md', '# Legacy review\n');
    write(repoRoot, 'docs/progress/documentation-migration/inventory.yml', [
      'artifacts:',
      '  - path: docs/ai-ops/legacy-review.md',
      '    class: generated',
      '    authority: evidence',
      '    classification_reason: reviewed migration inventory',
      '    migration_state: needs_review'
    ].join('\n'));

    const result = docJanitor.scan({ targetRepo: repoRoot });
    const legacy = result.files.find(file => file.path === 'docs/ai-ops/legacy-review.md');

    expect(result.lifecycle_inventory_path)
      .toBe('docs/progress/documentation-migration/inventory.yml');
    expect(legacy).toMatchObject({
      category: 'TRANSIENT',
      reason: 'Lifecycle inventory (generated; needs_review)'
    });
  });

  test('scans tracked Markdown only when the target is a Git repository', () => {
    execFileSync('git', ['init', '--quiet', repoRoot]);
    write(repoRoot, '.gitignore', '.agentx/\n');
    write(repoRoot, 'README.md', '# Tracked\n');
    write(repoRoot, '.agentx/scratch.md', '# Ignored\n');
    execFileSync('git', ['-C', repoRoot, 'add', '.gitignore', 'README.md']);

    const result = docJanitor.scan({ targetRepo: repoRoot });

    expect(result.files.map(file => file.path)).toEqual(['README.md']);
  });

  test('fails closed when a tracked Markdown file remains unclassified', () => {
    write(repoRoot, 'docs/INDEX.md', '# Index\n');
    write(repoRoot, 'misc/unclassified.md', '# Unknown\n');

    const result = docJanitor.scan({ targetRepo: repoRoot });

    expect(result.status).toBe('fail');
    expect(result.summary.unknown).toBe(1);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'fail', type: 'unclassified_docs' })
    ]));
  });

  test('reports a missing index only when it is absent', () => {
    write(repoRoot, 'README.md', '# Repo\n');

    const result = docJanitor.scan({ targetRepo: repoRoot });

    expect(result.index_path).toBeNull();
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warn', type: 'missing_docs_index' })
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Create docs/INDEX.md as canonical authority' })
    ]));
  });

  test('fails closed on a broken relative index link', () => {
    write(repoRoot, 'docs/INDEX.md', '- [Missing](missing.md)\n');

    const result = docJanitor.scan({ targetRepo: repoRoot });

    expect(result.status).toBe('fail');
    expect(result.summary.broken_index_links).toBe(1);
    expect(result.broken_index_links).toEqual([
      { target: 'missing.md', resolved_path: 'docs/missing.md' }
    ]);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'fail', type: 'broken_docs_index_links' })
    ]));
  });
});
