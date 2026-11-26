'use strict';

(async () => {
  const $ = id => document.getElementById(id);
  const sources = {pipeline:{state:'loading'}, registry:{state:'loading'}};
  async function fetchSource(name, timeout) {
    try {
      const response = await fetch('/owner/work/data/'+name, {cache:'no-store', credentials:'same-origin',
        redirect:'error', signal:AbortSignal.timeout(timeout)});
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      if (data.state === 'read' && !Array.isArray(name === 'pipeline' ? data.records : data.agents)) throw new Error('Invalid projection');
      return data;
    } catch (error) {
      return {state:'unavailable', reason:error.name === 'TimeoutError' ? 'timeout' : 'source_indisponible',
        checkedAt:new Date().toISOString()};
    }
  }
  const dimensions = {status:'Tous les états',domain:'Tous les domaines',type:'Tous les types',executor:'Tous les exécutants'};
  const order = new Map(cockpitCards.lanes.map((lane,i)=>[lane.id,i]));
  const dateFormat = new Intl.DateTimeFormat('fr-CA',{timeZone:'America/Toronto',
    year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const date = value => value ? dateFormat.format(new Date(value))+' (Québec)' : 'date non exposée';
  const fold = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr');
  const collator = new Intl.Collator('fr',{numeric:true});
  const workspace = document.querySelector('.workspace');
  const mobile = matchMedia('(max-width:760px)');
  $('facets').open = !mobile.matches;
  mobile.addEventListener('change', e=>{ $('facets').open = !e.matches; });
  let collection = [], selected, laneFilter = '';
  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function sourceStatus(label, source) {
    if (source.state === 'loading') return 'Chargement de '+label+'…';
    if (source.state !== 'read') return label+' · '+(source.reason === 'timeout' ? 'Délai dépassé' : 'Source indisponible')+
      ' · '+date(source.checkedAt)+'.';
    return label+' · relevé du '+date(source.observedAt)+'.';
  }
  function renderRegistry(registry) {
    $('registry-health').textContent = sourceStatus('Agent Ops',registry);
    if (registry?.state === 'read') {
      $('registry-health').append(' '+registry.agents.length+' entrées.');
      const observation = {observed:'Observé',configured:'Déclaré',unknown:'Observation inconnue'};
      for (const entry of registry.agents) {
        const row = el('li');
        row.append(el('strong',entry.persona || entry.id),
          el('span',[entry.id,entry.runtime || 'Runtime non exposé',observation[entry.observation]].join(' · '),'sub'));
        $('roster').append(row);
      }
    }
  }
  function loadCollection() {
    const pipeline = sources.pipeline;
    collection = pipeline.state === 'read' ? pipeline.records.map(cockpitCards.fromPipeline) : [];
    const status = sourceStatus('Pipeline',pipeline);
    $('pipeline-health').textContent = status;
    $('provenance').textContent = status + (pipeline.state === 'read'
      ? ' Services : '+pipeline.services.join(', ')+' · '+(pipeline.hasMore ? 'les '+collection.length+' dossiers les plus récents.' : collection.length+' dossiers dans ce périmètre.') : '');
    for (const [key,label] of Object.entries(dimensions)) {
      const values = [...new Set(collection.map(card=>card[key]))].sort(collator.compare);
      $(key).replaceChildren(new Option(label,''),...values.map(value=>new Option(value,value)));
    }
    fromStart();
  }
  function drawDetail(card, returnToRow) {
    const detail = $('detail');
    detail.replaceChildren();
    if (!card) {detail.append(el('p','Aucune fiche sélectionnée.','empty')); return;}
    const back = el('button','Retour à la liste','back');
    back.type = 'button';
    back.onclick = returnToRow || null;
    const source = el('div',null,'sourceLine');
    source.append(el('strong',card.ref,'tag'));
    if (card.updated) source.append(el('span','Mis à jour le '+date(card.updated)));
    const facts = el('dl',null,'facts');
    for (const [label,value] of [['Source','Pipeline'],['Service',card.domain],['État natif',card.status],
      ['Triage',card.intake || 'Non renseigné'],['Création',date(card.created)],['Attribution',card.executor]]) {
      const pair = el('div'); pair.append(el('dt',label),el('dd',value)); facts.append(pair);
    }
    detail.append(back,source,el('h2',card.title),facts);
    const evidence=el('section');
    evidence.append(el('h3','Suivi Pipeline'));
    if (Number.isInteger(card.attempts)) evidence.append(el('p','Tentatives enregistrées : '+card.attempts));
    if (Number.isInteger(card.relationships)) evidence.append(el('p','Relations enregistrées : '+card.relationships));
    for (const event of card.transitions) {
      if (event.at && event.to) evidence.append(el('p',date(event.at)+' · '+event.to));
    }
    if (evidence.children.length > 1) detail.append(evidence);
    if (card.url) {
      const link = el('a','Ouvrir le dossier '+card.ref+' ↗');
      link.href=card.url; link.rel='noopener noreferrer'; link.target='_blank';
      const box=el('section'); box.append(link); detail.append(box);
    }
  }
  function drawOverview(filtered) {
    $('overview').replaceChildren();
    for (const lane of cockpitCards.lanes) {
      const count = filtered.filter(card=>card.lane===lane.id).length;
      const button = el('button',null,'lane');
      button.type='button'; button.dataset.lane=lane.id;
      button.setAttribute('aria-pressed',String(laneFilter===lane.id));
      button.disabled = sources.pipeline.state !== 'read';
      button.append(el('span',lane.label),el('strong',button.disabled ? '—' : String(count)),el('small',lane.hint));
      button.onclick=()=>{
        laneFilter = laneFilter===lane.id ? '' : lane.id;
        fromStart();
        $('overview').querySelector('[data-lane="'+lane.id+'"]').focus();
      };
      $('overview').append(button);
    }
  }
  function compare(a,b) {
    if ($('sort').value === 'priority') {
      const diff = (order.get(a.lane) ?? 3) - (order.get(b.lane) ?? 3);
      if (diff) return diff;
    }
    if ($('sort').value !== 'title') {
      const diff = (b.updated || '').localeCompare(a.updated || '');
      if (diff) return diff;
    }
    return collator.compare(a.title,b.title) || collator.compare(a.id,b.id);
  }
  function render() {
    const term = fold($('search').value.trim());
    const filtered = collection.filter(card=>Object.keys(dimensions).every(key=>!$(key).value || $(key).value===card[key]) &&
      fold([card.title,card.ref,card.executor].join(' ')).includes(term));
    drawOverview(filtered);
    const visible = filtered.filter(card=>!laneFilter || card.lane===laneFilter).sort(compare);
    const count = visible.length;
    if (!visible.some(card=>card.id===selected)) selected = visible[0]?.id;
    $('total').textContent=sources.pipeline.state === 'read' ? count+' sur '+collection.length : '—';
    const rows=$('rows');
    rows.replaceChildren();
    if (!count) {
      const message = sources.pipeline.state !== 'read' ? sourceStatus('Pipeline',sources.pipeline)
        : collection.length ? 'Aucun dossier ne correspond à ces filtres.' : 'Aucun dossier Pipeline dans ce périmètre.';
      rows.append(el('p',message,'empty'));
    }
    for (const card of visible) {
      const button=el('button',null,'row');
      button.id=card.id; button.type='button';
      button.setAttribute('aria-current',String(selected===card.id));
      button.setAttribute('aria-controls','detail');
      button.append(el('span',card.ref,'ref'),el('strong',card.title),el('span',card.status,'sub'));
      button.onclick=()=>{
        const rowTop = button.getBoundingClientRect().top;
        $(selected)?.setAttribute('aria-current','false');
        selected = card.id;
        button.setAttribute('aria-current','true');
        workspace.dataset.detail = 'open';
        drawDetail(card, () => {
          delete workspace.dataset.detail;
          button.focus({preventScroll:true});
          window.scrollBy(0, button.getBoundingClientRect().top - rowTop);
        });
        $('detail').focus({preventScroll:true});
        $('detail').scrollIntoView({block:'start'});
      };
      rows.append(button);
    }
    $('reset').disabled=!term && !laneFilter && !Object.keys(dimensions).some(key=>$(key).value);
    const activeFilters = Object.keys(dimensions).filter(key=>$(key).value).length;
    $('filter-count').textContent=activeFilters ? '('+activeFilters+')' : '';
    drawDetail(visible.find(card=>card.id===selected));
  }
  function fromStart() {delete workspace.dataset.detail; render();}
  $('filters').onsubmit=e=>e.preventDefault();
  $('filters').onchange=e=>{if(e.target.tagName==='SELECT') fromStart();};
  $('search').oninput=fromStart; $('sort').onchange=fromStart;
  $('filters').onreset=e=>{
    e.preventDefault();
    for (const key of Object.keys(dimensions)) $(key).value='';
    $('search').value=''; laneFilter=''; fromStart();
  };
  loadCollection();
  fetchSource('pipeline', 7000).then(data => {sources.pipeline=data; loadCollection();});
  fetchSource('registry', 38000).then(data => {sources.registry=data; renderRegistry(data);});
})();
