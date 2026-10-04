'use strict';

let sessionPoint = null;
function wireSessionExperience() {
  sessionPoint = ConversationRecap.mount({ host: $('sessionPoint'), api, base: '/api/psyx/sessions',
    currentId: () => state.conversationId,
    prepare: () => { if (state.busy) return false; stopVoiceSession(); },
    onSaved: () => loadSessions(), onResume: id => { clearSessionExperience(); return restoreConversation(id); }
  });
  $('startTalking').onclick = () => { $('modeControl').querySelector('[data-mode="talk"]').click(); input.focus(); };
  $('startExercise').onclick = () => { $('tabExperiments').click(); openDrawer('insights'); $('techniqueList').scrollIntoView({ block: 'nearest' }); };
  $('resumeLatest').onclick = () => { const latest = state.sessions.find(item => item.lifecycle?.status !== 'archived'); if (latest) void restoreConversation(latest.id); };
}
function renderSessionExperience() {
  $('sessionWelcome').hidden = Boolean(state.conversationId);
  $('resumeLatest').hidden = !state.sessions.some(item => item.lifecycle?.status !== 'archived');
  if (state.unlocked) void sessionPoint?.refresh();
}
function clearSessionExperience() { sessionPoint?.clear(); }
