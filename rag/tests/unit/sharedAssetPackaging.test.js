const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../app');
const { SHARED_CORE_ASSETS } = require('../../../shared/sharedCoreAssets');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');

describe('RAG shared browser asset packaging', () => {
  test('the RAG image copies exactly the shared Core asset list', () => {
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'docker', 'rag.Dockerfile'), 'utf8');
    const copied = [...dockerfile.matchAll(/^COPY core\/\S+ \/core\/public\/(\S+)$/gm)].map(match => match[1]);
    expect(copied.sort()).toEqual([...SHARED_CORE_ASSETS].sort());
  });

  test('the closed shared-asset allowlist serves typed-confirmation as JavaScript', async () => {
    const response = await request(app)
      .get('/js/utils/typed-confirmation.js')
      .expect(200);

    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('AgentXTypedConfirmation');
  });
});
