'use strict';

// A selectable projection of PromptConfig, not another persona store.
const crypto = require('node:crypto');
const PromptConfig = require('../../models/PromptConfig');
const { classifyPersona } = require('./personaDisposition');

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const project = (row) => ({ ...row, _id: String(row._id), disposition: classifyPersona(row) });

async function list() {
  const rows = await PromptConfig.find({ isActive: true }).sort({ name: 1, version: -1 }).lean();
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.name) || !classifyPersona(row).selectable) return false;
    seen.add(row.name);
    return true;
  }).map(project);
}

async function resolve(name, version) {
  if (typeof name !== 'string' || !name.trim()) throw error('A persona name is required');
  const query = { name: name.trim() };
  if (version != null) {
    if (!Number.isInteger(Number(version)) || Number(version) < 1) throw error('Invalid persona version');
    query.version = Number(version);
  } else query.isActive = true;
  const row = await PromptConfig.findOne(query).sort({ version: -1 }).lean();
  if (!row || !classifyPersona(row).selectable) throw error('Persona is unavailable', 404);
  return project(row);
}

// Private extensions publish generated definitions into the same versioned
// catalog. Source-owned rows are regenerated, never separately hand-authored.
async function publish(sourceId, definitions) {
  if (typeof sourceId !== 'string' || !sourceId.trim() || !Array.isArray(definitions)) throw error('Invalid persona source');
  const published = [];
  for (const definition of definitions) {
    const { name, systemPrompt, description = '', uiConfig = {} } = definition;
    if (!/^[a-z][a-z0-9_-]{0,119}$/.test(name) || typeof systemPrompt !== 'string' || !systemPrompt.trim()) throw error('Invalid persona definition');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ name, systemPrompt, description, uiConfig })).digest('hex');
    // Unique (name,version) index arbitrates concurrent extension starts.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await PromptConfig.findOne({ name }).sort({ version: -1 }).lean();
      if (latest && latest.uiConfig?.layoutConfig?.source?.id !== sourceId) throw error(`Persona ${name} has another author`, 409);
      let row = latest;
      // A persona the instance edited is the instance's: the source no longer regenerates it.
      if (!row || (!row.uiConfig.layoutConfig.source.edited && row.uiConfig.layoutConfig.source.hash !== hash)) {
        try {
          row = await PromptConfig.create({ name, systemPrompt, description,
            version: (latest?.version || 0) + 1, isActive: false,
            uiConfig: { ...uiConfig, layoutConfig: { ...uiConfig.layoutConfig, source: { id: sourceId, hash } } }
          });
        } catch (err) {
          if (err.code === 11000 && attempt < 2) continue;
          throw err;
        }
      }
      if (!row.isActive) await PromptConfig.activate(row._id);
      published.push({ name, version: row.version });
      break;
    }
  }
  return published;
}

const VOICE_PROVIDERS = ['kokoro', 'windows_sapi', 'voxcpm'];
const text = (value, max, label, multiline = false) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (!multiline && /[\r\n]/.test(value))) throw error(`Invalid ${label}`);
  return value.trim();
};

// The presentation fields an instance may change on a generated persona.
function editedLayout(layout, changes) {
  const next = { ...layout };
  if (changes.label !== undefined) next.label = text(changes.label, 80, 'label');
  if (changes.voice !== undefined) {
    const { provider, presentation, voices = {} } = changes.voice || {};
    if (!VOICE_PROVIDERS.includes(provider)) throw error('Invalid voice provider');
    if (presentation !== undefined && !['masculine', 'feminine'].includes(presentation)) throw error('Invalid voice presentation');
    const named = Object.fromEntries(['fr', 'en'].filter((language) => voices[language] !== undefined)
      .map((language) => [language, text(voices[language], 120, `${language} voice`)]));
    if (!Object.keys(named).length) throw error('A voice is required');
    // source "team" marks a voice chosen on the Team page; it outranks an instance-wide override.
    next.voice = { provider, presentation: presentation || layout.voice?.presentation, voices: named, source: 'team' };
  }
  if (changes.visual !== undefined) {
    if (changes.visual === null) next.visual = null;
    else {
      const { style, color } = changes.visual;
      if (!['initials', 'orb'].includes(style) || !/^#[a-f0-9]{6}$/i.test(color || '')) throw error('Invalid visual');
      next.visual = { ...(layout.visual || {}), style, color: color.toLowerCase() };
    }
  }
  return next;
}

async function generated(name) {
  const latest = await PromptConfig.findOne({ name: String(name || '').trim() }).sort({ version: -1 }).lean();
  if (!latest) throw error('Persona is unavailable', 404);
  if (!latest.uiConfig?.layoutConfig?.source?.id) throw error('This prompt is edited in the prompt library', 409);
  return latest;
}

async function nextVersion(latest, fields) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const top = attempt ? await PromptConfig.findOne({ name: latest.name }).sort({ version: -1 }).lean() : latest;
    try {
      const row = await PromptConfig.create({ name: latest.name, isActive: false, version: top.version + 1, ...fields });
      await PromptConfig.activate(row._id);
      return project({ ...row.toObject(), isActive: true });
    } catch (err) {
      if (err.code !== 11000 || attempt === 2) throw err;
    }
  }
  throw error('Persona version conflict', 409);
}

