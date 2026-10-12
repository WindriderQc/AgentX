'use strict';
window.ImageWorkshopLedger = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stamp = value => new Date(value).toLocaleString('en-US', {timeZone:'America/Toronto'});
  const time = value => value == null ? 'Not measured' : `${Number(value).toLocaleString('en-US', {maximumFractionDigits:1})} s`;
  const link = (href, text) => `<a class="link" href="${esc(href)}">${esc(text)} ↗</a>`;
  const labels = {scenes:'Scenes / kids',edition:'Edits',logos:'Logos / docs',textures:'Textures / paint jobs',performance:'GPU setups'};
  let filter = 'all', search = '', sort = 'group', lastData;

  function apply(data, ledger) {
    data.ready = ledger;
    if (!ledger) return data;
    data.performance.renders = ledger.performance.rendus;
    data.performance.lots = ledger.performance.lots;
    data.performance.failed = ledger.performance.echecs;
    data.performance.humanScope = 'K04, K01 and K05 finishes received; U06 received for appearance, with a counting defect.';
    data.sessions = [
      {title:'Shared AgentX roadmap',owner:'Nestor · voice · code · images',state:'active',label:'Next batch: '+ledger.unifiedPlan.nextPriority,description:ledger.unifiedPlan.orderPolicy,updatedAt:ledger.updatedAtUtc,view:'plan'},
      {title:'Performance / MAX',owner:'Performance support',state:'delivered',label:'118 renders · campaign closed',description:'One card, two cards and two workers measured; 16 MP finishes received on four briefs, with compliance limits.',updatedAt:ledger.updatedAtUtc,view:'recipes'},
      {title:'Logos and textures',owner:'Workshop + Yanik',state:'delivered',label:'Assets received',description:'Logo V1 and A4 on screen. Texture, atlas and five views received; GraphysX product import separate.',updatedAt:ledger.updatedAtUtc,view:'recipes'},
      {title:'Targeted exploration',owner:'Exploration support',state:'delivered',label:'B1, B2, C1, D1 and three P8 pots',description:'Consistency: pot on three seeds and copper received at 1216 × 896; other uses/HQ open. Extraction and material received. P8 multi-reference stopped and released.',updatedAt:ledger.updatedAtUtc,view:'plan'},
      {title:'Copper and text edits',owner:'Workshop + Yanik',state:'delivered',label:'6 / 6 renders received',description:'Qwen 40, Klein KV4 and Viggle6 on the same reference. The feedback stays attached to the files.',updatedAt:ledger.updatedAtUtc,view:'compare',group:'e02'}
    ];
    data.exploration.gpuExecuted = true;
    data.roadmap = ledger.tasks.map(t => ({...t,lane:t.state==='done'?'acquis':t.state==='optional'?'exploration':'prochain',state:{done:'Delivered',open:'To finish',external:'Product reception pending',prepared:'Integration prepared',paused:'GPU trials deferred',optional:'Deferred option'}[t.state],next:t.detail,view:'plan'}));
    data.revision += ':' + ledger.updatedAtUtc;
    return data;
  }

  function unavailable() {
    return '<div class="page-head"><h1>The reconciliation folder is unavailable.</h1><p>The historical comparisons stay viewable. Try again with ↻.</p></div>';
  }

  function renderRecipes(data) {
    lastData = data;
    const l = data.ready;
    if (!l) return unavailable();
    return `<div class="page-head"><div><span class="eyebrow">FROM BRIEF TO ASSET</span><h1>A recipe for each use.</h1><p>Receptions on specific files, archived graphs and finishes. The lab’s capabilities keep their integration status.</p></div>${link('/images','Open the current workshop')}</div>
      <div class="ready-notice"><strong>Work without GPU</strong><p>This cockpit views and exports the evidence. Preparing a folder here starts no generation.</p><small>Reconciliation: ${stamp(l.updatedAtUtc)} · ${l.verified.originals} originals verified · ${l.verified.graphs} graphs checked offline.</small></div>
      <div class="recipe-grid">${l.workflows.map(w => `<article class="recipe-card" id="recipe-${w.id}"><div class="recipe-top"><span class="eyebrow">${esc(labels[w.usage])}</span><span class="badge ${w.live?'green':'purple'}">${w.live?'Available in the workshop':'Lab · integration to do'}</span></div><h2>${esc(w.title)}</h2><dl><dt>Models</dt><dd>${esc(w.model)}</dd><dt>Host / GPU</dt><dd>${esc(w.host)}</dd><dt>Settings / quality</dt><dd>${esc(w.quality)}</dd><dt>Dimensions</dt><dd>${esc(w.dimensions)}</dd></dl><ol class="recipe-stages">${w.stages.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><details><summary>Evidence and limits of this recipe</summary><ul>${w.limits.map(s=>`<li>${esc(s)}</li>`).join('')}</ul><div class="group-top-actions">${w.groups.filter(id=>data.groups.some(g=>g.id===id)).map(id=>link('#compare?group='+id,data.groups.find(g=>g.id===id).title)).join('')}</div></details><p class="recipe-next"><strong>Next validation</strong><br>${esc(w.next)}</p><div class="group-top-actions">${link(w.dossier,'JSON sheet')}${link(w.bundle,'ZIP folder')}</div></article>`).join('')}</div>
      <section class="ready-section"><span class="eyebrow">ALL FILES IN ONE PLACE</span><h2>Compare settings, timings and feedback.</h2><div class="ready-controls"><label>Use<select id="ready-filter"><option value="all">All uses</option>${Object.entries(labels).map(([id,text])=>`<option value="${id}" ${filter===id?'selected':''}>${text}</option>`).join('')}</select></label><label>Search<input id="ready-search" type="search" placeholder="Model, host, file…" value="${esc(search)}"></label><label>Sort<select id="ready-sort"><option value="group" ${sort==='group'?'selected':''}>Comparison</option><option value="time" ${sort==='time'?'selected':''}>Generation time</option><option value="pixels" ${sort==='pixels'?'selected':''}>Resolution</option></select></label>${link('/images/labo/lab-resources/ready/comparison.csv','Export CSV')}</div><p id="ready-count" role="status"></p><div class="table-wrap"><table class="ready-table"><thead><tr><th>File / comparison</th><th>Model / host</th><th>Native dimensions</th><th>Steps / seed</th><th>Generation / archive</th><th>Feedback / status</th><th>Evidence</th></tr></thead><tbody id="ready-rows">${rows(l)}</tbody></table></div></section>
      <section class="ready-section"><span class="eyebrow">FINISHES AND NATIVES</span><h2>MAX: the passes around 16 MP.</h2><p>These rows separate render time from batch time. The durable archive of the originals is on the Media share. A total up to human reception was not timed.</p><div class="table-wrap"><table class="ready-table"><thead><tr><th>Case / seed</th><th>Pass</th><th>Dimensions</th><th>Generation</th><th>Archive</th><th>Batch restoration</th><th>Reception</th><th>Evidence</th></tr></thead><tbody>${l.maxRuns.map(r=>`<tr><td>${esc(r.case)} / ${r.seed}</td><td>${r.role==='refine'?'Finish':'Native'} · denoise ${r.denoise}</td><td>${r.width} × ${r.height}</td><td>${time(r.generationSeconds)}</td><td>${time(r.archiveSeconds)}</td><td>${time(r.batchRestoreSeconds)}<small>Full batch: ${time(r.batchTotalSeconds)}</small></td><td>${esc(r.humanStatus)}</td><td>${link(r.graph,'Graph')} ${link(r.receipt,'Measurements')}<details><summary>Original / parent</summary><code>${esc(r.originalSHA256)}</code><p>Parent: ${esc(r.parentSHA256||'Independent creation')}</p><code>${esc(r.archiveShare)}</code></details></td></tr>`).join('')}</tbody></table></div><details><summary>Whole boards and local crops</summary><div class="group-top-actions">${l.boards.map(b=>link(b.href,b.title)).join('')}</div></details></section>
      ${preparation(l)}
      <div class="boundary"><span>✦</span><p>No default recipe is chosen here. A file reception guarantees neither all briefs, nor the interactive latency, nor an overnight throughput.</p></div>`;
  }

  function found(l) {
    return l.records.filter(p => (filter==='all'||p.category===filter) && `${p.title} ${p.model} ${p.host} ${p.groupTitle} ${p.status}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr'))).sort((a,b)=>sort==='time'?(a.seconds??Infinity)-(b.seconds??Infinity):sort==='pixels'?(b.width*b.height)-(a.width*a.height):a.groupTitle.localeCompare(b.groupTitle,'fr'));
  }
  function rows(l) {
    const records=found(l);
    return records.length ? records.map(p=>`<tr><td><strong>${esc(p.title)}</strong><small>${esc(p.groupTitle)}</small></td><td>${esc(p.model||'Finish / document')}<small>${esc(p.host)}</small></td><td>${p.width} × ${p.height}<small>${(p.width*p.height/1e6).toFixed(2)} MP · ${esc(p.mode)}</small></td><td>${esc(p.steps??'—')} / ${esc(p.seed??'—')}</td><td>${time(p.seconds)}<small>Archive: ${time(p.archiveSeconds)}</small></td><td>${esc(p.status||'See the receipt')}<small>${esc(p.note||'')}</small></td><td>${link(p.original,'Original')}${p.graph?link(p.graph,'Graph'):''}${p.humanReceipt?link(p.humanReceipt,'Feedback'):''}<details><summary>Lineage / SHA</summary><code>${esc(p.sha256)}</code><p>${p.parents.length?'Reference: '+esc(p.parents.join(', ')):'Parent not indexed in this comparison.'}</p></details></td></tr>`).join('') : '<tr><td colspan="7">No file for these filters.</td></tr>';
  }

  function preparation() {
    return window.ImageLabIntents?.render() || '<p>Preparation unavailable. Reload the page to try again.</p>';
  }

  function bind(data, current) {
    if(current!=='recipes'||!data.ready)return;
    const l=data.ready;
    function update(){ document.querySelector('#ready-rows').innerHTML=rows(l);document.querySelector('#ready-count').textContent=`${found(l).length} files · unmeasured times stay indicated.`; }
    document.querySelector('#ready-filter').onchange=e=>{filter=e.target.value;update();};
    document.querySelector('#ready-search').oninput=e=>{search=e.target.value;update();};
    document.querySelector('#ready-sort').onchange=e=>{sort=e.target.value;update();};update();
    window.ImageLabIntents?.bind();
  }

  function renderPlan(data) {
    const l=data.ready;if(!l)return unavailable();
    const columns=[['offline','Delivered'],['code','Development and integration'],['human','Receptions / product'],['gpu','Deferred options']];
    const unified=l.unifiedPlan;
    const classification=unified?.prioritization;
    const categories=Object.fromEntries((classification?.categories||[]).map(c=>[c.id,c]));
    const overview=classification?`<section class="ready-section" id="priority-overview"><h2>Where to win fast. Where to add the most.</h2><p>${esc(classification.method)}</p><p>${esc(classification.classificationScope)}</p><div class="priority-grid">${classification.categories.map(c=>`<article class="priority-card" data-priority-category="${esc(c.id)}"><h3>${esc(c.title)}</h3><p>${esc(c.definition)}</p><ul>${unified.workstreams.filter(w=>w.prioritization.tags.includes(c.id)).map(w=>`<li data-priority-lot="${esc(w.id)}"><strong>${esc(w.id)}</strong> · ${esc(w.title)}</li>`).join('')}</ul></article>`).join('')}</div><details><summary>How to read the efforts and choose what comes next</summary><p>${esc(classification.valueMeaning)}</p><ul>${Object.entries(classification.effortScale).map(([id,text])=>`<li><strong>${esc(id)}</strong> · ${esc(text)}</li>`).join('')}</ul><p>Efforts estimated for the first slice, then the remaining batch. Availability of devices, the owner and resources stays separate.</p><ul>${classification.rules.map(r=>`<li>${esc(r)}</li>`).join('')}</ul></details></section>`:'';
    const priorities=unified?`<section class="ready-section"><h2>Shared execution order</h2><p><strong>Next batch: ${esc(unified.nextPriority)}.</strong> ${esc(unified.orderPolicy)}</p><ol class="unified-workstreams">${unified.workstreams.map(w=>{
      const p=w.prioritization;
      return `<li data-workstream="${esc(w.id)}"><span class="eyebrow">${esc(w.id)} · ${esc(w.owner)}</span><h3><span class="workstream-rank">${unified.executionOrder.includes(w.id)?esc(w.priority)+'. ':''}</span>${esc(w.title)}</h3><span class="badge ${w.state==='done'?'green':'purple'}">${esc({done:'Delivered',prepared:'Integration prepared',external:'Product reception pending',open:'To finish',optional:'Deferred option'}[w.state]||w.state)}</span><div class="priority-tags">${p.tags.map(t=>`<span class="priority-tag" data-tag="${esc(t)}">${esc(categories[t].title)}</span>`).join('')}</div><p class="priority-estimates"><strong>Expected value:</strong> ${esc(p.addedValue)} · <strong>Effort slice / batch:</strong> ${esc(p.firstSliceEffort)} / ${esc(p.remainingLotEffort)} · <strong>Uncertainty:</strong> ${esc(p.uncertainty)}</p><p>${esc(p.reason)}</p><p><strong>First useful slice:</strong> ${esc(p.firstUsefulSlice)}</p><p><strong>Remaining scope:</strong> ${esc(p.remainingScope)}</p><details><summary>Achieved, work and evidence to close</summary><p><strong>Achieved:</strong> ${esc(w.delivered)}</p><p>${esc(w.next)}</p><ul>${w.acceptance.map(a=>`<li>${esc(a)}</li>`).join('')}</ul><p>${w.validation.map(esc).join(' · ')}</p>${w.dependencies.length?`<p>Dependencies: ${w.dependencies.map(esc).join(', ')}</p>`:''}${w.gates.length?`<ul>${w.gates.map(g=>`<li>${esc(g.lotId||g.kind)} · ${esc(g.reason)}</li>`).join('')}</ul>`:''}</details></li>`;
    }).join('')}</ol><div class="group-top-actions">${link(unified.href,'Execution roadmap')}${link(unified.roadmapHref,'Canonical JSON register')}${link('/images/labo/lab-resources/ready/PACK-ROADMAP-PRIORISEE-20261008.zip','Prioritized roadmap archive')}</div></section>`:'';
    return `<div class="page-head"><div><span class="eyebrow">AGENTX ROADMAP · OCTOBER 8</span><h1>What is done. What remains.</h1><p>Measurements, human feedback and availability in the engine each keep their evidence.</p></div>${link('#recipes','See the workflows')}</div><div class="ready-notice"><strong>Image GPU validations deferred</strong><p>The current workshop uses fast Klein and quality Qwen on UGFrank. The Alien HQ chain remains to be integrated. This cockpit views the evidence and prepares folders without submission.</p><small>${stamp(l.updatedAtUtc)}</small></div>${overview}${priorities}<section class="ready-section"><h2>Deliveries and detailed work</h2><div class="plan-grid">${columns.map(([lane,title])=>`<section><h2>${title}</h2>${l.tasks.filter(t=>t.lane===lane).map(t=>`<article class="roadmap-card"><div class="roadmap-owner">${esc(t.workstreamId||'Catalogue')} · ${esc(t.owner)}</div><span class="badge ${t.state==='done'?'green':'purple'}">${esc({done:'Delivered',open:'To finish',external:'Product reception pending',prepared:'Prepared',paused:'Paused',optional:'Deferred option'}[t.state])}</span><h3>${esc(t.title)}</h3><p>${esc(t.detail)}</p></article>`).join('')}</section>`).join('')}</div></section><section class="ready-section"><h2>Documents and sources of truth</h2><div class="group-top-actions">${l.documents.map(d=>link(d.href,d.title))}${link('/images/labo/lab-resources/ready/ledger.json','JSON index')}</div><details><summary>Dated receptions and evidence (${l.sources.length})</summary><ul>${l.sources.map(s=>`<li>${link(s.href,s.file)}<small>${stamp(s.modifiedAtUtc)} · <code>${esc(s.sha256)}</code></small></li>`).join('')}</ul></details></section>`;
  }
  return {apply,renderRecipes,renderPlan,bind};
})();
