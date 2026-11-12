'use strict';
const crypto = require('node:crypto');
const { createPhotoProcessingImmich } = require('../../src/services/photos/photoProcessingImmich');
const { pendingWriteId } = require('../../src/services/photos/photoProcessingTags');
const uuid=()=>crypto.randomUUID(), SHA='a'.repeat(64), PENDING='AgentX/Relecture/à relire';
function fixture() {
  const assetId=uuid(), libraryId=uuid(), catalog=new Map();
  const tag=value=>{if(!catalog.has(value))catalog.set(value,{id:uuid(),value});return catalog.get(value);};
  let values=['Famille & amis',PENDING,'AgentX/Téléphone/Étiquette/ancien'], state, busy=0;
  const bridge={call:jest.fn(async command=>{state={...command,persisted:true,sidecarSha256:'b'.repeat(64),relativePath:'run/image.jpg'};return state;})};
  const client={json:jest.fn(async (p,o)=>{
    if(p==='/assets/'+assetId)return {id:assetId,libraryId,originalPath:'/gallery/run/image.jpg',tags:values.map(tag)};
    if(p==='/tags')return o.body.tags.map(tag);
    if(p==='/jobs'){
      if(busy){busy--;values=state.tags.slice();}
      return Object.fromEntries(['sidecar','metadataExtraction'].map(n=>[n,{queueStatus:{isActive:!!busy},jobCounts:{active:busy,waiting:0,delayed:0,paused:0}}]));
    }
    const t=[...catalog.values()].find(t=>p==='/tags/'+t.id+'/assets');
    if(!t)throw Error('Unexpected upstream request '+p);
    values=o.method==='PUT'?[...new Set([...values,t.value])]:values.filter(v=>v!==t.value);busy=2;
    return [{id:assetId,success:true}];
  })};
  const api=createPhotoProcessingImmich({client,bridge,config:()=>({libraryId,originalPathPrefix:'/gallery'}),pause:async()=>{}});
  return {api,client,bridge,assetId,tag,values:()=>values,state:()=>state};
}
test('owner review persists a complete XMP set before tags and survives subsequent extraction without editing descriptions',async()=>{
  const f=fixture(),writeId=uuid();
  await f.api.syncReview(f.assetId,{approved:true,tags:['nature']},{sha256:SHA,writeId,revision:1,baselineTags:['Sauvegarde humaine']});
  expect(f.state()).toMatchObject({writeId,revision:1,tags:expect.arrayContaining(['Famille & amis','Sauvegarde humaine','AgentX/Téléphone/Relu','AgentX/Téléphone/Étiquette/nature'])});
  expect(f.values()).toEqual(f.state().tags);
  expect(f.values()).not.toContain(PENDING);expect(f.values()).not.toContain('AgentX/Téléphone/Étiquette/ancien');
  expect(f.client.json.mock.calls.some(([p,o])=>p.startsWith('/assets/')&&o?.method)).toBe(false);
  expect(f.client.json.mock.calls.some(([p,o])=>p==='/tags/'+f.tag('Famille & amis').id+'/assets'&&o.method==='DELETE')).toBe(false);
  expect(f.bridge.call.mock.invocationCallOrder[0]).toBeLessThan(f.client.json.mock.invocationCallOrder[1]);
});
test('pending marker has one content-bound identity and metadata snapshots can restore lost human tags',async()=>{
  const f=fixture();await f.api.pendingTag(f.assetId,{sha256:SHA,baselineTags:['Ancienne étiquette']});
  expect(f.state()).toMatchObject({writeId:pendingWriteId(SHA),revision:0});
  expect(f.values()).toContain(PENDING);expect(f.values()).toContain('Ancienne étiquette');
  expect(f.values()).not.toContain('AgentX/Téléphone/Étiquette/ancien');
});
test('an edited gallery sidecar or incomplete baseline refuses before any upstream mutation',async()=>{
  const f=fixture();f.bridge.call.mockRejectedValue(Object.assign(Error('foreign XMP'),{code:'PHOTO_SIDECAR_CONFLICT'}));
  await expect(f.api.pendingTag(f.assetId,{sha256:SHA})).rejects.toMatchObject({code:'PHOTO_SIDECAR_CONFLICT'});
  expect(f.client.json.mock.calls.filter(([,o])=>o?.method)).toHaveLength(0);
  await expect(f.api.pendingTag(f.assetId,{sha256:SHA,baselineIncomplete:true})).rejects.toMatchObject({code:'PHOTO_TAG_BASELINE_UNAVAILABLE'});
});
test('a delayed pending marker applies the newer durable owner revision instead of restoring its pending tag',async()=>{
  const f=fixture();const send=f.bridge.call;
  const approved={sha256:SHA,writeId:uuid(),revision:2,tags:['Famille & amis','AgentX/Téléphone/Relu'],superseded:true,sidecarSha256:'b'.repeat(64),relativePath:'run/image.jpg'};
  f.bridge.call=jest.fn(async command=>{await send({...command,...approved});return approved;});
  // The factory retains the bridge object, so this simulates the NAS monotonic verdict.
  const result=await f.api.pendingTag(f.assetId,{sha256:SHA});
  expect(result).toMatchObject({revision:2,superseded:true});expect(f.values()).not.toContain(PENDING);
});
test('an acknowledged tag that disappears after indexing is never reported as durable success',async()=>{
  const f=fixture(),send=f.client.json;
  f.client.json=jest.fn(async(p,o)=>{const value=await send(p,o);if(p.startsWith('/assets/'))value.tags=value.tags.filter(t=>t.value!==PENDING);return value;});
  await expect(f.api.pendingTag(f.assetId,{sha256:SHA})).rejects.toMatchObject({code:'PHOTO_TAG_RECONCILIATION_REQUIRED'});
});
