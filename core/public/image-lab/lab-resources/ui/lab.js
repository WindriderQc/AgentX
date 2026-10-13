'use strict';
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n, digits = 1) => Number.isFinite(Number(n)) && n != null ? Number(n).toLocaleString('en-US', {maximumFractionDigits:digits}) : '—';
  const duration = n => n == null ? 'Not timed here' : n < 60 ? `${fmt(n)} s` : `${Math.floor(n / 60)} min ${Math.round(n % 60)} s`;
  const bytes = n => n > 1e9 ? `${fmt(n / 1e9)} GB` : n > 1e6 ? `${fmt(n / 1e6)} MB` : `${fmt(n / 1e3, 0)} kB`;
  const stamp = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('en-US', {timeZone:'America/Toronto',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Date not provided';
  const dims = p => `${p.width} × ${p.height}`;
  const href = (view, group) => `#${view}${group ? '?group=' + encodeURIComponent(group) : ''}`;
  const link = (url, label, cls = 'link') => `<a class="${cls}" href="${esc(url)}"${url.startsWith('https://') ? ' target="_blank" rel="noopener"' : ''}>${esc(label)} ↗</a>`;
  const badge = (text, color = '') => `<span class="badge ${color}">${esc(text)}</span>`;
  const pageHead = (eyebrow, title, text, extra = '') => `<div class="page-head"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${text}</p></div>${extra}</div>`;
  const titles = {overview:'Overview',compare:'Compare images',machines:'Fleet & architecture',roadmap:'What comes next',files:'Files & evidence',recipes:'Workflows & recipes',plan:'Current plan · no GPU'};
  const categories = {all:'All',performance:'One or two GPUs',scenes:'Scenes / kids',edition:'Edits',logos:'Logos / docs',textures:'Textures / paint jobs'};
  const fileCategories = {all:'All',assets:'Received assets',preuves:'Evidence',plans:'Plans',exploration:'Exploration',packs:'Folders'};
  let data, loading = false, current = 'overview', category = 'all', groupId = 'gpu-k04';
  let pair = [], regime = 'C', fileCategory = 'all', fileSearch = '', modalPair = [], viewerMode = 'side';
  let zoom = 100, scrollGuard = false, priorFocus, toastTimer;
  const group = () => data.groups.find(g => g.id === groupId) || data.groups[0];
  const tabs = (values, selected, key) => `<div class="filter-tabs">${Object.entries(values).map(([k,v]) => `<button data-${key}="${k}" aria-pressed="${selected === k}">${esc(v)}</button>`).join('')}</div>`;

  function coreSummary() {
    const c = data.core;
    if (!c?.available) return 'Core state unavailable: admission must be checked before any GPU trial.';
    if (c.maintenance) return 'Core reports maintenance. No new GPU trial from this site.';
    const occupied = Object.entries(c.byHost || {}).filter(([, h]) => h.blocked).map(([name]) => name);
    return occupied.length ? `${occupied.join(', ')}: occupancy declared in Core. Batches wait for their admission.` : 'No occupancy declared on the read hosts. A Core admission is still required before each batch.';
  }
  function overview() {
    const p = data.performance, t = p.throughput;
    return `<section class="hero"><div class="hero-copy"><span class="eyebrow">OUR LAB · FROM FUN TO HQ</span><h1>Beautiful images.<br>Evidence.<br>What comes next, clearly.</h1><p>Scenes for the kids, logos for our docs, materials for GraphysX. We explore the best of our fleet — and keep the steps that lead to a usable file.</p><div class="hero-actions">${link(href('compare'), 'Compare the renders', 'button')}${link(href('recipes'), 'Workflows and recipes', 'button secondary')}</div><p class="hero-note"><span class="dot"></span>October 8 · results reconciled; work without GPU.</p></div><div class="hero-art"><img class="hero-picture" src="${data.hero.src}" alt="Received illustration: garden and small characters" width="${data.hero.previewWidth}" height="${data.hero.previewHeight}"><span class="art-tag"><span class="dot"></span>Received garden · seed 9001</span><div class="art-sticker"><img src="${data.logo.original}" alt="Received AgentX logo"><p>OUR LOGO V1</p></div><span class="hero-coordinate">NATIVE 2048 × 2048 · QWEN 2.1</span></div></section>
      <div class="metrics"><div class="metric"><div class="metric-top">PERFORMANCE CAMPAIGN <span>01</span></div><div class="metric-number">${p.renders}<small> renders</small></div><p>${p.lots} batches · ${p.failed ?? '—'} failed · resources returned</p></div><div class="metric"><div class="metric-top">TWO SHARED 3090s <span>02</span></div><div class="metric-number">${fmt(p.regimes.C.warm.median, 0)}<small> s / image</small></div><p>Warm median · new text · n=${p.regimes.C.warm.n}</p></div><div class="metric"><div class="metric-top">TWO WORKERS <span>03</span></div><div class="metric-number">${fmt(t.steady)}<small> images / h</small></div><p>Steady state of the ${duration(t.durationSeconds)} batch · not a validated night</p></div><div class="metric"><div class="metric-top">DOCUMENTED EXPLORATION <span>04</span></div><div class="metric-number">${data.exploration.recipes}<small> leads</small></div><p>${data.exploration.graphs} candidate graphs · executed batches and limits in the plan</p></div></div>
      <div class="status-ribbon"><p><strong>Fleet state</strong> · ${esc(coreSummary())}<br><small>Reading: ${stamp(data.core?.observedAt)} · read-only view.</small></p>${link(href('machines'), 'See the machines')}</div>
      <div class="section-title"><div><h2>Who delivered what?</h2><p>The support sessions and our next qualification.</p></div>${link(href('files'), 'Open the folders')}</div><div class="sessions">${data.sessions.map((s,i) => `<article class="session"><div class="session-top"><span class="session-num">0${i+1}</span><span class="owner">${esc(s.owner)}</span></div><h3>${esc(s.title)}</h3>${badge(s.label, s.state === 'delivered' ? 'green' : 'purple')}<p>${esc(s.description)}</p><div class="session-foot"><small>${stamp(s.updatedAt)}</small>${link(href(s.view,s.group), 'Explore')}</div></article>`).join('')}</div>
      <div class="section-title"><div><h2>Three uses, one complete workflow.</h2><p>Create → choose → edit → finish → receive.</p></div></div><div class="usage-grid">
      <article class="usage"><div class="usage-image"><img src="${data.hero.src}" alt="Received garden" loading="lazy">${badge('SCENES / KIDS')}</div><div class="usage-copy"><h3>Scenes that tell it right</h3><p>Several seeds received. Objects and their relations keep their own validation.</p><div class="workflow-trail"><span>Brief</span><b>→</b><span>Seeds</span><b>→</b><span>Edit</span></div>${link(href('compare','jardins'),'See the scenes')}</div></article>
      <article class="usage logo-usage"><div class="usage-image"><img src="${data.logo.original}" alt="Logo AgentX RGBA">${badge('LOGOS / DOCS')}</div><div class="usage-copy"><h3>From logo to usable icon</h3><p>Vector and real alpha, 24/32/64 exports. The received kit is ready to find in the files.</p><div class="workflow-trail"><span>Creation</span><b>→</b><span>SVG</span><b>→</b><span>Small sizes</span></div>${link(href('compare','logo'),'Inspect the logo')}</div></article>
      <article class="usage"><div class="usage-image"><img src="${data.tile.src}" alt="New torus texture" loading="lazy">${badge('TEXTURES / PAINT JOBS')}</div><div class="usage-copy"><h3>A material that tiles</h3><p>${data.tile.accepted ? 'Master, atlas and five views received. Import into the GraphysX product stays separate.' : 'New 2048² master generated. Seams measured; appearance and repetition still to be received.'}</p><div class="workflow-trail"><span>Tile</span><b>→</b><span>3 × 3</span><b>→</b><span>Atlas</span></div>${link(href('compare','textures'),'See the new tile')}</div></article></div>
      <div class="boundary"><span>✦</span><p>The overall ceiling remains open. A received image, a measured speed and a production recipe are three different validations. The copper and text edits, the new tile and the atlas are received on their files. The next step is integrating them into complete workflows.</p></div>`;
  }

  function imageCard(item, index) {
    const isSelected = pair.includes(index);
    const native = item.kind === 'icon' ? 'PNG at its native size' : 'Reduced preview · open the native pixels';
    return `<article class="image-card${isSelected ? ' selected' : ''}" data-image="${index}"><div class="image-top"><label><input type="checkbox" data-pair="${index}" ${isSelected ? 'checked' : ''}>Compare</label><span>${item.kind === 'crop' ? 'MASTER CROP' : item.kind === 'bench' ? 'PRIVATE BENCH' : item.kind === 'icon' ? 'RGBA EXPORT' : 'ORIGINAL FILE KEPT'}</span></div><button class="image-stage${item.kind === 'icon' ? ' icon-stage' : ''}" data-open="${index}" data-background="${item.background || 'light'}" aria-label="Inspect ${esc(item.title)}"><img src="${item.kind === 'icon' ? item.original : item.src}" alt="${esc(item.title)}" width="${item.kind === 'icon' ? item.width : item.previewWidth}" height="${item.kind === 'icon' ? item.height : item.previewHeight}" loading="lazy"></button><div class="image-caption"><h3>${esc(item.title)}</h3>${badge(item.status || 'Proposal', /reçu|reçue|identique|Préféré|received|identical|preferred/i.test(item.status) ? 'green' : 'purple')}<div class="image-meta"><span>${dims(item)} px</span>${item.steps ? `<span>${item.steps} steps</span>` : ''}${item.seed != null ? `<span>Seed ${item.seed}</span>` : ''}</div>${item.seconds != null ? `<div class="time-value">${duration(item.seconds)}</div><div class="time-scope">${esc(item.timeScope || 'Observed generation')}</div>` : ''}<p>${esc(item.note || item.model || '')}</p><div class="image-links"><button class="link" data-open="${index}">Inspect ↗</button>${link(item.original, 'Original')}${item.receipt ? link(item.receipt,'Technical receipt') : ''}</div><p style="margin-top:8px;font-size:9px">${native}</p></div></article>`;
  }
  function compare() {
    const g = group();
    const options = data.groups.filter(item => category === 'all' || item.category === category);
    if (!pair.length) pair = [...(g.defaultPair || [0,1])];
    return `${pageHead('THE IMAGES, TOGETHER', 'Compare what is comparable.', 'One use and one brief at a time. Actual dimensions, stable order and accessible originals; previews are not enough to judge the detail.')}
      <div class="compare-controls">${tabs(categories,category,'category')}<div class="selector-line"><div class="field"><label for="group-select">Choose a comparison</label><select id="group-select">${options.map(item => `<option value="${item.id}"${item.id === g.id ? ' selected' : ''}>${esc(item.title)}</option>`).join('')}</select></div><p class="hint">${options.length} comparisons in this selection.<br>Check two files to open them together.</p></div></div>
      <section class="group-intro"><span class="eyebrow">${esc(categories[g.category])}</span><h2>${esc(g.title)}</h2><p>${esc(g.description)}</p><p class="scope">${esc(g.scope || '')}</p>${g.reference ? `<div class="reference"><img src="${g.reference.src}" alt="Reference of this comparison"><div><strong>${esc(g.reference.title)}</strong><p>${dims(g.reference)} px · parent kept</p>${link(g.reference.original,'Open the reference')}</div></div>` : ''}<div class="group-top-actions"><button class="button" id="compare-pair"${pair.length !== 2 ? ' disabled' : ''}>Compare both originals ↗</button>${g.evidence ? link(g.evidence,'Evidence and protocol','button secondary') : ''}</div></section>
      <div class="image-deck" data-count="${g.items.length}">${g.items.map(imageCard).join('')}</div>
      ${g.humanReceipt ? `<details class="provenance"><summary>Human reception of this file</summary><p>${esc(g.scope)}</p>${link(g.humanReceipt,'Exact feedback and fingerprint')}</details>` : ''}
      ${g.inspections ? `<details class="provenance" open><summary>Repetition and native details of the master</summary><p>The 3 × 3 repetition, the seams and the interior are available at their native size. The repetition is an assembly of the 2048² master, not a 6144² generation.</p><div class="group-top-actions">${g.inspections.map(i=>link(i.href,i.title,'small-button')).join('')}</div></details>` : ''}
      ${g.brief ? `<details class="provenance"><summary>Exact brief of this comparison</summary><p>${esc(g.brief)}</p></details>` : ''}
      <details class="provenance"><summary>Lineage, graphs and fingerprints</summary><p>The WebP previews are reduced copies for the site. The “Original” files keep their format and pixels. Changing the seed or the model produces a proposal; only an edit with a reference has edit lineage.</p><ul>${g.items.map(i => `<li><strong>${esc(i.title)}</strong> · ${dims(i)} · SHA-256 <code>${esc(i.sha256)}</code> ${i.graph ? link(i.graph,'Graph') : ''} ${i.receipt ? link(i.receipt,'Receipt') : ''}${i.archiveSeconds != null ? ` · observed archiving ${duration(i.archiveSeconds)}` : ''}</li>`).join('')}</ul><p>The durations shown are not a total time until human reception. Generation, archiving, restoration and finishing stay separate in the reproducible folders.</p></details>`;
  }

  const architectures = {
    A:{title:'One 3090 does the work',desc:'All components on one card with their memory management. The second card does not compute this image.',nodes:[['BRIEF','One text, one seed','Qwen 2.1 BF16 · 25 steps'],['GPU 0 · 24 GB','Encoder → generator → VAE','One request, one card'],['GPU 1 · 24 GB','Available for another load','Subject to admission and coexistence']],note:'The VRAM is not a 48 GB pool. This setup is the measured baseline A.'},
    B:{title:'Components split across two cards',desc:'The text encoder works on GPU 1; the generator and the VAE on GPU 0. An image is still generated by a single compute card.',nodes:[['GPU 1 · 24 GB','Encode the text','Conditioning identical to the baseline'],['GPU 0 · 24 GB','Generate, then decode','One generator · Qwen 2.1 BF16'],['FILE','Same PNG as baseline A','On the deterministic comparisons']],note:'Setup B: a gain in component and text handling. It is not shared diffusion compute.'},
    C:{title:'Both 3090s compute the same image',desc:'A real shared diffusion with the private Ulysses node. The latency gain is measured; the image differs from the baseline and must be reviewed.',nodes:[['GPU 0 + GPU 1','Prepare the conditioning','Two cards · separate pools'],['GPU 0 ⇄ GPU 1','Shared Ulysses diffusion','PCIe Gen4 ×8 · PHB · no NVLink'],['FILE','One HQ image','K04 received on its pair']],note:'Setup C: 129.7 s median for a new warm text. Private nodes; editing with a reference, LoRA and ControlNet are not qualified in this setup.'},
    parallel:{title:'Two cards, two images in parallel',desc:'One independent worker per 3090. This is the measured path to produce several images, with the time and heat of an extended batch.',nodes:[['BRIEF QUEUE','Two independent jobs','Each job has its own seed'],['GPU 0 / GPU 1','One worker on each card','Qwen 2.1 BF16 · 25 steps'],['TWO FILES','Two proposals per wave','Not one image computed by four hands']],note:'16 images in 21 min 30 up to the last PNG. 46.1 images/h on the steady waves; 44.6/h for the whole batch, 43.4/h with reservation and restoration. This batch does not qualify a whole night.'}
  };
  function machineCard(name, cls, gpuName, memory, desc) {
    const f = data.fleet.find(x => x.name === name), c = data.core?.byHost?.[name];
    const live = (f?.gpu || []).map(g => {
      const temp = g['temperature.gpu'] ?? g['temperature.gpu [C]'];
      return `<div>GPU ${esc(g.index)} · ${esc(g['memory.used [MiB]'] ?? '—')} / ${esc(g['memory.total [MiB]'] ?? '—')} MiB · ${esc(g['utilization.gpu [%]'] ?? '—')} %${temp != null ? ` · ${esc(temp)} °C` : ''}</div>`;
    }).join('');
    const disks = Object.entries(f?.disks || {}).filter(([path]) => name !== 'UGBrutal' || path.includes('SSD') || path === '/mnt/e').map(([path,d]) => `<div>${esc(path)} · ${bytes(d.availableBytes)} free</div>`).join('');
    return `<article class="machine ${cls}"><div class="machine-title"><h3>${name}</h3><span>${cls === 'alien' ? '02 CARDS' : '01 CARD'}</span></div><div class="machine-gpu">${gpuName}</div><div class="machine-memory">${memory}</div><p>${desc}</p><div class="machine-live">${badge(!data.core?.available ? 'Core not read' : c?.blocked ? 'Occupancy declared' : 'Admission to check', c?.blocked ? 'orange' : 'teal')}${live || '<div>GPU telemetry unavailable for this reading.</div>'}${disks}<small>${f?.gpuObservedAt ? `GPU: ${stamp(f.gpuObservedAt)} · disk: ${stamp(f.observedAt)}` : `GPU / disk: ${stamp(f?.observedAt)}`}<br>Core occupancy: ${stamp(data.core?.observedAt)}</small></div></article>`;
  }
  function architecturePanel() {
    const a = architectures[regime];
    return `<span class="eyebrow">THE MEASURED SETUPS · NOT A PRODUCTION ROUTING</span><h2>${a.title}</h2><p>${a.desc}</p><div class="regime-tabs">${[['A','A · one card'],['B','B · split components'],['C','C · shared compute'],['parallel','Two workers']].map(([key,label]) => `<button data-regime="${key}" aria-pressed="${key === regime}">${label}</button>`).join('')}</div><div class="architecture-flow">${a.nodes.map(([label,title,desc],i) => `${i ? '<span class="flow-arrow">→</span>' : ''}<div class="flow-node"><label>${label}</label><strong>${title}</strong><p>${desc}</p></div>`).join('')}</div><div class="architecture-note">${a.note}</div>`;
  }
  function productionPath() {
    const w = data.imageWorker || {}, recipes = (data.imageRecipes || []).map(r => `${r.id} ${r.steps} steps`).join(' · ');
    return `<div class="section-title"><div><h2>In production, a request follows this path.</h2><p>Images are computed on ${esc(w.label || 'the configured image PC')}. Core receives the requests, borrows the card and keeps the originals.</p></div>${link('/images','Create an image in the product')}</div>
      <figure class="surface production-path"><div class="pp-scroll"><svg viewBox="0 0 1000 440" role="img" aria-label="In production, three ways to request an image lead to Core. Core borrows the graphics card from the language models, sends the recipe to the keeper, which starts ComfyUI for the time of one image, keeps the original in the archive, then serves the image to whoever requested it.">
<defs><marker id="pp-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="pp-head" d="M0 0L10 5L0 10z"/></marker><marker id="pp-b" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="pp-head" d="M10 0L0 5L10 10z"/></marker></defs>
<text class="pp-label" x="12" y="24">WHO ASKS</text>
<rect class="pp-box" x="12" y="38" width="190" height="64" rx="10"/><text x="26" y="64">Product Workshop page</text><text class="pp-sub" x="26" y="84">/images</text>
<rect class="pp-box" x="12" y="116" width="190" height="64" rx="10"/><text x="26" y="142">Nestor</text><text class="pp-sub" x="26" y="162">local_image tool</text>
<rect class="pp-box" x="12" y="194" width="190" height="64" rx="10"/><text x="26" y="220">Family conversations</text><text class="pp-sub" x="26" y="240">one quick drawing per turn</text>
<path class="pp-wire" d="M202 70H224V148M202 226H224V148"/><path class="pp-wire" d="M202 148H262" marker-end="url(#pp-a)"/>
<rect class="pp-box" x="264" y="38" width="300" height="220" rx="10"/>
<text class="pp-title" x="280" y="66">Core</text><text class="pp-sub" x="330" y="65">/api/images · imageService</text>
<rect class="pp-step" x="280" y="100" width="268" height="30" rx="6"/><text x="292" y="120">1 · Preparation</text><text class="pp-sub" x="412" y="120">borrows the card</text>
<rect class="pp-step" x="280" y="136" width="268" height="30" rx="6"/><text x="292" y="156">2 · Computation</text><text class="pp-sub" x="412" y="156">sends the recipe</text>
<rect class="pp-step" x="280" y="172" width="268" height="30" rx="6"/><text x="292" y="192">3 · Archiving</text><text class="pp-sub" x="412" y="192">keeps the original</text>
<rect class="pp-step" x="280" y="208" width="268" height="30" rx="6"/><text x="292" y="228">4 · Restoration</text><text class="pp-sub" x="412" y="228">gives the card back</text>
<rect class="pp-zone" x="606" y="14" width="382" height="252" rx="12"/><text class="pp-label" x="620" y="36">${esc((w.label || 'Image PC').toUpperCase())} · PRODUCTION</text>
<rect class="pp-box" x="620" y="50" width="168" height="64" rx="10"/><text x="634" y="76">worker.py keeper</text><text class="pp-sub" x="634" y="96">always listening</text>
<rect class="pp-box" x="806" y="50" width="168" height="64" rx="10"/><text x="820" y="76">ComfyUI 0.38.0</text><text class="pp-sub" x="820" y="96">for one image</text>
<path class="pp-wire" d="M564 70H618" marker-end="url(#pp-a)"/><text class="pp-label" x="570" y="62">recipe</text>
<path class="pp-wire" d="M618 96H566" marker-end="url(#pp-a)"/><text class="pp-label" x="570" y="116">image</text>
<path class="pp-wire" d="M788 82H804" marker-end="url(#pp-a)"/><path class="pp-wire" d="M890 114V142" marker-end="url(#pp-a)"/>
<rect class="pp-gpu" x="620" y="144" width="354" height="74" rx="10"/><circle class="pp-ink" cx="662" cy="181" r="24"/><circle class="pp-ink" cx="662" cy="181" r="6"/><path class="pp-ink" d="M662 157v18M662 187v18M638 181h18M668 181h18"/>
<text class="pp-title" x="702" y="178">${esc(w.gpu ? w.gpu.replace(/^NVIDIA GeForce /, '') : 'Graphics card')}</text><text class="pp-sub" x="702" y="198">${w.vramGiB ? `${esc(w.vramGiB)} GB, ` : ''}shared with the language models</text>
<text class="pp-sub" x="620" y="246">${esc(recipes)}</text>
<rect class="pp-box" x="264" y="318" width="300" height="64" rx="10"/><text x="280" y="344">Language models of the image PC</text><text class="pp-sub" x="280" y="364">unloaded, then reloaded as they were</text>
<path class="pp-wire" d="M414 258V316" marker-end="url(#pp-a)" marker-start="url(#pp-b)"/>
<rect class="pp-box" x="700" y="318" width="274" height="64" rx="10"/><text x="716" y="344">Archive, NAS photo library</text><text class="pp-sub" x="716" y="364">the original, under its fingerprint</text>
<path class="pp-wire" d="M564 190H586V292H836V316" marker-end="url(#pp-a)"/>
<path class="pp-wire" d="M836 382V416H106V260" marker-end="url(#pp-a)"/><text class="pp-label" x="330" y="408">the image returns to whoever requested it, fingerprint rechecked</text>
</svg></div><figcaption>One image at a time, with no queue and no backup second PC. Machine, card and recipes are read from the configuration in service; the setups measured above remain trials.</figcaption></figure>`;
  }
  function machines() {
    const p = data.performance, t = p.throughput;
    const medians = ['A','B','C'].map(k => p.regimes[k].warm);
    return `${pageHead('OUR HARDWARE, PUT TO WORK', 'One image fast. Or several together.', 'Alien can use both 3090s for a single diffusion, or run two workers. Brutal has already produced the new texture. The right setup depends on the recipe and the use.')}
      <div class="machine-grid">${machineCard('UGFrank','frank','RTX 3080 Ti','12 GB of VRAM','Core, data and archiving; historical image pilot. The NAS share keeps the folders.')}${machineCard('UGAlien','alien','2 × RTX 3090','24 GB per card · 48 GB combined, separate pools','HQ BF16, editing and multi-GPU comparisons. The fleet’s quality ceiling remains to be explored.')}${machineCard('UGBrutal','brutal','RTX 5070 Ti','16 GB of VRAM · SSD C: / HDD E:','Quantized path and torus trials. The slow E: storage stays separate from the working SSD.')}</div>
      <section class="architecture" id="architecture-panel">${architecturePanel()}</section>
      ${productionPath()}
      <div class="section-title"><div><h2>The latency gain, isolated from the throughput gain.</h2><p>Qwen 2.1 BF16 · 2400 × 1792 · 25 steps · zero references · three briefs.</p></div>${link('/images/labo/lab-resources/docs/performance-report.md','Full report')}</div>
      <div class="speed-layout"><article class="surface"><span class="eyebrow">NEW WARM IMAGE</span><h3>Median generation time</h3><p>Identical conditioning across setups; n=6 per arm.</p><div class="bar-chart">${medians.map((v,i) => `<div class="bar-row"><span>${['A · one card','B · split','C · shared'][i]}</span><div class="bar-track"><div class="bar-fill arm-${i}" style="width:${(v.median / 180 * 100).toFixed(1)}%"></div></div><strong>${fmt(v.median)} s</strong></div>`).join('')}</div><p style="font-size:11px">A and B: identical PNGs. C: different but reproducible result. This measured gain does not rank the models or all sizes.</p>${link(href('compare','gpu-k04'),'Compare the shared K04')}</article>
      <article class="surface"><span class="eyebrow">TWO WORKERS · EXTENDED BATCH</span><h3>${t.images} renders in ${duration(t.durationSeconds)}</h3><p>Up to the last observed PNG file.</p><div class="throughput-value">${fmt(t.wholeLot)} <small>images / h for the whole batch</small></div><p>${fmt(t.steady)} / h on steady waves; ${fmt(t.includingRestore)} / h with reservation and restoration. One card: 23.7 / h in its baseline batch.</p><div class="boundary"><span>↗</span><p>A 21-minute batch does not prove a sustained overnight throughput. The throughput of images that match the brief remains to be qualified: at least 6 strict defects in the 20 extended images reviewed.</p></div></article></div>
      <details class="provenance"><summary>Fresh process, warm model and already-encoded text</summary><div class="table-wrap"><table class="timing-table"><thead><tr><th>Setup</th><th>Fresh process</th><th>New warm text</th><th>Already-encoded text</th></tr></thead><tbody>${['A','B','C'].map(k => `<tr><td>${k} · ${['one card','split components','shared compute'][['A','B','C'].indexOf(k)]}</td>${['cold_process','warm','warm_cached_conditioning'].map(r => {const v=p.regimes[k][r];return `<td>${fmt(v.median)} s<small>n=${v.n ?? '—'} · ${fmt(v.min)}–${fmt(v.max)} s</small></td>`;}).join('')}</tr>`).join('')}</tbody></table></div><p style="margin-top:12px">“Fresh process” does not mean cold disk: the files could be in the system caches. Archiving, restoration and preparation times are separate in the CSV.</p></details>
      <div class="thermal-note"><span class="eyebrow">THERMALS AND PCIe · BATCH OBSERVATIONS</span><h3>Historical measurements at 350 W; current setting at 300 W.</h3><p>${p.thermal.map(g => `GPU ${g.index}: peak ${g.maxC} °C; SW Thermal flag active on ${g.swThermalSamples}/${g.samples} samples, HW Thermal ${g.hwThermalSamples}.`).join(' ')} CPU: peak 95 °C. Card 1 also counted +667 corrected PCIe errors over 4 h 17; the identity of the card on the riser and the cause remain to be established.</p><p>These flags describe the historical batch at 350 W. At 300 W, the measured batch reaches 83 °C with no software thermal throttling observed; PCIe follow-up remains open. The current summary counts two batches interrupted then recovered; no PCIe causality established.</p></div>
      <details class="provenance"><summary>From brief to usable file · observed board</summary><p>This board describes the V5 workflow of October 6, before the new setups. It keeps its historical scope.</p><img src="${data.manualFigure}" alt="Observed HQ V5 workflow" loading="lazy">${link('/images/labo/manual','Open the manual')}</details>`;
  }
  function roadmap() {
    return `${pageHead('WHAT REMAINS TO BE SHOWN', 'The next step is concrete.', 'Baselines, receptions and integrations each have their place. Prepared trials stay separate from the gains actually measured.')}
      <div class="status-ribbon" style="margin-bottom:25px"><p><strong>Before any GPU batch</strong> · ${esc(coreSummary())}<br><small>Other sessions’ work keeps its reservations.</small></p>${link(href('machines'),'Fleet state')}</div>
      <div class="roadmap-grid">${[['acquis','01 · Achieved','The evidence we can already open.'],['prochain','02 · Next validations','Targeted trials, then a reception.'],['exploration','03 · Capabilities & integration','The ceiling remains to be built.']].map(([lane,title,desc]) => `<section class="lane" data-lane="${lane}"><div class="lane-title"><h2>${title}</h2><p>${desc}</p></div>${data.roadmap.filter(r => r.lane === lane).map(r => `<article class="roadmap-card"><div class="roadmap-owner">${esc(r.owner)}</div>${badge(r.state,lane === 'acquis' ? 'green' : lane === 'prochain' ? 'purple' : 'orange')}<h3>${esc(r.title)}</h3><p>${esc(r.detail)}</p><div class="next-step"><strong>Next validation</strong><p>${esc(r.next)}</p></div>${link(r.href || href(r.view || 'roadmap',r.group),'Open')}</article>`).join('')}</section>`).join('')}</div>
      <div class="boundary"><span>✦</span><p>The simple Nestor/Family request is delivered in its existing journey. This cockpit follows the qualification in the workshop. The overnight HQ queue, residency and permanent routing keep their own decisions.</p></div>`;
  }
  function fileCards() {
    const found = data.resources.filter(f => (fileCategory === 'all' || f.category === fileCategory) && `${f.title} ${f.detail} ${f.format}`.toLocaleLowerCase('fr').includes(fileSearch.toLocaleLowerCase('fr')));
    return found.length ? found.map(f => `<article class="file-card"><div class="file-top"><span class="format">${esc(f.format)}</span><span class="file-size">${bytes(f.bytes)}</span></div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p>${link(f.href,f.format === 'ZIP' ? 'Download the folder' : 'Open the file')}</article>`).join('') : '<p class="files-empty">No file for this filter. Try another word or “All”.</p>';
  }
  function files() {
    return `${pageHead('ORIGINALS, EXPORTS AND RECIPES', 'Find the right files.', 'The reproducible folders keep the brief, model, versions, graph, seed, reference and receipts. Received assets are separate from proposals.')}
      <div class="archive-box"><div><h3>The workshop share</h3><p>The trials have their own tree. The “generated” folder does not gather the whole campaign.</p><code>${esc(data.share)}</code><p style="font-size:10px;margin-top:9px">Performance: subfolder 2026-10-07-appui-performance, complete SHA256SUMS manifest; the campaign has since been completed. Some originals also remain in MAX-HQ on devX; the links below give the published paths of this selection.</p></div><button class="button light" id="copy-share">Copy the path</button></div>
      <div class="file-controls">${tabs(fileCategories,fileCategory,'file-category')}<label class="file-search"><span class="sr-only">Search for a file</span><input id="file-search" type="search" value="${esc(fileSearch)}" placeholder="Search for a logo, a report…" aria-label="Search for a file"></label></div><div class="files-grid" id="file-cards">${fileCards()}</div>
      <div class="section-title"><div><h2>History and detailed checks.</h2><p>Earlier steps stay viewable next to the cockpit.</p></div></div><div class="group-top-actions">${link(data.assetsReview,'Visual asset audit','button secondary')}${link('/images/labo/gallery','Historical gallery','button secondary')}${link('/images/labo/campaign/archive','Full log','button secondary')}${link('/images/labo/system','Former monitor','button secondary')}${link('/images/labo/manual','Manual','button secondary')}</div>`;
  }

  function render() {
    if (!data) return;
    $('#current-title').textContent = titles[current];
    document.title = `AgentX · ${titles[current]}`;
    $$('[data-view]').forEach(a => a.getAttribute('data-view') === current ? a.setAttribute('aria-current','page') : a.removeAttribute('aria-current'));
    $('#view').innerHTML = ({overview,compare,machines,roadmap,files,recipes:()=>window.ImageWorkshopLedger.renderRecipes(data),plan:()=>window.ImageWorkshopLedger.renderPlan(data)})[current]();
    bindView();
    window.ImageWorkshopLedger.bind(data,current);
  }
  function route() {
    const [name, query = ''] = location.hash.slice(1).split('?');
    if (name && !titles[name] && name !== 'content') { location.replace('/images/labo/campaign/archive#' + encodeURIComponent(name)); return; }
    if (name === 'content') { $('#content').focus(); return; }
    current = titles[name] ? name : 'overview';
    const requested = new URLSearchParams(query).get('group');
    if (requested && data?.groups.some(g => g.id === requested) && requested !== groupId) {
      groupId = requested; pair = [];
      if (category !== 'all' && group().category !== category) category = group().category;
    }
    render();
    window.scrollTo({top:0,behavior:'instant'});
  }
  function bindView() {
    $$('[data-category]').forEach(b => b.onclick = () => {
      category = b.dataset.category;
      if (category !== 'all' && group().category !== category) { groupId = data.groups.find(g => g.category === category).id; pair=[]; }
      history.replaceState(null,'',href('compare',groupId)); render();
    });
    if ($('#group-select')) $('#group-select').onchange = e => { groupId=e.target.value;pair=[];history.replaceState(null,'',href('compare',groupId));render(); };
    $$('[data-pair]').forEach(b => b.onchange = () => {
      const i = Number(b.dataset.pair);
      if (b.checked) { if (pair.length >= 2) pair.shift(); pair.push(i); } else pair=pair.filter(v => v !== i);
      $$('[data-pair]').forEach(c => { c.checked=pair.includes(Number(c.dataset.pair));c.closest('.image-card').classList.toggle('selected',c.checked); });
      $('#compare-pair').disabled=pair.length !== 2;
    });
    $$('[data-open]').forEach(b => b.onclick = () => {
      const i=Number(b.dataset.open), indexes=pair.includes(i) && pair.length === 2 ? pair : [i, pair.find(j=>j!==i) ?? (i===0 ? 1 : 0)];
      openViewer(indexes.map(j=>group().items[j]));
    });
    if ($('#compare-pair')) $('#compare-pair').onclick=()=>openViewer([...pair].sort((a,b)=>a-b).map(i=>group().items[i]));
    $$('[data-regime]').forEach(b => b.onclick=()=>{regime=b.dataset.regime;$('#architecture-panel').innerHTML=architecturePanel();bindView();});
    $$('[data-file-category]').forEach(b => b.onclick=()=>{fileCategory=b.dataset.fileCategory;render();});
    if ($('#file-search')) $('#file-search').oninput=e=>{fileSearch=e.target.value;$('#file-cards').innerHTML=fileCards();};
    if ($('#copy-share')) $('#copy-share').onclick=()=>copyText(data.share);
  }
  function toast(message) { clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3500); }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else { const field=document.createElement('textarea');field.value=text;field.style.position='fixed';field.style.left='-9999px';document.body.append(field);field.select();const ok=document.execCommand('copy');field.remove();if(!ok) throw new Error('copy'); }
      toast('Share path copied.');
    } catch { toast('Copy unavailable: select the path shown.'); }
  }

  function openViewer(items) {
    modalPair=items;viewerMode='side';priorFocus=document.activeElement;
    $('#viewer-title').textContent=group().title;
    const equal=items[0].width===items[1].width && items[0].height===items[1].height;
    $('#mode-wipe').disabled=!equal;
    $('#mode-wipe').title=equal ? 'Compare pixels at the same location' : 'Different dimensions: overlay turned off to keep the original dimensions.';
    $('#viewer-background').value='paper';$('#wipe').value=50;
    $('#viewer').showModal();document.body.style.overflow='hidden';
    const width=Math.max(100,($('#viewer').clientWidth-70)/2);
    zoom=Math.min(100,Math.floor(width/Math.max(...items.map(i=>i.width))*100));
    zoom=Math.max(10,zoom);drawViewer();
  }
  function drawViewer() {
    const equal=modalPair[0].width===modalPair[1].width && modalPair[0].height===modalPair[1].height;
    $('#mode-side').setAttribute('aria-pressed',String(viewerMode==='side'));
    $('#mode-wipe').setAttribute('aria-pressed',String(viewerMode==='wipe'));
    $('#wipe-controls').hidden=viewerMode!=='wipe';
    $('#viewer-panels').classList.toggle('wipe-mode',viewerMode==='wipe');
    const label=p=>`<div class="viewer-label"><span>${esc(p.title)} · ${dims(p)} px</span>${link(p.original,'Original')}</div>`;
    if (viewerMode==='side') $('#viewer-panels').innerHTML=modalPair.map(p=>`<section class="viewer-panel">${label(p)}<div class="zoom-pane"><img src="${p.original}" alt="${esc(p.title)}"></div></section>`).join('');
    else $('#viewer-panels').innerHTML=`<section class="viewer-panel">${label(modalPair[0])}${label(modalPair[1])}<div class="zoom-pane"><div class="wipe-stage"><img src="${modalPair[0].original}" alt="${esc(modalPair[0].title)}"><div class="wipe-overlay"><img src="${modalPair[1].original}" alt="${esc(modalPair[1].title)}"></div><div class="wipe-divider"></div></div></div></section>`;
    $('#viewer-note').textContent=equal ? 'The originals are loaded. “Native 100%” shows one image pixel per CSS pixel at a browser zoom of 100%. To look for detail: zoom in, then move the views.' : 'Different original dimensions. Relative scrolling synchronized, overlay turned off; no hidden resizing to make the compositions match.';
    $$('.zoom-pane').forEach(p => p.addEventListener('scroll',()=>{
      if(scrollGuard||viewerMode!=='side')return;scrollGuard=true;
      $$('.zoom-pane').filter(q=>q!==p).forEach(q=>{q.scrollLeft=(p.scrollLeft/Math.max(1,p.scrollWidth-p.clientWidth))*(q.scrollWidth-q.clientWidth);q.scrollTop=(p.scrollTop/Math.max(1,p.scrollHeight-p.clientHeight))*(q.scrollHeight-q.clientHeight);});
      requestAnimationFrame(()=>scrollGuard=false);
    }));
    $$('.zoom-pane img').forEach(img=>img.onerror=()=>toast('An original is unavailable. The file link stays available.'));
    setZoom(zoom);setBackground();setWipe();
  }
  function setZoom(value) {
    zoom=Number(value);$('#zoom').value=zoom;$('#zoom-label').textContent=`${zoom}%`;
    if(viewerMode==='side') $$('.zoom-pane>img').forEach((img,i)=>{img.style.width=`${modalPair[i].width*zoom/100}px`;});
    else $('.wipe-stage').style.width=`${modalPair[0].width*zoom/100}px`;
  }
  function setBackground() {$$('.zoom-pane').forEach(p=>p.dataset.background=$('#viewer-background').value);}
  function setWipe() { const value=$('#wipe').value;$('#wipe-label').textContent=`${value}%`;if($('.wipe-overlay')){$('.wipe-overlay').style.clipPath=`inset(0 ${100-value}% 0 0)`;$('.wipe-divider').style.left=`${value}%`;} }
  $('#viewer-close').onclick=()=>$('#viewer').close();
  $('#viewer').addEventListener('close',()=>{document.body.style.overflow='';priorFocus?.focus();});
  $('#mode-side').onclick=()=>{viewerMode='side';drawViewer();};
  $('#mode-wipe').onclick=()=>{if(!$('#mode-wipe').disabled){viewerMode='wipe';drawViewer();}};
  $('#zoom').oninput=e=>setZoom(e.target.value);$('#zoom-native').onclick=()=>setZoom(100);
  $('#zoom-fit').onclick=()=>{const width=$('.zoom-pane').clientWidth;setZoom(Math.max(10,Math.min(100,Math.floor(width/Math.max(...modalPair.map(p=>p.width))*100))));};
  $('#viewer-background').onchange=setBackground;$('#wipe').oninput=setWipe;

  async function refresh(initial=false) {
    if(loading)return;loading=true;$('#refresh').disabled=true;
    try {
      const response=await fetch('/images/labo/api/lab',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('api');
      let next=await response.json();if(!next.groups?.length)throw new Error('catalogue');
      let ledger;
      try {
        const r=await fetch('/images/labo/lab-resources/ready/ledger.json',{cache:'no-store',signal:AbortSignal.timeout(8000)});
        if(!r.ok)throw new Error('ledger');ledger=await r.json();
      } catch { ledger=data?.ready; }
      next=window.ImageWorkshopLedger.apply(next,ledger);
      const changed=next.revision!==data?.revision;data=next;
      $('#updated').textContent=`Read ${stamp(data.servedAt)}`;
      $('#connection-note').hidden=true;
      if(initial)route();
      else if(!$('#viewer').open && !(current==='recipes' && $('#content').contains(document.activeElement)) && (changed || (['overview','machines','roadmap'].includes(current) && !$('#content').contains(document.activeElement))))render();
    } catch {
      $('#connection-note').textContent=data ? 'Refresh unavailable. The last loaded folders stay displayed; their date is authoritative.' : 'The reading does not answer. Try again with ↻; the historical log stays available.';
      $('#connection-note').hidden=false;
      if(!data)$('#view').innerHTML=`<div class="loading"><h1>The reading waits for its connection.</h1><p>The folders stay available.</p>${link('/images/labo/campaign/archive','Open the log','button')}</div>`;
    } finally {loading=false;$('#refresh').disabled=false;}
  }
  $('#refresh').onclick=()=>refresh(!data);
  window.addEventListener('hashchange',route);
  setInterval(()=>{if(!document.hidden)refresh(!data);},20000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(!data);});
  refresh(true);
})();
