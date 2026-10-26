// Load only Core's reviewed Forge module. Failure keeps an ordinary way back.
import('/api/household/llmx/room.js').catch(() => {
  const root = document.querySelector('[data-llmx-root]');
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = 'La Forge est indisponible. Tu peux continuer avec Nestor.';
  const back = document.createElement('a');
  back.href = new URLSearchParams(window.location.search).get('profile') === 'family' ? '/panel' : '/dad';
  back.textContent = 'Retour à Nestor';
  root.replaceChildren(message, back);
});
