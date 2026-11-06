/* Math Lab card (#1270): a function y = f(x) drawn from its validated formula,
   with one slider per parameter. Phase 1 bridge: a plain 2D SVG plot in AgentX
   until GraphysX's formula field can draw any validated expression (phase 2).
   Every point comes from the formula through AgentXMathExpression, never from
   numbers the model wrote. */
(function (root) {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  const HEIGHT = 320, PAD = { left: 40, right: 12, top: 12, bottom: 28 };

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
    const { plot, tree } = parsed;
    const values = Object.fromEntries(plot.parameters.map(row => [row.name, row.value]));

    const formula = el('p', 'math-plot-formula');
    const chart = svg('svg', { class: 'math-plot-chart', role: 'img' });
    let WIDTH = 480;
    const clipId = 'math-clip-' + Math.random().toString(36).slice(2, 10);
    const defs = svg('defs'), clip = svg('clipPath', { id: clipId });
    const clipRect = svg('rect', { x: PAD.left, y: PAD.top, height: HEIGHT - PAD.top - PAD.bottom });
    clip.append(clipRect);
    defs.append(clip);
    const grid = svg('g', { class: 'math-plot-grid' }), axes = svg('g', { class: 'math-plot-axes' }), labels = svg('g', { class: 'math-plot-labels' });
    const curve = svg('path', { class: 'math-plot-curve', 'clip-path': `url(#${clipId})`, fill: 'none' });
    chart.append(defs, grid, axes, curve, labels);

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
    function draw() {
      chart.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
      clipRect.setAttribute('width', WIDTH - PAD.left - PAD.right);
      const points = math.sample(tree, plot, values);
      const [x0, x1] = plot.x, [y0, y1] = math.fitY(points, plot);
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
      // Break the line where the function is undefined or jumps across an asymptote.
      const span = y1 - y0, clamp = y => Math.max(top - (bottom - top), Math.min(bottom + (bottom - top), py(y)));
      let path = '', previous = null;
      for (const [x, y] of points) {
        if (y === null) { previous = null; continue; }
        const jump = previous !== null && Math.abs(y - previous) > span * 2;
        path += (previous === null || jump ? 'M' : 'L') + px(x).toFixed(1) + ' ' + clamp(y).toFixed(1);
        previous = y;
      }
      curve.setAttribute('d', path);
      const shown = pretty(plot.expression);
      formula.replaceChildren(el('strong', '', 'y = ' + shown));
      if (plot.parameters.length) formula.append(el('span', 'math-plot-values',
        plot.parameters.map(row => `${row.name} = ${math.formatNumber(values[row.name])}`).join(', ')));
      chart.setAttribute('aria-label', `Graphique de y = ${shown}${plot.parameters.length ? ', ' + plot.parameters.map(row => `${row.name} = ${math.formatNumber(values[row.name])}`).join(', ') : ''}, x de ${label(x0)} à ${label(x1)}`);
    }

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
        draw();
        holder.dispatchEvent(new CustomEvent('math-plot-change', { bubbles: true, detail: { name: row.name, value: values[row.name] } }));
      });
      line.append(el('span', 'math-plot-name', row.name), input, output);
      controls.append(line);
    }
    draw();
    holder.append(formula, chart);
    if (plot.parameters.length) holder.append(controls);
    holder.append(el('p', 'math-plot-note', 'Tracé calculé à partir de la formule (aperçu 2D en attendant la scène GraphysX).'));
    // What Nestor reads when this card is selected: the formula with the current slider values.
    holder._mathText = () => math.plotText(plot, values);
    if (root.ResizeObserver) new root.ResizeObserver(() => { if (fit()) draw(); }).observe(holder);
    return holder;
  }

  root.NestorMathPlot = Object.freeze({ create });
}(typeof window !== 'undefined' ? window : globalThis));
