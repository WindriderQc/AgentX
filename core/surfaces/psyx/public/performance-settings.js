'use strict';
let performancePreferences = null;
function applyPerformancePreferences(values = {}) {
  state.conversationFeatures = values;
  $('depthControl').querySelector('[data-depth="deep"]').disabled = values.deepReasoning === false;
  if (values.deepReasoning === false && state.depth === 'deep') state.depth = 'normal';
  review.enabled = values.backgroundReview !== false;
  if (!review.enabled) { stopReviewWatch(); $('reviewStatus').hidden = true; }
  if (values.dreamEnabled === false) { dream.status = { enabled: false, status: 'disabled' }; renderPortrait(); }
  syncSegmentedControls();
  updateControlExplanation();
}
function wirePerformancePreferences() {
  performancePreferences = ConversationPreferences.mount({ button: $('performancePsyx'), api, endpoint: '/api/psyx/preferences',
    onSaved: data => { applyPerformancePreferences(data.values); watchDream(); },
    integrations: [{ title: 'Modèles, routage et localisation', href: '#', action: () => { $('tabSetup').click(); openDrawer('insights'); $('routingDetails').scrollIntoView({ block: 'nearest' }); } }]
  });
}
