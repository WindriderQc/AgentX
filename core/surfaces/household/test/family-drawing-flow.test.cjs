'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { setTimeout:sleep } = require('node:timers/promises');
const { journey } = require('./fixtures/family-drawing-router.cjs');
const core = resolve(__dirname + '/../../../..');
const routingRoot = core;
const { harness } = require(core + '/core/surfaces/household/test/fixtures/persona-journey.cjs');
const { createConversationImages } = require(core + '/core/surfaces/household/conversation-images');
const weather = 'Quelle température fait-il dehors ?';
const create = 'Dessine un bateau fictif drôle et joli.';
const ambiguous = 'Est-ce que tu peux me montrer une image d’un jeune homme ?';
const ordinary = 'Explique les nuages.';
const ordinaryReply = 'Les nuages sont faits de minuscules gouttes.';
const drawing = '<show kind="image" source="draw" title="Bateau">Un joli petit bateau rigolo et fictif sur un lac.</show>';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCecAAAAASUVORK5CYII=', 'base64');
const pngSha = createHash('sha256').update(png).digest('hex');
const opId = '12345678-1234-4123-8123-123456789abc';
const id = number => 'c2345678-1234-4123-8123-' + String(number).padStart(12, '0');

function fixture({ releaseAfter = 1246, grace = 1500, recovery = 'primary', refusal = 'active', acceptError = false, holdOrdinary = false, pictureOutput = drawing, busy = true, visuals = null, illustrated = false, beforeSettle, onFrame, failContext, configured = true, terminalAdmission, legacy = false, continuityAvailable = true, graceEnabled = true } = {}) {
  const images = {}, admitted = [], routes = new Map(), scopeReads = [], accepted = new Set();
  const ordinaryStarted=Promise.withResolvers(), ordinaryRelease=Promise.withResolvers();
  const policy = journey({ root:routingRoot, weather, create, drawing:pictureOutput, ordinary, ordinaryReply, releaseAfter, recovery, refusal, busy,
    whenOrdinary:async()=>{ ordinaryStarted.resolve(); if(holdOrdinary) await ordinaryRelease.promise; } });
  const world = harness({
    packId:'kidx_nestor', backend:'agentx', conversationImages:images, visuals,
    validClientTurnId:x=>typeof x==='string' && x.length===36, continuityExecute:continuityAvailable ? policy.runContinuity : undefined, failContext,
    conversationEnv:{ HOUSEHOLD_CONVERSATION_RELAY_ENABLED:legacy ? 'false' : 'true', HOUSEHOLD_PRIMARY_RELEASE_GRACE_ENABLED:graceEnabled ? 'true' : 'false',
      HOUSEHOLD_PRIMARY_RELEASE_GRACE_MS:String(grace) }, response:legacy || !continuityAvailable ? drawing : 'UNEXPECTED BASE EXECUTION'
  });
  // Keep router config process-global only for the real run (production reads config via call options, not trust of user input).
  const scoped = { surface:'household', sessionId:world.session.sessionId, packId:'kidx_nestor', scopeId:'family' };
  let operation;
  const service = {
    status:()=>({configured,conversationProfile:{id:'klein-fast',width:1024,height:1024},
      ...(illustrated && {illustrated:{worker:'fixture',profile:'klein-fast',spaces:['family']}})}),
    listForConversation:async scope=> { assert.deepEqual(scope,scoped); return operation ? [operation] : []; },
    accept:async(request, options)=>{
      admitted.push({request,options});
      assert.deepEqual(options.conversation,scoped);
      if(acceptError==='unknown') throw Error('Synthetic transport error without acknowledgement');
      operation={id:opId,state:terminalAdmission || 'queued',runtimeRestored:false};
      if(acceptError==='after_insert') {
        operation.state='unknown';
        throw Object.assign(Error('Enrolment unavailable after durable insert'),{statusCode:503});
      }
      return operation;
    },
    getForConversation:async (identifier, scope)=>{
      scopeReads.push(scope);
      if(identifier!==opId || !operation || JSON.stringify(scope)!==JSON.stringify(scoped))
        throw Object.assign(Error('fixture unknown'),{statusCode:404});
      return operation;
    },
    image:async()=>({mimeType:'image/png',bytes:png})
  };
  Object.assign(images,createConversationImages({conversations:world.conversations,service,logger:{info(){}}}));
  const add=(method, pattern, fn)=>routes.set(method+' '+pattern,fn);
  images.register({ get:(p,f)=>add('GET',p,f),post:(p,f)=>add('POST',p,f), delete:(p,f)=>add('DELETE',p,f), patch:(p,f)=>add('PATCH',p,f) });
  world.conversations.acceptTurn = async row=>{
    const key=[row.sessionId,row.packId,row.scopeId,row.clientTurnId].join(':');
    const duplicate=accepted.has(key); accepted.add(key); return {duplicate};
  };
  world.conversations.settleTurn=async row=>{ await beforeSettle?.(row); return world.conversations.recordTurn(row); };
  const turn=async (text,turnId,extra={})=>{
    const frames=[];
    const res={on(){},removeListener(){},headersSent:false,writableEnded:false,
      status(){return this;},set(){return this;},write(value){this.headersSent=true;const frame=JSON.parse(value);frames.push(frame);onFrame?.(frame);},
      end(){this.writableEnded=true;}};
    const started=Date.now();
    await world.handle({params:{sessionId:world.session.sessionId},body:{text,channel:'voice',stream:true,turnId,...extra}},res,
      'child',{browser:true,packId:'kidx_nestor',modeId:world.session.modeId,scopeId:'family'});
    return {frames,result:frames.find(x=>x.type==='done')?.data||res.payload,failure:res.failure,ms:Date.now()-started};
  };
  const route=async (suffix='/:id', scope='family', identifier=opId)=>{
    const response={statusCode:200,set(){return this;}, status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;},send(b){this.body=b;return this;}};
    const handler=routes.get('GET /'+scope+'/sessions/:sessionId/images'+suffix);
    await handler({params:{sessionId:scoped.sessionId,id:identifier}}, response);
    return response;
  };
  return { ...world, ...policy, admitted, turn, route, scopeReads, routes, ordinaryStarted:ordinaryStarted.promise, releaseOrdinary:ordinaryRelease.resolve, ready(){
    operation={...operation,state:'completed',runtimeRestored:true,artifact:{sha256:pngSha}};
  }, fail(){ operation={...operation,state:'failed',runtimeRestored:true,error:'Synthetic render error'}; }};
}
function syntheticRenderer(world) {
  const root={}, holders=[], keys=new Set(), network=[];
  const document={createElement(tag){
    const listeners=new Map();
    return {tag,children:[],isConnected:true,setAttribute(){},append(...nodes){this.children.push(...nodes);},
      addEventListener(name,cb){listeners.set(name,cb);},dispatch(name){listeners.get(name)?.();},
      replaceChildren(...nodes){this.children=nodes;},remove(){this.isConnected=false;}};
  }};
  const fetcher=async url=>{
    network.push(url);
    const p=url.endsWith('/images') ? '' : '/:id';
    const res=await world.route(p);
    return {ok:res.statusCode===200,status:res.statusCode,json:async()=>res.body};
  };
  runInNewContext(readFileSync(core+'/core/surfaces/household/public/conversation-images.js','utf8'),
    {window:root,document,AbortController,AbortSignal,setTimeout,clearTimeout});
  const images=root.ConversationImages;
  const board={has:key=>keys.has(key),add:block=>{keys.add(block.key);holders.push(images.create(block,{space:'family',fetcher,delay:2}));}};
  return { images, board, holders, network, fetcher };
}
const assertNoLeak = result=>assert.doesNotMatch(JSON.stringify(result), /fixture-owner-private|fixture-owner-other-model|fixture-primary\.invalid|fixture-backup\.invalid/);

