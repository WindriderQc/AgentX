(function () {
  'use strict';
  const form = document.getElementById('controls'), stage = document.getElementById('stage');
  let mounted = null, revision = 0;
  const reasons = { face: 'Masqué par le visage', clock: 'Masqué par l’horloge', bar: 'Masqué par la conversation',
    outside_panorama: 'Hors du panorama', below_horizon: 'Sous l’horizon réel' };
  const names = { sun: 'Soleil', moon: 'Lune', venus: 'Vénus', mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturne' };
  function seeded(seed) {
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  }
  function updateZones() {
    for (const zone of NestorSkyLayout.zones({ width: stage.clientWidth, height: stage.clientHeight })) {
      const element = stage.querySelector('.' + zone.id + '-zone');
      Object.assign(element.style, { left: zone.x * 100 + '%', top: zone.y * 100 + '%',
        width: zone.w * 100 + '%', height: zone.h * 100 + '%' });
    }
  }
  async function render(event) {
    event?.preventDefault();
    if (!form.reportValidity()) return;
    const own = ++revision, data = new FormData(form), status = document.getElementById('status');
    status.textContent = 'Calcul du ciel…';
    const at = new Date(data.get('at') + 'Z').toISOString();
    const params = new URLSearchParams({ at, lat: data.get('lat'), lon: data.get('lon') });
    try {
      const response = await fetch('/api/artx/lab/sky?' + params, { cache: 'no-store', credentials: 'same-origin' });
      const result = await response.json();
      if (own !== revision) return;
      if (!response.ok || !result.ok) throw new Error('Date ou coordonnées non valides.');
      mounted?.dispose();
      stage.style.aspectRatio = data.get('aspect');
      stage.classList.toggle('hide-zones', !data.has('zones'));
      const snapshot = result.data, clock = Date.parse(snapshot.at), age = Number(data.get('age'));
      if (data.get('weather') !== 'unknown') snapshot.weather = { kind: data.get('weather'), windKmh: 15,
        condition: form.elements.weather.selectedOptions[0].textContent,
        observedAt: new Date(clock - age * 60000).toISOString(), fetchedAt: snapshot.at };
      const samples = [];
      const preview = { snapshot, pixelRatio: Number(data.get('pixelRatio')), center: Number(data.get('center')), mode: data.get('mode') };
      mounted = NestorAmbient.mount({ documentRef: document, fetchImpl: null, preview,
        now: () => clock, random: seeded(17), animate: data.has('motion'), onFrame: ms => {
          samples.push(ms); if (samples.length > 300) samples.shift();
          const sorted = [...samples].sort((a, b) => a - b), quantile = q => sorted[Math.floor((sorted.length - 1) * q)].toFixed(2);
          document.getElementById('render-time').textContent = `Fond seul · dessin p50 ${quantile(0.5)} ms / p95 ${quantile(0.95)} ms · ${samples.length} échantillon(s)`;
        } });
      // The production renderer draws on requestAnimationFrame; wait for that frame.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (own !== revision) return;
      const plan = mounted.skyPlan(), bg = mounted.scene().background;
      document.getElementById('source-time').textContent = snapshot.at.replace('T', ' ').replace('.000Z', ' UTC');
      document.getElementById('weather-age').textContent = bg.weatherFreshness.state === 'expired'
        ? 'Météo expirée · effets retirés' : bg.weatherFreshness.state === 'stale' ? `Relevé simulé de ${age} minutes` : 'Conditions simulées';
      document.getElementById('objects').replaceChildren(...(plan?.objects || []).map(object => {
        const row = document.createElement('tr'), point = object.id === 'sun' ? snapshot.sky.sun : object.id === 'moon' ? snapshot.sky.moon
          : snapshot.sky.planets.find(p => p.id === object.id);
        for (const text of [names[object.id] || object.id, `${point.azDeg}° / hauteur ${point.altDeg}°`,
          object.rendered ? 'Dessiné' : reasons[object.hiddenBy] || 'Non dessiné']) {
          const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
        }
        return row;
      }));
      document.getElementById('manifest').textContent = JSON.stringify({ simulation: true, at: snapshot.at, weather: bg.weatherFreshness, plan }, null, 2);
      status.textContent = 'Scène calculée. Aucun appel modèle ni changement d’écran.';
      window.artxLab = { plan, snapshot, background: bg };
    } catch (error) { if (own === revision) status.textContent = 'Aperçu indisponible : ' + error.message; }
  }
  form.addEventListener('submit', render);
  const resize = new ResizeObserver(updateZones);
  resize.observe(stage);
  window.addEventListener('pagehide', () => { revision++; resize.disconnect(); mounted?.dispose(); });
  render();
})();
