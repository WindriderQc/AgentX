'use strict';

// These routes change inference only. Native agent identities, tools, context
// ownership and approvals continue to belong to the accepted conversation work.
const CLOUD_MODEL = /^[a-z][a-z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,180}$/;
const profileUnavailable = () => Object.assign(new Error('This Nestor inference profile is unavailable. Choose Local or configure its native cloud routes.'),
  { statusCode: 409, code: 'CONVERSATION_INFERENCE_PROFILE_UNAVAILABLE' });

function configuredRoutes(env = process.env) {
  const guardian = String(env.PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL || '').trim();
  const boss = String(env.PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL || '').trim();
  const agent = env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID;
  const native = env.PERSONAL_CONVERSATION_WORK_MODE === 'native'
    && /^[a-z][a-z0-9_-]{0,63}$/.test(env.PERSONAL_CONVERSATION_WORK_AGENT_ID || '')
    && !['main', 'family'].includes(env.PERSONAL_CONVERSATION_WORK_AGENT_ID)
    && String(env.PERSONAL_CONVERSATION_WORK_TOKEN || '').length >= 32
    && /^[a-z][a-z0-9_-]{0,63}$/.test(agent || '')
    && !['main', 'family', env.PERSONAL_CONVERSATION_WORK_AGENT_ID].includes(agent);
  return { guardian, boss, native };
}

function profileField(env = process.env) {
  const { guardian, boss, native } = configuredRoutes(env);
  return { key: 'inferenceProfile', type: 'enum', group: 'inference', groupTitle: 'Inference models',
    title: 'Nestor models',
    description: 'Choose the models for standard personal voice. The guardian keeps the conversation going; complete Main researches, checks and uses its tools. Cloud profiles send their supplied context to the configured provider. Accepted work keeps its chosen profile.',
    cost: 'Model latency and provider usage · context and tools keep their existing contracts',
    choices: [
      { value: 'local', label: 'Local' },
      { value: 'boss_cloud', label: 'Cloud brain', disabled: !native || !CLOUD_MODEL.test(boss) },
      { value: 'full_cloud', label: 'Cloud guardian and brain', disabled: !native || !CLOUD_MODEL.test(boss) || !CLOUD_MODEL.test(guardian) }
    ] };
}

function resolveProfile(profile = 'local', env = process.env) {
  const field = profileField(env);
  if (!field.choices.some(choice => choice.value === profile && !choice.disabled)) throw profileUnavailable();
  const { guardian, boss } = configuredRoutes(env);
  return { profile, guardian: profile === 'full_cloud' ? { model: guardian } : {},
    boss: profile === 'local' ? {} : { model: boss } };
}

module.exports = { profileField, resolveProfile, profileUnavailable };
