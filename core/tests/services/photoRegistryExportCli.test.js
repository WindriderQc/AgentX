'use strict';
const assert = require('node:assert/strict');
const { main } = require('../../scripts/export-photo-registry.cjs');
function fixture(plan = {sha256s:['a'.repeat(64)]}) {
 const calls=[], exported={schema:'synthetic',migrationReady:false};
 return { calls, exported, args:{argv:['synthetic.json'],env:{MONGODB_URI:'synthetic://unused'},
 readFile:async()=>Buffer.from(JSON.stringify(plan)),
 connect:async(uri,options)=>calls.push(['connect',options]),disconnect:async()=>calls.push(['disconnect']),
 registry:{exportSelection:async input=>{calls.push(['export',input]);return exported;}},write:s=>calls.push(['write',s])} };
}
test('operator CLI disables schema writes and exports owner-only',async()=>{const f=fixture();assert.deepEqual(await main(f.args),f.exported);assert.deepEqual(f.calls[0],['connect',{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:10000}]);assert.equal(f.calls[1][1].audience,'owner');assert.equal(f.calls.at(-1)[0],'disconnect');});
for(const p of [{sha256s:[]},{sha256s:['wrong']},{sha256s:['a'.repeat(64),'a'.repeat(64)]},{sha256s:['a'.repeat(64)],audience:'family'}])test('bad selection rejected before DB '+JSON.stringify(p),async()=>{const f=fixture(p);await assert.rejects(main(f.args));assert.equal(f.calls.length,0);});
test('export failure writes no partial document and closes connection',async()=>{const f=fixture();f.args.registry.exportSelection=async()=>{throw Error('synthetic');};await assert.rejects(main(f.args));assert.deepEqual(f.calls.map(c=>c[0]),['connect','disconnect']);});
test('oversized input rejected before DB',async()=>{const f=fixture();f.args.readFile=async()=>Buffer.alloc(16385);await assert.rejects(main(f.args));assert.equal(f.calls.length,0);});
test('missing connection rejected before DB',async()=>{const f=fixture();f.args.env={};await assert.rejects(main(f.args));assert.equal(f.calls.length,0);});
