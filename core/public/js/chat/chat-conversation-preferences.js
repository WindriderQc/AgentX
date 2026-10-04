'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('conversationPerformance');
  if (!button) return;
  const api = async (path, options = {}) => {
    const response = await fetch(path, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json' } });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || 'Les réglages sont indisponibles.');
    return payload.data;
  };
  const editor = ConversationPreferences.mount({ button, api, endpoint: '/api/conversation-preferences',
    integrations: [{ title: 'RAG, recherche web, réflexion et paramètres du modèle', href: '#', action: () => document.getElementById('toggleConfigBtn').click() },
      { title: 'Routage et performance des hôtes', href: '/nerve-center' }]
  });
  window.addEventListener('pagehide', () => editor.clear());
});
