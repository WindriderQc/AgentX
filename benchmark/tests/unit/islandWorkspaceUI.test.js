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
