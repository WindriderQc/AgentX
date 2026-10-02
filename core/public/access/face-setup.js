'use strict';
// Enrollment of the adult's face descriptors. Requires an open adult session.
(async () => {
  const camera = window.AgentXCamera;
  const video = document.getElementById('faceVideo');
  const statusNode = document.getElementById('faceStatus');
  const count = document.getElementById('faceCount');
  const start = document.getElementById('faceStart');
  const capture = document.getElementById('faceCapture');
  const erase = document.getElementById('faceErase');
  const say = text => { statusNode.textContent = text; };
  const show = data => {
    count.textContent = `${data.samples} image${data.samples > 1 ? 's' : ''} enregistrée${data.samples > 1 ? 's' : ''}`
      + (data.ready ? ' · reconnaissance prête.' : ` · encore ${data.required - data.samples} pour activer la reconnaissance.`);
    erase.disabled = data.samples === 0;
  };

  try { show(await camera.call('/api/access/face/enrollment')); }
  catch (error) { say(error.status === 404 ? 'La reconnaissance faciale n’est pas activée sur cette instance.' : error.message); return; }

  start.addEventListener('click', async () => {
    try {
      await camera.open(video);
      start.hidden = true;
      capture.hidden = false;
      say('Regarde droit vers la caméra, bien éclairé, puis enregistre. Varie un peu la lumière ou la distance entre les images.');
    } catch (error) { say(error.message || 'Caméra indisponible.'); }
  });

  capture.addEventListener('click', async () => {
    capture.disabled = true;
    say('Analyse…');
    try {
      const result = await camera.call('/api/access/face/enrollment/samples', 'POST', { image: camera.frame(video) });
      show(result);
      say(result.added ? 'Image enregistrée.' : camera.hint(result.hint));
    } catch (error) { say(error.message); }
    capture.disabled = false;
  });

  erase.addEventListener('click', async () => {
    if (!window.confirm('Effacer toutes les données de reconnaissance faciale ?')) return;
    try { show(await camera.call('/api/access/face/enrollment', 'DELETE')); say('Données faciales effacées.'); }
    catch (error) { say(error.message); }
  });
})();
