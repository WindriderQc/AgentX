'use strict';
// Camera unlock on the unlock page. The parental code form stays available.
(async () => {
  const camera = window.AgentXCamera;
  const section = document.getElementById('faceUnlock');
  const setup = document.getElementById('faceSetup');
  const start = document.getElementById('faceStart');
  const video = document.getElementById('faceVideo');
  const statusNode = document.getElementById('faceStatus');
  const say = text => { statusNode.textContent = text; };
  const turnText = direction => `Tourne lentement la tête vers ta ${direction === 'left' ? 'gauche' : 'droite'}.`;

  let face;
  try { face = await camera.call('/api/access/face/status'); } catch { return; }
  if (!face.enabled) return;
  setup.hidden = false;
  if (!face.ready) return;
  section.hidden = false;

  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      await camera.open(video);
      const challenge = await camera.call('/api/access/face/challenge', 'POST', {});
      let direction = challenge.direction;
      let step = 'front';
      say('Regarde droit vers la caméra.');
      await camera.wait(800);
      while (Date.now() < challenge.expiresAt) {
        const result = await camera.call('/api/access/face/frame', 'POST', { challengeId: challenge.challengeId,
          image: camera.frame(video), next: new URLSearchParams(location.search).get('next') });
        if (result.unlocked) { say('Bonjour ! Ouverture…'); camera.close(video); location.replace(result.next); return; }
        if (result.direction) direction = result.direction;
        if (result.step !== step) { step = result.step; say(turnText(direction)); }
        else if (result.hint) say(camera.hint(result.hint) || (step === 'turn' ? turnText(direction) : ''));
        await camera.wait(400);
      }
      throw new Error('Délai dépassé. Recommence ou utilise le code parental.');
    } catch (error) {
      say(error.message || 'Reconnaissance impossible. Utilise le code parental.');
      camera.close(video);
      start.disabled = false;
    }
  });
})();
