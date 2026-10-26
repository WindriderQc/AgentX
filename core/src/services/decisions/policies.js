'use strict';

// These are advisory categories, not runtime agent IDs or execution grants.
const POLICIES = {
  'notification-triage': {
    version: 1,
    question: 'How should this update be presented to its recipient?',
    choices: {
      interrupt: 'A timely interruption is justified by an explicit urgent issue or required action.',
      digest: 'Useful information that can wait for the next digest.',
      ignore: 'Clearly redundant or irrelevant information without an action or material change.',
      review: 'Context is missing, contradictory, or insufficient to classify safely.'
    }
  },
  'specialist-routing': {
    version: 1,
    question: 'Which capability best matches the primary request?',
    choices: {
      general: 'General assistance or an ordinary conversation.',
      secretary: 'Email, calendar, appointments, reminders, or personal organization.',
      accountant: 'Financial records, transaction categorization, or accounting questions.',
      operations: 'Infrastructure health, hosts, services, or operational investigation.',
      images: 'Image creation, image editing, or image-workshop assistance.',
      coding: 'Software implementation, debugging, testing, or code review.',
      review: 'Several independent requests or insufficient context to select one capability.'
    }
  }
};

for (const policy of Object.values(POLICIES)) {
  Object.freeze(policy.choices);
  Object.freeze(policy);
}
Object.freeze(POLICIES);

function catalog() {
  return {
    contract: 'local-decisions-v1', mode: 'advisory', localOnly: true,
    confidence: null, calibration: 'not-evaluated',
    policies: Object.entries(POLICIES).map(([id, policy]) => ({ id, ...policy }))
  };
}

module.exports = { POLICIES, catalog };
