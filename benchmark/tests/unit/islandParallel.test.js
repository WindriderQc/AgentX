
'use strict';
const { islandViews } = require('../../src/services/island/islandViews');
const { islandWorlds } = require('../../src/services/island/islandWorlds');
const { loadBrowserModule } = require('../helpers/browserModule');
const ID = '00000000-0000-4000-8000-0000000000a7';
const living = {id:'living', label:'Île vivante', live:'https://new.lan', replayOrigins:['https://old.lan']};
const env = {AGENTX_ISLAND_GRAPHYSX_URL:'https://viewer.lan/',AGENTX_ISLAND_WORLDS:JSON.stringify([living])};
const run = {id:ID,world:'living',agent:'Eko',worldView:{kind:'remote',instanceId:ID,recordingId:ID}};
it('keeps an archive on its configured original service after a live terrain moves', async () => {
  const fetchImpl=jest.fn(async url => url.startsWith('https://new.lan') ? {ok:false,status:404} : {ok:true,json:async()=>({replay:true,instanceId:ID})});
  const opened=await islandViews(env).replayUrl(run,{fetchImpl});
  expect(new URL(opened.src).searchParams.get('source')).toBe(`https://old.lan/recordings/${ID}`);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(new URL(islandViews(env).worldUrl(living)).searchParams.get('source')).toBe('https://new.lan');
});
it('never masks identity collisions and never fetches an origin supplied by a run', async () => {
  const fetchImpl=jest.fn(async()=>({ok:true,json:async()=>({replay:true,instanceId:'other'})}));
  await expect(islandViews(env).replayUrl({...run,worldView:{...run.worldView,url:'https://evil.lan'}},{fetchImpl})).rejects.toMatchObject({statusCode:409});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/new.lan/);
});
it.each([['https://u:p@old.lan'],['https://old.lan/encoded%2Fpath'],['ftp://old.lan'],'https://old.lan',Array(5).fill('https://old.lan')])('refuses unsafe or unbounded archive origin configuration (%j)', replayOrigins=>{
 expect(islandWorlds({...env,AGENTX_ISLAND_WORLDS:JSON.stringify([{...living,replayOrigins}])}).error).toMatch(/replay origins/);
});
const page=loadBrowserModule('island/index.js','worldCardHtml');
const live={available:true,selectedActive:true,instanceId:ID,recordingState:'recording'};
it('distinguishes a live world without players, queued requests and an actual verified player',()=>{
 const idle=page.worldCardHtml(living,live,[{...run,state:'requested'}],true);
 expect(idle).toContain('En direct');expect(idle).toContain('Aucune partie en cours');expect(idle).toContain('1 demande en attente');
 expect(page.worldCardHtml(living,live,[{...run,state:'running',phase:'running'}],true)).toContain('Eko joue ici');
 expect(page.worldCardHtml(living,live,[{...run,state:'completed',phase:'running'}],true)).toContain('Aucune partie en cours');
 expect(page.worldCardHtml(living,live,[{...run,state:'running',worldView:{instanceId:'other'}}],true)).toContain('Aucune partie en cours');
 expect(page.worldCardHtml(living,live,[run],false)).toContain('État des parties indisponible');
});
it('keeps offline/mismatched cards visible without an enabled misleading watch button and escapes names',()=>{
 const html=page.worldCardHtml({...living,label:'<img>'},{...live,selectedActive:false,activeWorld:{label:'Mesa'}},[],true);
 expect(html).toContain('Ce service héberge Mesa');expect(html).toContain(' disabled');expect(html).not.toContain('<img>');
 expect(page.worldCardHtml(living,null,[],true)).toContain('Connexion indisponible');
});

it('preserves a configured literal service prefix for health, live and replay paths', async()=>{
 const prefix={...living,live:'https://new.lan/worlds/living/'};
 const conf={...env,AGENTX_ISLAND_WORLDS:JSON.stringify([prefix])};
 expect(islandWorlds(conf).worlds[0].live).toBe('https://new.lan/worlds/living');
 const fetchImpl=jest.fn(async()=>({ok:true,json:async()=>({replay:true,instanceId:ID})}));
 const opened=await islandViews(conf).replayUrl(run,{fetchImpl});
 expect(new URL(opened.src).searchParams.get('source')).toBe(`https://new.lan/worlds/living/recordings/${ID}`);
 expect(fetchImpl.mock.calls[0][0]).toBe(`https://new.lan/worlds/living/recordings/${ID}/healthz`);
});