// An instance edit of a generated persona: a new active version the source
// stops regenerating. Earlier versions stay resolvable by number.
async function edit(name, changes = {}) {
  const latest = await generated(name);
  const layout = latest.uiConfig.layoutConfig;
  return nextVersion(latest, {
    systemPrompt: changes.personality !== undefined ? text(changes.personality, 12000, 'personality', true) : latest.systemPrompt,
    description: changes.description !== undefined ? text(changes.description, 300, 'description') : latest.description,
    uiConfig: { ...latest.uiConfig, layoutConfig: { ...editedLayout(layout, changes),
      source: { ...layout.source, edited: true, editedAt: new Date().toISOString() } } }
  });
}

// Back to what the source last published; the source regenerates it again from then on.
async function reset(name) {
  const latest = await generated(name);
  if (!latest.uiConfig.layoutConfig.source.edited) return project(latest);
  const seed = await PromptConfig.findOne({ name: latest.name, 'uiConfig.layoutConfig.source.edited': { $ne: true } }).sort({ version: -1 }).lean();
  if (!seed) throw error('No published default to return to', 409);
  return nextVersion(latest, { systemPrompt: seed.systemPrompt, description: seed.description, uiConfig: seed.uiConfig });
}

// A persona authored on this instance, from the Team page: the identity of an
// agent that had none (agentId), or one more style for a member (styleOf).
const TEAM_SOURCE = 'agentx-team';
const memberId = (value, label) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw error(`Invalid ${label}`);
  return value;
};

async function create(definition = {}) {
  const name = String(definition.name || '').trim();
  if (!/^[a-z][a-z0-9_-]{0,119}$/.test(name)) throw error('Invalid persona identifier');
  if ((definition.agentId === undefined) === (definition.styleOf === undefined)) throw error('A persona names its agent or the member it is a style of');
  const owner = definition.agentId !== undefined ? { agentId: memberId(definition.agentId, 'agent') } : { styleOf: memberId(definition.styleOf, 'member') };
  if (await PromptConfig.exists({ name })) throw error(`Persona ${name} already exists`, 409);
  if (owner.agentId && (await list()).some((row) => row.uiConfig?.layoutConfig?.agentId === owner.agentId)) {
    throw error(`Agent ${owner.agentId} already has an identity`, 409);
  }
  const layout = editedLayout({ kind: 'personality', ...owner }, { label: definition.label ?? '',
    ...(definition.voice !== undefined ? { voice: definition.voice } : {}), ...(definition.visual ? { visual: definition.visual } : {}) });
  const row = await PromptConfig.create({ name, version: 1, isActive: false,
    systemPrompt: text(definition.personality, 12000, 'personality', true),
    description: definition.description !== undefined ? text(definition.description, 300, 'description') : `${layout.label} persona`,
    uiConfig: { type: 'chat', route: '/index.html', capabilities: ['text'],
      layoutConfig: { ...layout, source: { id: TEAM_SOURCE, edited: true, editedAt: new Date().toISOString() } } } });
  await PromptConfig.activate(row._id);
  return project({ ...row.toObject(), isActive: true });
}

// Only a persona created on this instance can be removed; its versions stay in the library, inactive.
async function retire(name) {
  const latest = await generated(name);
  if (latest.uiConfig.layoutConfig.source.id !== TEAM_SOURCE) throw error('Only a persona created on this instance can be removed', 409);
  await PromptConfig.updateMany({ name: latest.name }, { $set: { isActive: false } });
  return { name: latest.name, removed: true };
}

module.exports = { list, resolve, publish, edit, reset, create, retire, TEAM_SOURCE };
