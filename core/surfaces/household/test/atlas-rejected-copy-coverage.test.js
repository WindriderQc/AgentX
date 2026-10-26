'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { catchupProjection } = require('../secretary-catchup');

test('deferred copy counts survive Python status, Core and Atlas without crediting a read or coverage', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-copy-chain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const objective = path.join(root, 'objective-reviews/life-timeline/v1');
  fs.mkdirSync(objective, { recursive: true });
  fs.writeFileSync(path.join(objective, 'coverage.json'), JSON.stringify({ objectiveId: 'life-timeline', version: 'v1',
    counts: { targetSources: 10, reviewedPages: 0, sourcesTextReviewed: 0, sourcesTextCovered: 0,
      rejectedPages: 2, sourcesWithRejectedPages: 2, deferredRejectedCopyPages: 8, sourcesWithDeferredRejectedCopies: 8,
      sourcesWithGaps: 10, pendingPagesKnown: 0, privateBody: 'must-not-escape' }, allTargetTextCovered: false }));
  const secretary = path.resolve(__dirname, '../../../../integrations/secretary');
  const reply = spawnSync('python3', ['-c',
    'import sys,json; sys.path.insert(0,sys.argv[1]); from objective_status import projection; print(json.dumps(projection(sys.argv[2])))',
    secretary, root], { encoding: 'utf8' });
  assert.equal(reply.status, 0, reply.stderr);
  const projected = catchupProjection({ known: true, ...JSON.parse(reply.stdout) });
  const objectiveRead = projected.objectiveReviews[0];
  assert.equal(objectiveRead.counts.deferredRejectedCopyPages, 8);
  assert.equal(objectiveRead.counts.sourcesWithDeferredRejectedCopies, 8);
  assert.equal(objectiveRead.counts.reviewedPages, 0);
  assert.equal(objectiveRead.counts.sourcesTextCovered, 0);
  assert.equal(objectiveRead.counts.rejectedPages, 2);
  assert.equal(objectiveRead.allTargetTextCovered, false);
  assert.doesNotMatch(JSON.stringify(projected), /privateBody|must-not-escape/);
  const { nativeCoverage, rejectedCopyNotice } = await import('../public/atlas/coverage.js');
  const html = nativeCoverage(projected);
  assert.match(html, /8 passages de copies reportés/);
  assert.match(html, /n’ont pas été relues par le modèle et restent hors couverture/);
  assert.match(html, /0 textes de source relus au complet sur 10 fichiers ciblés/);
  assert.doesNotMatch(html, /Tous les textes ciblés sont couverts/);
  assert.equal(rejectedCopyNotice({ deferredRejectedCopyPages: 0 }), '');
});
