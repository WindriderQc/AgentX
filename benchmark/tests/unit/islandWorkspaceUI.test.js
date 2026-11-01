'use strict';
const fs = require('fs');
const path = require('path');
const { loadBrowserModule } = require('../helpers/browserModule');
const helpers = loadBrowserModule('island/index.js', 'stateLabel, isIslandMemoryRequest', { URL });
it.each(['completed', 'failed', 'cancelled'])('terminal %s receipt wins over a stale running phase when Core is unavailable', state => {
  expect(helpers.stateLabel({phase:'running',receipt:{state}}).key).toBe(state);
  expect(helpers.stateLabel({phase:'running',queue:{state},state:'running'}).key).toBe(state);
});
it('accepts a memory request only from the displayed viewer and its bound run', () => {
  const frame = {src:'https://viewer.lan/?app=island',contentWindow:{}};
  const event = {source:frame.contentWindow,origin:'https://viewer.lan',data:{type:'graphysx:island:memory',runId:'one'}};
  expect(helpers.isIslandMemoryRequest(event,frame,'one')).toBe(true);
  for(const changed of [{source:{}},{origin:'https://other.lan'},{data:{...event.data,runId:'two'}},{data:{type:'other'}}]) {
    expect(helpers.isIslandMemoryRequest({...event,...changed},frame,'one')).toBe(false);
  }
  expect(helpers.isIslandMemoryRequest(event,frame,null)).toBe(false);
});
it('renders each of four memory files and identifies a missing/truncated capture without claiming replay synchronization', async () => {
  const names=['SOUL.md','EPISODIC_MEMORY.md','EPISODIC_MEMORY.jsonl','SEMANTIC_MEMORY.md'];
  const tabs=names.map(name=>({dataset:{file:name},setAttribute(){}}));
  const nodes={ 'island-memory-body': {setAttribute(){}},'island-memory-provenance':{},'island-memory-run':{},'island-memory':{scrollIntoView(){}} };
  const files=Object.fromEntries(names.map(name=>[name,{text:name==='EPISODIC_MEMORY.jsonl'?'not JSON':`<${name}>`,bytes:100,truncated:true}]));
  const page=loadBrowserModule('island/index.js','openMemory, showMemoryFile',{
    apiFetch:async()=>({data:{files,runs:[]}}),document:{getElementById:id=>nodes[id],querySelectorAll:()=>tabs}
  });
  await page.openMemory('one');
  expect(nodes['island-memory-provenance'].textContent).toContain('ne sont pas synchronisés');
  for(const name of names){page.showMemoryFile(name);expect(nodes['island-memory-body'].innerHTML).toContain('100 octets');}
  files['EPISODIC_MEMORY.md']={missing:true};page.showMemoryFile('EPISODIC_MEMORY.md');
  expect(nodes['island-memory-body'].innerHTML).toContain('Fichier absent');
  expect(fs.readFileSync(path.join(__dirname,'../../views/pages/island.ejs'),'utf8')).toContain('data-file="EPISODIC_MEMORY.md"');
});


describe('historical journal lifecycle', () => {
  function fixture(apiFetch) {
    const nodes = Object.fromEntries(['island-thoughts','island-thoughts-title','island-thoughts-note','island-thoughts-list','island-thoughts-retry'].map(id => [id, {hidden:true,innerHTML:'old journal',textContent:''}]));
    const intervals = jest.fn(), clear = jest.fn();
    const page = loadBrowserModule('island/index.js', 'followThoughts, setViewerRun: id => { viewerRun = id; }', {
      apiFetch, setInterval:intervals, clearInterval:clear,
      document:{getElementById:id=>nodes[id]}
    });
    page.setViewerRun('one');
    return {page,nodes,intervals};
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));
  it('loads a recorded snapshot once, labels it honestly, and escapes every message field', async () => {
    const api = jest.fn(async()=>({data:{phase:'running',agentMessages:[{kind:'thought',at:'2026-01-01T00:00:00Z',text:'<img src=x onerror=alert(1)> & secret'},{kind:'command',at:'bad"date',text:'<script>bad()</script>'}]}}));
    const {page,nodes,intervals} = fixture(api);
    page.followThoughts('one',true);
    expect(nodes['island-thoughts-list'].innerHTML).toBe('');
    expect(nodes['island-thoughts-note'].textContent).toContain('chargement');
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(intervals).not.toHaveBeenCalled();
    expect(nodes['island-thoughts'].hidden).toBe(false);
    expect(nodes['island-thoughts-title'].textContent).toBe('Journal enregistré — non synchronisé avec la lecture');
    expect(nodes['island-thoughts-list'].innerHTML).toContain('&lt;img');
    expect(nodes['island-thoughts-list'].innerHTML).not.toContain('<script>');
    expect(nodes['island-thoughts-list'].innerHTML).toContain('bad&quot;date');
    expect(nodes['island-thoughts-retry'].hidden).toBe(true);
  });
  it.each([[],undefined])('identifies an absent recorded journal without inventing entries: %p', async messages => {
    const {page,nodes} = fixture(async()=>({data:{state:'completed',agentMessages:messages}}));
    page.followThoughts('one',true); await flush();
    expect(nodes['island-thoughts-list'].innerHTML).toContain('Aucune entrée enregistrée');
  });
  it.each(['close','switch','reopen'])('ignores a late response after %s', async action => {
    let resolve;
    const api = jest.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue({data:{agentMessages:[{kind:'thought',text:'current journal'}]}});
    const {page,nodes} = fixture(api);
    page.followThoughts('one',true);
    if(action==='close'){page.setViewerRun(null);page.followThoughts(null);}
    else {page.setViewerRun(action==='switch'?'two':'one');page.followThoughts(action==='switch'?'two':'one',true);}
    await flush();
    resolve({data:{agentMessages:[{kind:'thought',text:'STALE JOURNAL'}]}});await flush();
    expect(nodes['island-thoughts-list'].innerHTML).not.toContain('STALE JOURNAL');
    if(action==='close')expect(nodes['island-thoughts'].hidden).toBe(true);
    else expect(nodes['island-thoughts-list'].innerHTML).toContain('current journal');
  });
  it('shows a retryable error and clears it when the journal succeeds', async () => {
    const api = jest.fn().mockRejectedValueOnce(new Error('<unavailable>')).mockResolvedValue({data:{agentMessages:[{kind:'thought',text:'recovered'}]}});
    const {page,nodes} = fixture(api);
    page.followThoughts('one',true); await flush();
    expect(nodes['island-thoughts'].hidden).toBe(false);
    expect(nodes['island-thoughts-note'].textContent).toContain('lecture impossible : <unavailable>');
    expect(nodes['island-thoughts-retry'].hidden).toBe(false);
    page.followThoughts('one',true); await flush();
    expect(nodes['island-thoughts-retry'].hidden).toBe(true);
    expect(nodes['island-thoughts-note'].textContent).toBe('');
    expect(nodes['island-thoughts-list'].innerHTML).toContain('recovered');
  });
  it('retains polling for a live run and cancels it when changing to history', async () => {
    const {page,intervals} = fixture(async()=>({data:{state:'running',agentMessages:[]}}));
    page.followThoughts('one'); await flush();
    expect(intervals).toHaveBeenCalledTimes(1);
    page.followThoughts('one',true);await flush();
    expect(intervals).toHaveBeenCalledTimes(1);
  });
});
