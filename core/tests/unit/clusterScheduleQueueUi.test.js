'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../public/js/cluster-schedule-queue.js'),'utf8');
function request(id,state,extra={}) {
  return {id,title:id,state,priority:5,kind:'diagnostic',hosts:['native-host'],source:{type:'coding'},
    createdAt:'2026-10-01T00:00:00Z',...extra};
}
async function ui(jobs) {
  let click;const container={innerHTML:'',addEventListener:(_name,handler)=>{click=handler;}};
  const writes=jest.fn(()=>{throw Error('Presentation must never launch a native write');});
  const queue={authority:'core.heavy-work-queue',jobs,archivedCount:4};
  const context=vm.createContext({document:{getElementById:id=>id==='heavyQueueList'?container:null,querySelector:()=>null},
    fetchJSON:async()=>queue,fetch:writes,formatEvidenceTime:value=>value,
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),console});
  vm.runInContext(source,context);await context.loadHeavyQueue();
  return {container,writes,ids:()=>[...container.innerHTML.matchAll(/data-queue-id="([^"]+)"/g)].map(match=>match[1]),
    click:action=>click({target:{closest:()=>({dataset:{queueAction:action}})}})};
}
test('a stale terminal result cannot displace current requests or unresolved runtime fences',async()=>{
  const jobs=[request('old-cancelled','cancelled',{priority:1}),request('waiting','requested',{priority:1}),
    request('running','running'),request('uncertain','uncertain',{priority:9}),
    request('reserved','reserved',{reservation:{start:'2099-01-01T00:00:00Z',end:'2099-01-01T01:00:00Z'}})];
  const original=JSON.stringify(jobs),view=await ui(jobs);
  expect(view.ids()).toEqual(['uncertain','running','reserved','waiting']);
  expect(view.container.innerHTML).toContain('À traiter · 4');
  expect(view.container.innerHTML).toContain('Terminées · 1');
  expect(JSON.stringify(jobs)).toBe(original);
  expect(view.writes).not.toHaveBeenCalled();
});
test('finished requests remain available with latest receipts first and active work is recoverable',async()=>{
  const view=await ui([request('older','completed',{finishedAt:'2026-10-01T00:00:00Z'}),
    request('latest','failed',{finishedAt:'2026-10-14T00:00:00Z'}),request('pending','requested')]);
  await view.click('finished');expect(view.ids()).toEqual(['latest','older']);
  await view.click('active');expect(view.ids()).toEqual(['pending']);
  expect(view.writes).not.toHaveBeenCalled();
});
test('pagination covers all pending requests and a view switch resets the page',async()=>{
  const view=await ui([...Array.from({length:12},(_,i)=>request('pending-'+i,'requested')),request('receipt','completed')]);
  expect(view.ids()).toHaveLength(10);await view.click('next');expect(view.ids()).toHaveLength(2);
  await view.click('finished');expect(view.ids()).toEqual(['receipt']);
  await view.click('active');expect(view.ids()).toHaveLength(10);
  expect(view.writes).not.toHaveBeenCalled();
});
test('expired unstarted reservations stay visible without displacing actionable slots',async()=>{
  const view=await ui([request('expired','reserved',{priority:1,reservation:{start:'2020-01-01T00:00:00Z',end:'2020-01-01T01:00:00Z'}}),
    request('<pending>','requested')]);
  expect(view.ids()).toEqual(['&lt;pending>','expired']);
  expect(view.container.innerHTML).toContain('window expired');
  await view.click('finished');expect(view.container.innerHTML).toContain('Aucune demande terminée');
  expect(view.writes).not.toHaveBeenCalled();
});
test('a reserved Profiler request says who starts it and offers Run now only inside its slot',async()=>{
  const open={start:new Date(Date.now()-60000).toISOString(),end:new Date(Date.now()+3600000).toISOString()};
  const later={start:new Date(Date.now()+3600000).toISOString(),end:new Date(Date.now()+7200000).toISOString()};
  const profile=(id,reservation)=>request(id,'reserved',{kind:'profiler',executor:{hostId:'fixture'},reservation});
  const view=await ui([profile('auto',{...later,autoStart:true}),profile('manual-open',{...open,autoStart:false}),
    profile('manual-later',{...later,autoStart:false}),request('custom','reserved',{reservation:open,executor:{mode:'operator'}})]);
  const card=id=>view.container.innerHTML.split('<article').find(part=>part.includes(`data-queue-id="${id}"`));
  expect(card('auto')).toContain('Starts automatically at its time');
  expect(card('auto')).not.toContain('data-queue-action="run"');
  expect(card('manual-open')).toContain('data-queue-action="run"');
  expect(card('manual-later')).toContain('Waits for you: use Run now during its slot');
  expect(card('manual-later')).not.toContain('data-queue-action="run"');
  expect(card('custom')).toContain('Started by its own executor');
  expect(card('custom')).not.toContain('data-queue-action="run"');
  expect(card('auto')).toContain('Change slot');
  expect(view.writes).not.toHaveBeenCalled();
});

test('an embedding reindex request offers Run now inside its slot, like a Profiler request',async()=>{
  const open={start:new Date(Date.now()-60000).toISOString(),end:new Date(Date.now()+3600000).toISOString(),autoStart:false};
  const view=await ui([request('reindex','reserved',{kind:'embedding-reindex',executor:{model:'qllama/bge-m3:f16',dimension:1024},reservation:open})]);
  const card=view.container.innerHTML.split('<article').find(part=>part.includes('data-queue-id="reindex"'));
  expect(card).toContain('data-queue-action="run"');
  expect(card).not.toContain('Started by its own executor');
});

test("a card names known hosts instead of raw Ollama URLs and keeps the URLs in its details",async()=>{
  const source=fs.readFileSync(path.join(__dirname,"../../public/js/cluster-schedule-queue.js"),"utf8");
  const container={innerHTML:"",addEventListener:()=>{}};
  const queue={authority:"core.heavy-work-queue",jobs:[request("named","requested",{hosts:["http://10.0.0.2:11434","http://10.0.0.9:3180"]})]};
  const context=vm.createContext({document:{getElementById:id=>id==="heavyQueueList"?container:null,querySelector:()=>null},
    fetchJSON:async()=>queue,formatEvidenceTime:value=>value,esc:value=>String(value??""),console,
    liveHostsData:[{id:"primary",name:"GPU A",url:"http://10.0.0.2:11434"}]});
  vm.runInContext(source,context);await context.loadHeavyQueue();
  const card=container.innerHTML.split("<details")[0];
  expect(card).toContain("GPU A, 10.0.0.9:3180");
  expect(container.innerHTML).toContain("Hôtes : http://10.0.0.2:11434, http://10.0.0.9:3180");
});
