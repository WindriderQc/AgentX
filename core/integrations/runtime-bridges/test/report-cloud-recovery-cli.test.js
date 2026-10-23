'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

test('owner recovery CLI reads the installed native control without a public HTTP entrance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-recovery-cli-'));
  try {
    await mkdir(join(root, 'node_modules/mongoose'), { recursive: true });
    await mkdir(join(root, 'integrations/runtime-bridges'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'node_modules/mongoose/index.js'), `module.exports={connect:async()=>{},disconnect:async()=>{}}`);
    await writeFile(join(root, 'integrations/runtime-bridges/coding-dispatch-control.js'),
      `module.exports={CodingDispatchControl:class{async status({requestId}){return {busy:false,run:{requestId,phase:'unknown'}}}}}`);
    await writeFile(join(root, 'receiver.js'), `module.exports={createRecovery:({control})=>({receive:async(id,key,body)=>{
      const observed=await control.status({requestId:key});
      if(observed.busy!==false||observed.run.requestId!==key||observed.run.phase!=='unknown')throw Error('unverified');
      return {recovered:true,pipelineId:id,requestId:key,by:body.by};}})}`);
    await writeFile(join(root, 'intent.json'), JSON.stringify({ pipelineId: '0001', requestId: 'original', body: { by: 'operator' } }));
    const child = spawnSync(process.execPath, [resolve(__dirname, '../../../scripts/receive-report-cloud-refusal.cjs'),
      root, join(root, 'receiver.js'), join(root, 'intent.json')], { encoding: 'utf8',
      env: { ...process.env, CORE_PUBLIC_URL: 'no-public-network', MONGODB_URI: 'synthetic-unused' } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { recovered: true, pipelineId: '0001', requestId: 'original', by: 'operator' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