test('same Family voice session: weather → primary waits and clears +1.25s → one queued drawing → next ordinary turn while image active → ready artifact',{timeout:8000},async()=>{
  const h=fixture({holdOrdinary:true});
  const weatherTurn=await h.turn(weather,id(1));
  assert.match(weatherTurn.result?.reply.text,/quatre degrés/);
  const pic=await h.turn(create,id(2));
  assert.match(pic.result?.reply.text,/file d’attente/);
  assert.ok(pic.ms>=1170,'must not retry ahead of the synthetic release notification');
  assert.ok(h.db.length>0 && h.db.length<=2,'scoped release proof lookups stay bounded');
  assert.equal(pic.result.display[0].operation.id,opId);
  assert.equal(pic.frames.filter(x=>x.type==='show').length,1);
  assert.equal(pic.result.familyDrawing,true);
  assert.deepEqual(pic.frames.filter(x=>['delta','say_end','show','done'].includes(x.type)).map(x=>x.type),
    ['delta','say_end','show','done']);
  assert.equal(pic.frames.find(x=>x.type==='delta').delta,pic.result.reply.text);
  assert.equal(pic.frames.filter(x=>x.type==='status'&&x.phase==='waiting_host').length,1);
  assert.equal(h.admitted.length,1);
  assert.equal(h.admitted[0].request.profile, 'klein-fast');
  assert.match(h.admitted[0].request.prompt, /petit bateau rigolo/);
  assert.deepEqual(h.requests.map(x=>x.role),['primary','primary','primary']);
  assert.deepEqual(h.dispatches.map(x=>x.role),['primary','primary']);
  assert.equal((await h.route()).body.operation.state,'queued');
  assert.equal((await h.route('/:id/image')).statusCode,409);
  const normal=h.turn(ordinary,id(3));
  await h.ordinaryStarted;
  assert.equal((await h.route()).body.operation.state,'queued','ordinary inference entered while its earlier drawing was still queued');
  const browser=syntheticRenderer(h);
  const base='/api/voice-personas/family/sessions/synthetic-session';
  const card=pic.frames.find(x=>x.type==='show').block;
  assert.equal(browser.images.addExplicit(base, card, browser.board),true);
  assert.equal(browser.images.addExplicit(base, pic.result.display[0], browser.board),true);
  assert.equal(browser.holders.length,1);
  assert.match(browser.holders[0].children[0].textContent,/waiting its turn/);
  assert.equal(browser.holders[0]._presentationState(),'loading');
  h.ready();
  const ready=await h.route();
  assert.equal(ready.body.operation.state,'completed');
  assert.equal(ready.body.operation.runtimeRestored,true);
  assert.match(ready.body.operation.artifact.url,/\/family\/sessions\/synthetic-session\/images\//);
  const bytes = await h.route('/:id/image');
  assert.equal(bytes.statusCode,200); assert.deepEqual(bytes.body,png);
  assert.equal(ready.body.operation.artifact.sha256,pngSha);
  const holder=browser.holders[0];
  for(let i=0;i<100 && holder.children.length===1;i++) await sleep(2);
  assert.equal(holder.children.length,2);
  assert.equal(holder._presentationState(),'loading');
  const tag=holder.children[1].children[0];
  assert.equal(tag.tag,'img');
  assert.equal(tag.src,ready.body.operation.artifact.url);
  tag.dispatch('load');
  assert.equal(holder._presentationState(),'visible');
  assert.equal(browser.network.length,1);
  await browser.images.resume(base, block=>browser.images.addExplicit(base,block,browser.board), {fetcher:browser.fetcher});
  assert.equal(browser.holders.length,1);
  assert.match(browser.network.at(-1),/\/images$/);
  holder._dispose();
  h.releaseOrdinary();
  const next=await normal;
  assert.match(next.result?.reply.text,/minuscules gouttes/);
  assert.equal(h.dispatches.at(-1).role,'primary');
  assert.equal((await h.turn(create,id(2))).result?.replayed,false);
  assert.equal(h.admitted.length,1);
  assert.equal((await h.route('/:id','private')).statusCode,404);
  assert.equal((await h.route('/:id','family',id(9))).statusCode,404);
  assert.equal(h.routes.has('POST /family/sessions/:sessionId/images'),false);
  assertNoLeak([weatherTurn,pic,next,ready.body]);
});

test('sustained busy is truthful no queue, with no guardian or hidden fallback; ambiguity has no lookup or presentation',async()=>{
  const h=fixture({ releaseAfter:-1, grace:400 });
  const picture=await h.turn(create,id(1));
  assert.match(picture.result?.reply.text,/Aucune image n’a été lancée/);
  assert.equal(picture.frames.some(x=>x.type==='show'),false);
  assert.deepEqual(h.requests.map(x=>x.role),['primary']);
  assert.deepEqual(h.dispatches,[]);
  assert.equal(h.admitted.length,0);
  const exact=await h.turn(ambiguous,id(2));
  assert.match(exact.result?.reply.text,/catalogue d’images publiques|source publique.*approuvée/);
  assert.equal(exact.frames.some(x=>x.type==='show'),false);
  assert.equal(h.admitted.length,0);
  assert.equal(h.requests.length,1);
  assert.equal(h.sent.length,0);
  assertNoLeak([picture,exact]);
  assert.match((await h.turn(ordinary,id(3))).result?.reply.text,/minuscules gouttes/);
});

test('ambiguous infrastructure outcome does not start Gardien, retry a third time, or admit an image',async()=>{
  const h=fixture({ releaseAfter:0, recovery:'ambiguous' });
  const pic=await h.turn(create,id(1));
  assert.match(pic.result?.reply.text,/Aucune image n’a été lancée/);
  assert.equal(h.admitted.length,0);
  assert.deepEqual(h.requests.map(x=>x.role),['primary','primary']);
  assert.deepEqual(h.dispatches,[]);
  assertNoLeak(pic);
});

test('free primary: no draw marker, shortened marker, or raw premature promise never starts an image',async()=>{
  for(const pictureOutput of ['SENTINEL-MODEL: Ton dessin est prêt.', drawing.replace('</show>','')]) {
    const h=fixture({busy:false,pictureOutput});
    const result=await h.turn(create,id(4));
    assert.match(result.result?.reply.text,/Aucune image n’a été lancée/);
    assert.doesNotMatch(JSON.stringify(result),/SENTINEL-MODEL|Ton dessin est prêt/);
    assert.equal(h.admitted.length,0);
    assert.equal(result.frames.some(x=>x.type==='show'),false);
    assert.deepEqual(h.dispatches.map(x=>x.role),['primary']);
  }
});

test('local refusal, lost accept after insertion and opaque transport failure remain distinct and never retry',async()=>{
  const refused=fixture({busy:false,configured:false});
  assert.match((await refused.turn(create,id(5))).result?.reply.text,/Aucune image n’a été lancée/);
  assert.equal(refused.admitted.length,0);
  for(const acceptError of ['after_insert','unknown']) {
    const h=fixture({busy:false,acceptError});
    const result=await h.turn(create,id(5));
    assert.match(result.result?.reply.text,/pas pu vérifier.*ne vais pas en lancer un autre/);
    assert.doesNotMatch(result.result?.reply.text,/attente|dessin est prêt|Aucune image n’a été lancée/);
    assert.equal(h.admitted.length,1);
    assert.equal(result.frames.some(x=>x.type==='show'&&x.block.operation?.id),false);
    assert.equal((await h.route()).statusCode,acceptError==='after_insert' ? 200 : 404);
    assert.equal((await h.turn(create,id(5))).result?.replayed,false);
    assert.equal(h.admitted.length,1);
  }
});

test('known failed, cancelled and archive_failed receipts do not deny dispatch',async()=>{
  for(const [state,phrase] of [['failed',/a échoué/],['cancelled',/a été annulée/],['archive_failed',/pas pu être enregistré/]]) {
    const h=fixture({busy:false,terminalAdmission:state});
    const result=await h.turn(create,id(7));
    assert.match(result.result?.reply.text,phrase);
    assert.doesNotMatch(result.result?.reply.text,/Aucune image n’a été lancée|file d’attente/);
    assert.equal(result.result.display[0].operation.state,state);
    assert.equal(h.admitted.length,1);
  }
});

test('later render failure remains a failed scoped receipt, never shows pixels, ordinary next reply works',async()=>{
  const h=fixture({busy:false});
  const result=await h.turn(create,id(6));
  assert.match(result.result?.reply.text,/file d’attente/);
  const renderer=syntheticRenderer(h), base='/api/voice-personas/family/sessions/synthetic-session';
  renderer.images.addExplicit(base, result.frames.find(x=>x.type==='show').block, renderer.board);
  h.fail();
  const status=await h.route();
  assert.equal(status.body.operation.state,'failed');
  assert.equal((await h.route('/:id/image')).statusCode,409);
  const view=renderer.holders[0];
  for(let i=0;i<100 && /waiting/.test(view.children[0].textContent);i++) await sleep(2);
  assert.equal(view.children.some(x=>x.children.some(child=>child.tag==='img')),false);
  assert.notEqual(view._presentationState(),'visible');
  view._dispose();
  assert.match((await h.turn(ordinary,id(7))).result?.reply.text,/minuscules gouttes/);
  assert.equal(h.admitted.length,1);
});

test('#1553 known public animal lookup stays separate from explicit creation',async()=>{
  const searches=[];
  const h=fixture({busy:false,visuals:{sources:()=>['web'],present:async(block,options)=>{
    searches.push({block,options});
    return {...block,status:'found',image:{url:'/synthetic/fox.png'}};
  }}});
  const found=await h.turn('Peux-tu me montrer une image de renard ?',id(8));
  assert.match(found.result?.reply.text,/trouvé une image/);
  assert.equal(searches.length,1);
  assert.equal(searches[0].options.exactSource,true);
  assert.match(searches[0].block.body,/renard/i);
  assert.deepEqual(h.dispatches,[]); assert.deepEqual(h.admitted,[]);
  const draw=await h.turn(create,id(9));
  assert.match(draw.result?.reply.text,/file d’attente/);
  assert.equal(searches.length,1); assert.equal(h.admitted.length,1);
});

test('qualified explicit draw does not request contextual scenes even if old mode is configured',async()=>{
  const h=fixture({busy:false,illustrated:true});
  const result=await h.turn(create,id(10));
  assert.match(result.result?.reply.text,/file d’attente/);
  assert.ok(h.requests[0].system.includes('exactly one complete source="draw"'));
  assert.doesNotMatch(h.requests[0].system,/Illustrated mode is on|source="scene"/);
  assert.equal(h.admitted.length,1);
});

test('voice acknowledgment follows verified acceptance but precedes durable turn closure',async()=>{
  const entered=Promise.withResolvers(), finish=Promise.withResolvers(), events=[];
  const h=fixture({busy:false,beforeSettle:async()=>{entered.resolve(); await finish.promise;},onFrame:frame=>events.push(frame)});
  const pending=h.turn(create,id(1));
  try {
    await entered.promise;
    assert.equal(h.admitted.length,1);
    assert.deepEqual(events.filter(x=>['delta','say_end','show','done'].includes(x.type)).map(x=>x.type),['delta','say_end','show']);
    assert.match(events.find(x=>x.type==='delta').delta,/file d’attente/);
  } finally {finish.resolve();}
  assert.equal((await pending).result.familyDrawing,true);
});

test('typing is not reclassified as a qualified voice drawing',async()=>{
  const h=fixture({busy:false,pictureOutput:'Une réponse fictive sans demande de génération.'});
  const typed=await h.turn(create,id(1),{channel:'text'});
  assert.notEqual(typed.result?.familyDrawing,true);
  assert.equal(h.admitted.length,0);
});

test('qualified drawing works while all irrelevant context dependencies reject', async ctx=>{
  const unavailable=()=>assert.fail('Irrelevant context cannot be read by a qualified drawing');
  const h=fixture({busy:false,failContext:unavailable});
  h.conversations.listTurns=unavailable;
  const spies=[
    ctx.mock.method(require('../family-pages'),'forTurn',unavailable),
    ctx.mock.method(require('../nestor-knowledge'),'retrieve',unavailable),
    ctx.mock.method(require('../living-source-context'),'prepareLivingSourceContext',unavailable)
  ];
  const result=await h.turn(create,id(3));
  assert.match(result.result?.reply.text,/file d’attente/);
  assert.equal(result.result.familyDrawing,true);
  assert.equal(h.admitted.length,1);
  for(const spy of spies)assert.equal(spy.mock.callCount(),0);
});

test('relay disabled or unavailable leaves direct legacy drawing behavior intact',async()=>{
  for(const choice of [{legacy:true},{continuityAvailable:false}]) {
    const h=fixture({busy:false,...choice});
    const result=await h.turn(create,id(4));
    assert.notEqual(result.result?.familyDrawing,true);
    assert.equal(result.result?.display[0].operation.state,'queued');
    assert.equal(h.admitted.length,1);
    assert.equal(h.dispatches.length,0);
  }
});

test('optional near-release grace off makes no busy retry but does not disable verified dedicated primary',async()=>{
  const free=fixture({busy:false,graceEnabled:false});
  assert.match((await free.turn(create,id(1))).result?.reply.text,/file d’attente/);
  const held=fixture({busy:true,graceEnabled:false});
  assert.match((await held.turn(create,id(1))).result?.reply.text,/Aucune image n’a été lancée/);
  assert.deepEqual(held.requests.map(row=>row.role),['primary']);
  assert.equal(held.admitted.length,0);
});
