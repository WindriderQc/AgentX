/* Math Lab card (#1270): one to four functions y = f(x) drawn from their
   validated formulas, compared on the same axes, with one slider per parameter.
   Phase 2: the picture is GraphysX's <llmx-stage> (agentx.math-scene.v2), the
   Math Game in 3D; a plain 2D SVG plot stays as the fallback when the 3D module
   is missing, older, refused the scene or has no WebGL, and as a "2D view".
   Phase 3: dashed derivative curves, tangents that follow a slider, shaded
   areas with their value, and functions that use other functions; GraphysX
   draws them from agentx.math-scene.v3, older modules leave the card in 2D.
   Then parametric curves c(t) beside the functions, and surfaces z = f(x, y):
   GraphysX draws them from agentx.math-scene.v4; the 2D view shows a surface
   from above, shaded by height with its contour lines.
   Every point comes from the formula through AgentXMathExpression (and its
   GraphysX port), never from numbers the model wrote. */
(function (root) {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  const HEIGHT = 320, PAD = { left: 40, right: 12, top: 12, bottom: 28 };
  const STAGE_SCHEMA = 'agentx.math-scene.v2';
  // Derivatives, tangents, areas and functions using functions need the phase 3 scene.
  const CALCULUS_SCHEMA = 'agentx.math-scene.v3';
  // Parametric curves and surfaces need the v4 scene.
  const SHAPES_SCHEMA = 'agentx.math-scene.v4';
  // The low end of a surface's height shading in the 2D view (the high end is its colour).
  const LOW_COLOR = '#0b1a2e';
  const TANGENT_COLOR = '#f4f7fb';
  // GraphysX's area fill: over a function's own molecules its colour would not show. Edges keep the function's colour.
  const AREA_COLOR = '#9fd7ff';
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
  // Widen one window so a unit is as long across as up (as GraphysX does for curves alone): a circle stays round.
  function equalUnits(x, y, aspect) {
    const xs = x[1] - x[0], ys = y[1] - y[0];
    if (xs / ys < aspect) { const half = ys * aspect / 2, centre = (x[0] + x[1]) / 2; return [[centre - half, centre + half], y]; }
    const half = xs / aspect / 2, centre = (y[0] + y[1]) / 2;
    return [x, [centre - half, centre + half]];
  }
  // A colour between two #rrggbb, k from 0 to 1.
  function mix(from, to, k) {
    const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
    return '#' + [1, 3, 5].map(at => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * k).toString(16).padStart(2, '0')).join('');
  }
  // Contour lines of a grid of heights at `level` (marching squares): [[x1, y1, x2, y2], …] in grid units.
  // rows[j][i] is the height at column i, row j; a cell touching an undefined height has no line.
  const CASES = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]],
    10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] };
  function contour(rows, level) {
    const lines = [];
    for (let j = 0; j + 1 < rows.length; j += 1) {
      for (let i = 0; i + 1 < rows[j].length; i += 1) {
        const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i + 1], d = rows[j + 1][i];
        if (a === null || b === null || c === null || d === null) continue;
        const pairs = CASES[(a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0)];
        if (!pairs) continue;
        const k = (p, q) => (level - p) / (q - p);
        // Edges: 0 bottom (a→b), 1 right (b→c), 2 top (d→c), 3 left (a→d).
        const edge = e => (e === 0 ? [i + k(a, b), j] : e === 1 ? [i + 1, j + k(b, c)] : e === 2 ? [i + k(d, c), j + 1] : [i, j + k(a, d)]);
        for (const [from, to] of pairs) lines.push([...edge(from), ...edge(to)]);
      }
    }
    return lines;
  }

  // The 3D element when this page has (or can load) a version that draws `schema`; null otherwise.
  function stageElement(schema) {
    const registry = root.customElements;
    if (!registry) return Promise.resolve(null);
    const supported = () => (registry.get('llmx-stage')?.schemas || []).includes(schema) ? registry.get('llmx-stage') : null;
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
    const surfaced = plot.kind === 'surfaces';
    const functions = plot.functions || [], parametric = plot.curves || [], sheets = plot.surfaces || [];
    const derivatives = plot.derivatives || [], tangents = plot.tangents || [], areas = plot.areas || [];
    const schema = surfaced || parametric.length ? SHAPES_SCHEMA
      : parsed.references || derivatives.length || tangents.length || areas.length ? CALCULUS_SCHEMA : STAGE_SCHEMA;
    const colorOf = name => colors[functions.findIndex(fn => fn.name === name)];
    const nameOf = name => (name === 'y' ? 'y' : `${name}(x)`);
    // Positions saved in Core for this card start where they were left; invalid ones are ignored.
    const saved = block.values ? math.checkValues(plot, block.values) : null;
    const values = saved?.ok ? { ...saved.values } : Object.fromEntries(plot.parameters.map(row => [row.name, row.value]));
    // Functions, then curves, take the palette in order (as GraphysX does); surfaces start it again.
    const colors = [...functions, ...parametric].map((_, index) => COLORS[index]);
    const sheetColors = sheets.map((_, index) => COLORS[index]);
    const curveColor = index => colors[functions.length + index];

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
    const clipped = attributes => ({ 'clip-path': `url(#${clipId})`, ...attributes });
    const curves = functions.map((_, index) => svg('path', clipped({ class: 'math-plot-curve', fill: 'none', stroke: colors[index] })));
    const paths = parametric.map((_, index) => svg('path', clipped({ class: 'math-plot-curve math-plot-parametric', fill: 'none', stroke: curveColor(index) })));
    // A surface seen from above: cells shaded by height (one surface), its contour lines and the edge of its window.
    const field = svg('g', clipped({ class: 'math-plot-field' })), levels = svg('g', clipped({ class: 'math-plot-levels' }));
    const domain = svg('rect', { class: 'math-plot-domain', fill: 'none' });
    const shades = areas.map(row => svg('path', clipped({ class: 'math-plot-area', fill: AREA_COLOR, stroke: colorOf(row.of) })));
    const slopes = derivatives.map(name => svg('path', clipped({ class: 'math-plot-curve math-plot-derivative', fill: 'none', stroke: colorOf(name) })));
    const touches = tangents.map(() => svg('line', clipped({ class: 'math-plot-tangent', stroke: TANGENT_COLOR })));
    const dots = tangents.map(row => svg('circle', { class: 'math-plot-touch', r: 5, fill: colorOf(row.of), stroke: TANGENT_COLOR }));
    if (!surfaced) domain.setAttribute('hidden', '');
    // The shading covers the grid inside the surface's window; the axes and contours stay on top.
    chart.append(defs, grid, field, axes, levels, domain, ...shades, ...curves, ...slopes, ...paths, ...touches, ...dots, labels);
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
    const entry = (kind, color, text) => {
      const line = el('p', 'math-plot-function' + (kind ? ' math-plot-legend-' + kind : ''));
      const swatch = el('span', 'math-plot-swatch');
      // One surface is shaded from dark (low) to its colour (high): the swatch shows that scale.
      swatch.style.background = kind === 'area' ? AREA_COLOR : kind === 'surface' && sheets.length === 1 ? `linear-gradient(90deg, ${LOW_COLOR}, ${color})` : color;
      if (kind === 'area') swatch.style.boxShadow = `inset 0 0 0 2px ${color}`;
      line.append(swatch, el(kind === 'tangent' || kind === 'area' ? 'span' : 'strong', '', text));
      formula.append(line);
    };
    const tText = () => `t de ${label(plot.t[0])} à ${label(plot.t[1])}`;
    const heightsText = () => {
      const [z0, z1] = math.windowsOf(parsed, values).z;
      return `Vue de dessus : hauteur z de ${label(z0)} à ${label(z1)}` + (sheets.length === 1 ? ', sombre en bas, clair en haut' : '')
        + `, une ligne de niveau tous les ${label(niceStep(z1 - z0))}, z = 0 en gras` + (plot.z ? ' ; hors de cette fenêtre, la surface est laissée vide.' : '.');
    };
    // Slopes and areas are computed here from the formula with the current slider values.
    const tangentText = row => {
      const t = math.tangentAt(parsed, row, values);
      return `Tangente à ${nameOf(row.of)} en x = ${label(t.x)} : ` + (t.slope === null ? 'non définie ici' : `pente ${label(t.slope)}`);
    };
    const areaText = row => {
      const a = areaOfRow(row), where = `Aire sous ${nameOf(row.of)} de ${label(a.from)} à ${label(a.to)}`;
      if (a.value === null) return `${where} : non définie (${nameOf(row.of)} n’est pas définie partout entre les bornes)`;
      return `${where} : ${label(a.value)}` + (a.dips ? ' (la partie sous l’axe compte en moins)' : '');
    };
    function areaOfRow(row) {
      const a = math.areaOf(parsed, row, values), index = functions.findIndex(fn => fn.name === row.of);
      const low = Math.min(a.from, a.to), high = Math.max(a.from, a.to), scope = { ...values };
      let below = false;
      for (let i = 0; i <= 64 && high > low; i += 1) {
        const y = math.evaluate(trees[index], { ...scope, x: low + (high - low) * i / 64 });
        if (y < 0) below = true;
      }
      return { ...a, dips: below };
    }
    function legend() {
      formula.replaceChildren();
      functions.forEach((fn, index) => entry('', colors[index], `${fn.label} = ${pretty(fn.expression)}`));
      parametric.forEach((row, index) => entry('curve', curveColor(index), `${row.label} = (${pretty(row.x)}, ${pretty(row.y)})`));
      sheets.forEach((row, index) => entry('surface', sheetColors[index], `${row.label} = ${pretty(row.expression)}`));
      derivatives.forEach(name => entry('derivative', colorOf(name), `${math.derivativeLabel(name)} = ${pretty(math.format(parsed.slopes[name]))}`));
      tangents.forEach(row => entry('tangent', TANGENT_COLOR, tangentText(row)));
      areas.forEach(row => entry('area', colorOf(row.of), areaText(row)));
      if (surfaced) formula.append(el('span', 'math-plot-heights', heightsText()));
      if (parametric.length) formula.append(el('span', 'math-plot-values', tText()));
      if (plot.parameters.length) formula.append(el('span', 'math-plot-values', valuesText()));
    }
    function draw() {
      chart.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
      clipRect.setAttribute('width', WIDTH - PAD.left - PAD.right);
      const left = PAD.left, right = WIDTH - PAD.right, top = PAD.top, bottom = HEIGHT - PAD.bottom;
      // Functions and their derivatives over x; the windows are the grammar's (declared, else fitted).
      const samples = functions.length ? math.curves(parsed).map(tree => math.sample(tree, plot, values)) : [];
      const drawn = math.windowsOf(parsed, values);
      // A surface's ground and curves alone with no declared window: a unit as long across as up, so a circle stays round.
      const square = surfaced || (!functions.length && !plot.x && !plot.y);
      const [[x0, x1], [y0, y1]] = square ? equalUnits(drawn.x, drawn.y, (right - left) / (bottom - top)) : [drawn.x, drawn.y];
      const px = x => left + (x - x0) / (x1 - x0) * (right - left);
      const py = y => bottom - (y - y0) / (y1 - y0) * (bottom - top);
      grid.replaceChildren(); axes.replaceChildren(); labels.replaceChildren(); field.replaceChildren(); levels.replaceChildren();
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
        (curves[index] || slopes[index - curves.length]).setAttribute('d', path);
      });
      // Parametric curves: the points (x(t), y(t)) in order of t, broken where undefined or where they leap across the chart.
      const far = v => Math.max(-1e5, Math.min(1e5, v)).toFixed(1);
      parametric.forEach((_, index) => {
        let path = '', previous = null;
        for (const point of math.sampleCurve(parsed.curveTrees[index], plot, values)) {
          if (!point) { previous = null; continue; }
          const at = [px(point[0]), py(point[1])];
          const leap = previous && Math.hypot(at[0] - previous[0], at[1] - previous[1]) > (bottom - top) * 2;
          path += (!previous || leap ? 'M' : 'L') + far(at[0]) + ' ' + far(at[1]);
          previous = at;
        }
        paths[index].setAttribute('d', path);
      });
      if (surfaced) drawSurfaces(drawn.z, px, py);
      // Areas: from the curve to the x axis between the bounds, broken where the function is undefined.
      areas.forEach((row, index) => {
        const a = math.areaOf(parsed, row, values), low = Math.min(a.from, a.to), high = Math.max(a.from, a.to);
        const tree = trees[functions.findIndex(fn => fn.name === row.of)], base = clamp(0);
        let path = '', open = [];
        const close = () => { if (open.length > 1) path += 'M' + open[0][0] + ' ' + base.toFixed(1) + open.map(([x, y]) => 'L' + x + ' ' + y).join('') + 'L' + open[open.length - 1][0] + ' ' + base.toFixed(1) + 'Z'; open = []; };
        for (let i = 0; i <= 160 && high > low; i += 1) {
          const x = low + (high - low) * i / 160, y = math.evaluate(tree, { ...values, x });
          if (!Number.isFinite(y)) { close(); continue; }
          open.push([px(x).toFixed(1), clamp(y).toFixed(1)]);
        }
        close();
        shades[index].setAttribute('d', path);
      });
      // Tangents: the line through the point of contact with the computed slope, across the window.
      tangents.forEach((row, index) => {
        const t = math.tangentAt(parsed, row, values), line = touches[index], dot = dots[index];
        const drawn = t.slope !== null;
        line.toggleAttribute('hidden', !drawn);
        dot.toggleAttribute('hidden', !drawn || t.y < y0 || t.y > y1);
        if (!drawn) return;
        line.setAttribute('x1', px(x0)); line.setAttribute('y1', py(t.y + t.slope * (x0 - t.x)));
        line.setAttribute('x2', px(x1)); line.setAttribute('y2', py(t.y + t.slope * (x1 - t.x)));
        dot.setAttribute('cx', px(t.x)); dot.setAttribute('cy', py(t.y));
      });
      if (surfaced) {
        const shown = sheets.map(row => `${row.label} = ${pretty(row.expression)}`).join(' ; ');
        chart.setAttribute('aria-label', `Surface vue de dessus : ${shown}${plot.parameters.length ? ', ' + valuesText() : ''}, x de ${label(plot.x[0])} à ${label(plot.x[1])}`
          + `, y de ${label(plot.y[0])} à ${label(plot.y[1])}, hauteur de ${label(drawn.z[0])} à ${label(drawn.z[1])}`);
        return;
      }
      const shown = [...functions.map(fn => `${fn.label} = ${pretty(fn.expression)}`),
        ...parametric.map(row => `courbe ${row.label} = (${pretty(row.x)}, ${pretty(row.y)})`),
        ...derivatives.map(name => `dérivée ${math.derivativeLabel(name)}`), ...tangents.map(tangentText), ...areas.map(areaText)].join(' ; ');
      chart.setAttribute('aria-label', `Graphique de ${shown}${plot.parameters.length ? ', ' + valuesText() : ''}${parametric.length ? ', ' + tText() : ''}`
        + `, x de ${label(x0)} à ${label(x1)}`);
    }
    // Surfaces from above, on the grammar's grid. A height outside the z window is left empty, never pressed flat.
    function drawSurfaces([z0, z1], px, py) {
      const n = math.LIMITS.grid, [gx0, gx1] = plot.x, [gy0, gy1] = plot.y;
      const gx = i => px(gx0 + (gx1 - gx0) * i / n), gy = j => py(gy0 + (gy1 - gy0) * j / n);
      const grids = trees.map(tree => math.sampleSurface(tree, plot, values, n).rows.map(row => row.map(z => (z !== null && z >= z0 && z <= z1 ? z : null))));
      domain.setAttribute('x', gx(0)); domain.setAttribute('y', gy(n));
      domain.setAttribute('width', gx(n) - gx(0)); domain.setAttribute('height', gy(0) - gy(n));
      if (sheets.length === 1) {
        const rows = grids[0];
        for (let j = 0; j < n; j += 1) {
          for (let i = 0; i < n; i += 1) {
            const corners = [rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]];
            if (corners.includes(null)) continue;
            const k = (corners.reduce((sum, z) => sum + z, 0) / 4 - z0) / (z1 - z0);
            // A hair of overlap so neighbouring cells show no seam.
            field.append(svg('rect', { x: gx(i).toFixed(2), y: gy(j + 1).toFixed(2), width: (gx(i + 1) - gx(i) + 0.5).toFixed(2),
              height: (gy(j) - gy(j + 1) + 0.5).toFixed(2), fill: mix(LOW_COLOR, sheetColors[0], k) }));
          }
        }
      }
      for (const level of ticks(z0, z1)) {
        grids.forEach((rows, index) => {
          const d = contour(rows, level).map(([a, b, c, e]) => `M${gx(a).toFixed(1)} ${gy(b).toFixed(1)}L${gx(c).toFixed(1)} ${gy(e).toFixed(1)}`).join('');
          if (!d) return;
          // One surface: light lines over its shading; two: each in its colour.
          levels.append(svg('path', { class: 'math-plot-level' + (level === 0 ? ' math-plot-level-zero' : ''), d, fill: 'none',
            stroke: sheets.length === 1 ? TANGENT_COLOR : sheetColors[index] }));
        });
      }
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
            : state === 'outdated' ? 'Tracé 2D calculé à partir des formules (la scène 3D chargée ne dessine pas encore ce tracé).'
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
      stageElement(schema).then(Stage => {
        if (!holder.isConnected && holder.dataset.stage === 'disposed') return;
        if (!Stage) {
          // An older GraphysX draws plain functions but not derivatives, tangents, areas, curves or surfaces: keep 2D, say why.
          const older = schema !== STAGE_SCHEMA && (root.customElements?.get('llmx-stage')?.schemas || []).includes(STAGE_SCHEMA);
          holder.dataset.stage = older ? 'outdated' : 'unavailable'; show('2d'); return;
        }
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
        element.scene = sceneOf();
        view.append(element);
      });
    }
    // The scene GraphysX draws: formulas, names and windows only; it computes every point itself.
    // Declared colours keep the legend and the picture in agreement; a window only when the block fixed it.
    function sceneOf() {
      const parameters = plot.parameters.map(row => ({ ...row, value: values[row.name] }));
      if (surfaced) {
        return { schema, kind: 'surfaces', parameters, x: plot.x.slice(), y: plot.y.slice(), ...(plot.z ? { z: plot.z.slice() } : {}),
          surfaces: sheets.map((row, index) => ({ name: row.name, label: row.label, expression: row.expression, color: sheetColors[index] })) };
      }
      // Curves alone: x is null, so GraphysX frames them around themselves as this card does.
      return { schema, kind: 'functions', x: plot.x ? plot.x.slice() : null, ...(plot.y ? { y: plot.y.slice() } : {}),
        functions: functions.map((fn, index) => ({ name: fn.name, label: fn.label, expression: fn.expression, color: colors[index] })),
        parameters,
        // Names and points only: GraphysX derives, finds slopes and integrates from the formulas itself.
        ...(schema !== STAGE_SCHEMA ? { derivatives: derivatives.slice(), tangents: tangents.map(row => ({ ...row })),
          areas: areas.map(row => ({ ...row })) } : {}),
        ...(parametric.length ? { curves: parametric.map((row, index) => ({ name: row.name, label: row.label, x: row.x, y: row.y, color: curveColor(index) })),
          t: plot.t.slice() } : {}) };
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
      input.step = String(sliderStep(row.max - row.min)); input.value = String(values[row.name]);
      input.setAttribute('aria-label', 'Paramètre ' + row.name);
      const output = el('output', 'math-plot-output', math.formatNumber(values[row.name]));
      input.addEventListener('input', () => {
        // Keep values on the slider grid but readable: 1.25, not 1.2500000001.
        values[row.name] = Number(math.formatNumber(Number(input.value)));
        output.textContent = math.formatNumber(values[row.name]);
        legend();
        if (stage) stage.parameters = { [row.name]: values[row.name] };
        if (holder.dataset.view !== '3d') draw();
        holder.dispatchEvent(new CustomEvent('math-plot-change', { bubbles: true, detail: { name: row.name, value: values[row.name] } }));
      });
      // Released: the page may keep these positions with the conversation.
      input.addEventListener('change', () => holder.dispatchEvent(new CustomEvent('math-plot-commit', { bubbles: true, detail: { values: { ...values } } })));
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

  root.NestorMathPlot = Object.freeze({ create, contour, COLORS, STAGE_SCHEMA, CALCULUS_SCHEMA, SHAPES_SCHEMA });
}(typeof window !== 'undefined' ? window : globalThis));
