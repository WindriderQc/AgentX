'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = { chart: null, window: '24h' };
  const number = (value, digits = 1) => Number.isFinite(value) ? new Intl.NumberFormat('fr-CA', { maximumFractionDigits: digits }).format(value) : '—';
  const duration = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
  const confidence = { high: 'élevée', medium: 'moyenne', low: 'faible', unavailable: 'indisponible' };
  function renderChart(data) {
    const points = data.series.power.map(point => ({ x: Date.parse(point.at), y: point.value }));
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('energyChart'), { type: 'line', data: { datasets: [{ label: 'Puissance', data: points,
      parsing: false, borderColor: '#59dbe8', backgroundColor: '#59dbe824', fill: true, tension: .22, pointRadius: 0, borderWidth: 2 }] },
      options: { maintainAspectRatio: false, animation: false, interaction: { intersect: false, mode: 'nearest' },
        scales: { x: { type: 'linear', adapters: {}, ticks: { color: '#8198ab', callback: value => new Date(value).toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'}) }, grid: { color: '#203441' } },
          y: { beginAtZero: false, ticks: { color: '#8198ab', callback: value => `${value} W` }, grid: { color: '#203441' } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: rows => new Date(rows[0].parsed.x).toLocaleString('fr-CA'), label: row => `${number(row.parsed.y)} W` } } } } });
  }
  function renderEvents(data) {
    const body = $('energyEvents'); body.textContent = '';
    if (!data.events.length) body.innerHTML = '<tr><td colspan="6">Aucune activité corrélée dans cette période.</td></tr>';
    const ranked = data.events.slice().sort((a,b)=>(b.estimatedWh||0)-(a.estimatedWh||0)).slice(0,100);
    $('energyEventCount').textContent = `${number(data.summary.eventCount,0)} activités · ${ranked.length} principales affichées`;
    for (const event of ranked) {
      const row = document.createElement('tr');
      row.innerHTML = `<td><span class="energy-kind ${event.kind}"></span></td><td></td><td>${duration(event.durationMs)}</td><td>${event.deltaW == null ? '—' : `+${number(event.deltaW)} W`}</td><td>${event.estimatedWh == null ? '—' : `${number(event.estimatedWh)} Wh`}</td><td class="energy-confidence-${event.confidence}">${confidence[event.confidence]}</td>`;
      row.cells[0].querySelector('span').append(document.createTextNode(event.label)); row.cells[1].textContent = event.host || '—'; body.append(row);
    }
    const lane = $('energyEventLane'); lane.textContent = ''; const from=Date.parse(data.from), span=Date.parse(data.to)-from;
    for (const event of data.events.slice(-500)) { const mark=document.createElement('span'); mark.className=`energy-event ${event.kind}`; mark.style.left=`${Math.max(0,(Date.parse(event.startAt)-from)/span*100)}%`; mark.style.width=`${Math.max(.35,event.durationMs/span*100)}%`; mark.title=`${event.label} · ${duration(event.durationMs)}`; lane.append(mark); }
  }
  function render(data) {
    $('energyPower').textContent = `${number(data.latest.power?.value)} W`; $('energyTotal').textContent = `${number(data.summary.energyKwh,3)} kWh`;
    $('energyBaseline').textContent = `${number(data.summary.baselineW)} W`; $('energyAttributed').textContent = `${number(data.summary.attributedWh)} Wh`;
    const age = data.freshness ? Math.max(0,Math.round((Date.now()-Date.parse(data.freshness))/1000)) : null;
    $('energyNotice').className='energy-notice'; $('energyNotice').textContent = age == null ? 'Fraîcheur inconnue' : `Données ${data.bucket || ''} · dernière mesure il y a ${age} s`;
    renderChart(data); renderEvents(data); $('energyMethod').textContent = data.methodology.note;
  }
  async function load() { $('energyNotice').textContent='Lecture de la télémétrie…'; try { const response=await fetch(`/api/analytics/energy?window=${state.window}`); const answer=await response.json(); if(!response.ok) throw new Error(answer.message||'Télémétrie indisponible'); render(answer.data); } catch(error){ $('energyNotice').className='energy-notice error'; $('energyNotice').textContent=error.message; } }
  document.querySelectorAll('[data-window]').forEach(button=>button.addEventListener('click',()=>{ document.querySelectorAll('[data-window]').forEach(item=>item.setAttribute('aria-pressed','false')); button.setAttribute('aria-pressed','true'); state.window=button.dataset.window; load(); }));
  load(); setInterval(()=>{ if(!document.hidden) load(); },30_000);
})();
