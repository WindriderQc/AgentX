/* Math Lab card (#1270): one to four functions y = f(x) drawn from their
   validated formulas, compared on the same axes, with one slider per parameter.
   Phase 2: the picture is GraphysX's <llmx-stage> (agentx.math-scene.v2), the
   Math Game in 3D; a plain 2D SVG plot stays as the fallback when the 3D module
   is missing, older, refused the scene or has no WebGL, and as a "2D view".
   Every point comes from the formula through AgentXMathExpression (and its
   GraphysX port), never from numbers the model wrote. */
(function (root) {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  const HEIGHT = 320, PAD = { left: 40, right: 12, top: 12, bottom: 28 };
  const STAGE_SCHEMA = 'agentx.math-scene.v2';
  // The same order as GraphysX's palette, sent explicitly so the legend always matches the picture.
  const COLORS = Object.freeze(['#ffe86b', '#60d6e8', '#ff7a6b', '#9dff8a']);
  const STAGE_WAIT_MS = 4000;
  // Each 3D card holds a WebGL context and browsers allow only a few: the oldest cards fall back to 2D.
  const LIVE_STAGES = 3;
  const live = [];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svg(tag, attributes = {}) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  function ticks(low, high) {
    const size = niceStep(high - low), first = Math.ceil(low / size) * size, values = [];
    for (let value = first; value <= high + size * 1e-9 && values.length < 30; value += size) values.push(Math.abs(value) < size * 1e-9 ? 0 : value);
    return values;
  }
  // 1, 2 or 5 times a power of ten, about six steps across the window.
  function niceStep(span) {
    const raw = span / 6, power = Math.pow(10, Math.floor(Math.log10(raw))), unit = raw / power;
    return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
  }
  // A round slider step (1, 2 or 5 times a power of ten) giving at least 100 positions:
  // a range of [-3, 3] moves by 0.05, so 2.5 is reachable and reads 2.5.
  function sliderStep(span) {
    const raw = span / 100, power = Math.pow(10, Math.floor(Math.log10(raw))), unit = raw / power;
    return Number(((unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * power).toPrecision(6));
  }
  // Integer powers read as superscripts on screen: x^2 → x². The stored formula keeps ^.
  const SUPERSCRIPT = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  const pretty = expression => expression.replace(/\*/g, '·').replace(/\^(\d+)/g, (_, digits) => digits.replace(/\d/g, d => SUPERSCRIPT[d]));
  const label = value => Number(value.toPrecision(4)).toString().replace('-', '−');

  // The 3D element when this page has (or can load) a version that draws functions; null otherwise.
  function stageElement() {
    const registry = root.customElements;
    if (!registry) return Promise.resolve(null);
    const supported = () => (registry.get('llmx-stage')?.schemas || []).includes(STAGE_SCHEMA) ? registry.get('llmx-stage') : null;
    if (registry.get('llmx-stage')) return Promise.resolve(supported());
    // The avatar dock relays GraphysX's module; ask for it even when the avatar is hidden.
    root.AvatarDock?.loadFace?.();
    return Promise.race([registry.whenDefined('llmx-stage').then(supported),
      new Promise(resolve => setTimeout(() => resolve(null), STAGE_WAIT_MS))]);
  }

  function create(block) {
    const math = root.AgentXMathExpression;
    const holder = el('div', 'math-plot');
    const parsed = math ? math.parsePlot(block.body) : null;
    if (!parsed?.ok) {
      holder.dataset.state = 'unavailable';
      holder.append(el('p', 'display-block-note', parsed ? 'Formule non tracée : ' + parsed.error.message : 'Le traceur de formules n’est pas chargé.'),
        el('pre', 'display-block-code', block.body));
      holder._mathText = () => '';
      return holder;
    }
    holder.dataset.state = 'visible';
    holder.dataset.view = '2d';
    const { plot, trees } = parsed;
    const values = Object.fromEntries(plot.parameters.map(row => [row.name, row.value]));
    const colors = plot.functions.map((_, index) => COLORS[index]);

    const formula = el('div', 'math-plot-formula');
    const view = el('div', 'math-plot-view');
    const chart = svg('svg', { class: 'math-plot-chart', role: 'img' });
    let WIDTH = 480;
    const clipId = 'math-clip-' + Math.random().toString(36).slice(2, 10);
    const defs = svg('defs'), clip = svg('clipPath', { id: clipId });
    const clipRect = svg('rect', { x: PAD.left, y: PAD.top, height: HEIGHT - PAD.top - PAD.bottom });
    clip.append(clipRect);
    defs.append(clip);
    const grid = svg('g', { class: 'math-plot-grid' }), axes = svg('g', { class: 'math-plot-axes' }), labels = svg('g', { class: 'math-plot-labels' });
    const curves = plot.functions.map((_, index) => svg('path', { class: 'math-plot-curve', 'clip-path': `url(#${clipId})`, fill: 'none', stroke: colors[index] }));
    chart.append(defs, grid, axes, ...curves, labels);
    view.append(chart);

    // A wide card gets a wider chart instead of a small one centred in empty space.
    function fit() {
      const width = holder.clientWidth;
      if (!width) return false;
      const height = Math.max(200, Math.min(width * 2 / 3, (root.innerHeight || 800) - 360));
      const next = Math.max(480, Math.min(1100, Math.round(HEIGHT * width / height / 40) * 40));
      if (next === WIDTH && chart.hasAttribute('viewBox')) return false;
      WIDTH = next;
      return true;
    }
    const valuesText = () => plot.parameters.map(row => `${row.name} = ${math.formatNumber(values[row.name])}`).join(', ');
    function legend() {
      formula.replaceChildren();
      plot.functions.forEach((fn, index) => {
        const line = el('p', 'math-plot-function');
        const swatch = el('span', 'math-plot-swatch');
        swatch.style.background = colors[index];
        line.append(swatch, el('strong', '', `${fn.label} = ${pretty(fn.expression)}`));
        formula.append(line);
      });
      if (plot.parameters.length) formula.append(el('span', 'math-plot-values', valuesText()));
    }
    function draw() {
      chart.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
      clipRect.setAttribute('width', WIDTH - PAD.left - PAD.right);
      const samples = trees.map(tree => math.sample(tree, plot, values));
      const [x0, x1] = plot.x, [y0, y1] = math.fitY(samples.flat(), plot);
      const left = PAD.left, right = WIDTH - PAD.right, top = PAD.top, bottom = HEIGHT - PAD.bottom;
      const px = x => left + (x - x0) / (x1 - x0) * (right - left);
      const py = y => bottom - (y - y0) / (y1 - y0) * (bottom - top);
      grid.replaceChildren(); axes.replaceChildren(); labels.replaceChildren();
      for (const x of ticks(x0, x1)) {
        grid.append(svg('line', { x1: px(x), x2: px(x), y1: top, y2: bottom }));
        const text = svg('text', { x: px(x), y: HEIGHT - 8, 'text-anchor': 'middle' }); text.textContent = label(x); labels.append(text);
      }
      for (const y of ticks(y0, y1)) {
        grid.append(svg('line', { x1: left, x2: right, y1: py(y), y2: py(y) }));
        const text = svg('text', { x: left - 6, y: py(y) + 5, 'text-anchor': 'end' }); text.textContent = label(y); labels.append(text);
      }
      // The axes through zero when zero is in view, otherwise along the frame.
      const ax = x0 <= 0 && x1 >= 0 ? px(0) : left, ay = y0 <= 0 && y1 >= 0 ? py(0) : bottom;
      axes.append(svg('line', { x1: left, x2: right, y1: ay, y2: ay }), svg('line', { x1: ax, x2: ax, y1: top, y2: bottom }));
      // Break each line where its function is undefined or jumps across an asymptote.
      const span = y1 - y0, clamp = y => Math.max(top - (bottom - top), Math.min(bottom + (bottom - top), py(y)));
      samples.forEach((points, index) => {
        let path = '', previous = null;
        for (const [x, y] of points) {
          if (y === null) { previous = null; continue; }
          const jump = previous !== null && Math.abs(y - previous) > span * 2;
          path += (previous === null || jump ? 'M' : 'L') + px(x).toFixed(1) + ' ' + clamp(y).toFixed(1);
          previous = y;
        }
        curves[index].setAttribute('d', path);
      });
      const shown = plot.functions.map(fn => `${fn.label} = ${pretty(fn.expression)}`).join(' ; ');
      chart.setAttribute('aria-label', `Graphique de ${shown}${plot.parameters.length ? ', ' + valuesText() : ''}, x de ${label(x0)} à ${label(x1)}`);
    }

    const note = el('p', 'math-plot-note');
    const toggle = el('button', 'display-block-action math-plot-toggle', 'Vue 2D');
    toggle.type = 'button';
    toggle.hidden = true;
    let stage = null, preferred = '3d';
    function show(mode) {
      const threeD = mode === '3d' && stage?.isConnected;
      holder.dataset.view = threeD ? '3d' : '2d';
      // An SVG element has no `hidden` property; the attribute is what the stylesheet reads.
      chart.toggleAttribute('hidden', threeD);
      if (stage) stage.hidden = !threeD;
      toggle.textContent = threeD ? 'Vue 2D' : 'Vue 3D';
      const state = holder.dataset.stage || 'loading';
      note.textContent = threeD ? 'Scène 3D GraphysX calculée à partir des formules. Glissez pour la tourner, double-clic pour revenir.'
        : stage || state === 'released' ? 'Tracé 2D calculé à partir des formules.'
          : state === 'loading' ? 'Tracé 2D calculé à partir des formules, en attendant la scène 3D.'
            : 'Tracé 2D calculé à partir des formules (la scène 3D n’est pas disponible).';
      if (!threeD) draw();
    }
    function release() {
      const index = live.indexOf(holder);
      if (index >= 0) live.splice(index, 1);
      if (!stage) return;
      stage.remove();
      stage = null;
      holder.dataset.stage = 'released';
      show('2d');
    }
    function mountStage() {
      holder.dataset.stage = 'loading';
      stageElement().then(Stage => {
        if (!holder.isConnected && holder.dataset.stage === 'disposed') return;
        if (!Stage) { holder.dataset.stage = 'unavailable'; show('2d'); return; }
        const element = document.createElement('llmx-stage');
        element.className = 'math-plot-stage';
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', chart.getAttribute('aria-label') || 'Scène 3D');
        element.addEventListener('llmx-scene-applied', () => {
          holder.dataset.stage = 'applied';
          stage = element;
          live.push(holder);
          while (live.length > LIVE_STAGES) live[0]._releaseStage();
          toggle.hidden = false;
          show(preferred);
        }, { once: true });
        const fallBack = reason => { holder.dataset.stage = reason; element.remove(); stage = null; toggle.hidden = true; show('2d'); };
        element.addEventListener('llmx-scene-rejected', event => fallBack('rejected:' + (event.detail?.reason || 'unknown')), { once: true });
        element.addEventListener('llmx-stage-error', () => fallBack('no-webgl'), { once: true });
        element.hidden = true;
        // Declared colours keep the legend and the picture in agreement; y only when the block fixed it.
        element.scene = { schema: STAGE_SCHEMA, kind: 'functions', x: plot.x.slice(), ...(plot.y ? { y: plot.y.slice() } : {}),
          functions: plot.functions.map((fn, index) => ({ name: fn.name, label: fn.label, expression: fn.expression, color: colors[index] })),
          parameters: plot.parameters.map(row => ({ ...row, value: values[row.name] })) };
        view.append(element);
      });
    }
    holder._releaseStage = release;
    toggle.addEventListener('click', () => {
      if (!stage) { preferred = '3d'; mountStage(); return; }
      preferred = holder.dataset.view === '3d' ? '2d' : '3d';
      show(preferred);
    });

    const controls = el('div', 'math-plot-controls');
    for (const row of plot.parameters) {
      const line = el('label', 'math-plot-slider');
      const input = el('input');
      input.type = 'range'; input.min = String(row.min); input.max = String(row.max);
      input.step = String(sliderStep(row.max - row.min)); input.value = String(row.value);
      input.setAttribute('aria-label', 'Paramètre ' + row.name);
      const output = el('output', 'math-plot-output', math.formatNumber(row.value));
      input.addEventListener('input', () => {
        // Keep values on the slider grid but readable: 1.25, not 1.2500000001.
        values[row.name] = Number(math.formatNumber(Number(input.value)));
        output.textContent = math.formatNumber(values[row.name]);
        legend();
        if (stage) stage.parameters = { [row.name]: values[row.name] };
        if (holder.dataset.view !== '3d') draw();
        holder.dispatchEvent(new CustomEvent('math-plot-change', { bubbles: true, detail: { name: row.name, value: values[row.name] } }));
      });
      line.append(el('span', 'math-plot-name', row.name), input, output);
      controls.append(line);
    }
    legend();
    draw();
    show('2d');
    holder.append(formula, view);
    if (plot.parameters.length) holder.append(controls);
    const footer = el('div', 'math-plot-footer');
    footer.append(note, toggle);
    holder.append(footer);
    // What Nestor reads when this card is selected: the formulas with the current slider values.
    holder._mathText = () => math.plotText(plot, values);
    holder._mathView = () => holder.dataset.view;
    holder._dispose = () => { holder.dataset.stage = 'disposed'; release(); };
    if (root.ResizeObserver) new root.ResizeObserver(() => { if (fit() && holder.dataset.view !== '3d') draw(); }).observe(holder);
    mountStage();
    return holder;
  }

  root.NestorMathPlot = Object.freeze({ create, COLORS, STAGE_SCHEMA });
}(typeof window !== 'undefined' ? window : globalThis));
