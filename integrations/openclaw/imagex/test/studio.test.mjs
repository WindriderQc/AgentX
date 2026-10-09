import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeStudio, registerStudioRoute } from '../studio.mjs';

test('Atelier route requires gateway authentication and delegates only a bounded consultation', () => {
  let route;
  registerStudioRoute({ pluginConfig: {}, registerHttpRoute(value) { route = value; } });
  assert.equal(route.auth, 'gateway');
  assert.equal(route.match, 'exact');
  assert.equal(route.path, '/api/agentx/imagex/studio');
});

test('operational events accompany a verified proposal; invalid plans and cancellations fail', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imagex-studio-'));
  try {
    const command = path.join(directory, 'worker');
    const plan = { prompt: 'A lake at dawn', profile: 'quick', width: 1024, height: 1024, reason: 'Preserved format' };
    await writeFile(command, `#!/usr/bin/env node\nlet p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'started',reportedModel:'fixture'}));console.log(JSON.stringify({type:'result',result:{ok:true,expert:'hermes',text:JSON.stringify(${JSON.stringify(plan)})}})); });\n`, { mode: 0o700 });
    const input = { action: 'plan', request: { prompt: 'A lake', width: 1024 }, status: { configured: true, profiles: [{ id: 'quick', maxPixels: 1048576 }] } };
    const events = [], result = await invokeStudio(command, input, { emit: e => events.push(e) });
    assert.deepEqual(result.proposal, plan); assert.equal(events[0].type, 'started');
    await assert.rejects(invokeStudio(command, { ...input, request: { ...input.request, width: 512 } }), /requested width/);
    await writeFile(command, '#!/usr/bin/env node\nsetTimeout(()=>{},10000);\n', { mode: 0o700 });
    const controller = new AbortController();
    const pending = invokeStudio(command, { action: 'consult', prompt: 'A lake' }, { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, /interrupted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
