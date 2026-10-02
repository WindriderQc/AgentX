'use strict';
// Shared by the unlock and face setup pages: open the front camera, grab a
// JPEG frame (unmirrored, as the server expects) and call the face routes.
window.AgentXCamera = (() => {
  const hints = {
    no_face: 'Aucun visage détecté. Place-toi face à la caméra.',
    many_faces: 'Une seule personne devant la caméra.',
    closer: 'Approche-toi un peu.',
    look_straight: 'Regarde droit vers la caméra.',
    not_recognized: 'Visage non reconnu, on réessaie…',
    turn_more: 'Tourne encore un peu la tête.',
    different_person: 'Ce visage ne correspond pas aux images déjà enregistrées.'
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function open(video) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('La caméra demande une page HTTPS et un navigateur compatible.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    return stream;
  }

  function close(video) {
    for (const track of video.srcObject?.getTracks?.() || []) track.stop();
    video.srcObject = null;
    video.hidden = true;
  }

  function frame(video) {
    const scale = Math.min(1, 640 / (video.videoWidth || 640));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((video.videoWidth || 640) * scale);
    canvas.height = Math.round((video.videoHeight || 480) * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function call(url, method = 'GET', body) {
    const response = await fetch(url, { method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.message || 'Erreur de la reconnaissance faciale.'), { status: response.status });
    return result.data;
  }

  return { open, close, frame, call, wait, hint: key => hints[key] || '' };
})();
