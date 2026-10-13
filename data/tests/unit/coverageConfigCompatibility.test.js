const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadNycConfig } = require('@istanbuljs/load-nyc-config');

test('coverage configuration still loads YAML through the updated parser', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-coverage-'));
  try {
    await fs.writeFile(path.join(directory, 'package.json'), '{"private":true}');
    await fs.writeFile(path.join(directory, '.nycrc.yml'), 'all: true\ncheck-coverage: true\ninclude:\n  - src/**/*.js\n');
    const config = await loadNycConfig({ cwd: directory, nycrcPath: '.nycrc.yml' });
    expect(config).toMatchObject({ all: true, checkCoverage: true, include: ['src/**/*.js'] });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
