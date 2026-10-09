'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const readAccepted = (id, actionKey) => require('../../src/services/images/imageService').getForAction(id, actionKey);
const pending = new Set(['accepted', 'reserving', 'generating', 'archiving', 'restoring']);

// A conversation model cannot undo a Core action by denying access to tools.
// Deliver the accepted image's current Core receipt directly, with the existing
// spoken/display channels, and keep native attempt evidence separately.
async function acceptedImageReply({ session, evidence, sessionKey, runId, language = 'fr', readOperation = readAccepted }) {
  if (session.packId !== 'personal_operator' || session.scopeId !== 'personal'
    || session.llmx || session.source === 'graphysx-llmx' || (session.agentId || 'main') !== 'main') return null;
  const operations = [], seen = new Set();
  for (const receipt of (evidence?.receipts || []).slice(-40)) {
    const reference = receipt.imageOperation;
    if (receipt.tool !== 'local_image' || receipt.observed !== true || receipt.status === 'failed'
      || receipt.runId !== runId || receipt.sessionKey !== sessionKey
      || receipt.provenance?.origin !== 'owner_turn' || !UUID.test(reference?.id || '')
      || !/^[a-f0-9]{64}$/.test(reference?.actionKey || '') || seen.has(reference.id)) continue;
    let operation;
    try { operation = await readOperation(reference.id, reference.actionKey); }
    catch { continue; } // An unavailable observation never authorizes another create.
    if (operation?.id !== reference.id || operation.studioPath !== `/images?operation=${reference.id}`) continue;
    seen.add(reference.id);
    operations.push(operation);
  }
  if (!operations.length) return null;
  const english = language === 'en';
  const text = operations.map(operation => {
    const ready = operation.state === 'completed' && operation.runtimeRestored === true
      && /^[a-f0-9]{64}$/.test(operation.artifact?.sha256 || '');
    const status = ready ? english ? 'Your image is ready.' : 'Ton image est prête.' : pending.has(operation.state)
      ? english ? 'Your image request is accepted. You can follow its progress in the studio.' : 'Ta demande image est acceptée. Tu peux suivre sa préparation dans le studio.'
      : operation.state === 'cancelled' ? english ? 'The image request was cancelled.' : 'La demande image a été annulée.'
        : operation.state === 'failed' ? english ? 'Image generation failed.' : 'La préparation de l’image a échoué.'
          : english ? 'Check the image request’s status in the studio.' : 'L’état de la demande image doit être vérifié dans le studio.';
    // The route comes from the exact Core operation, not a native model URL.
    return `${status}\n<show kind="link" title="${english ? 'Image studio' : 'Studio d’images'}">${operation.studioPath}</show>`;
  }).join('\n\n');
  return { text, authority: 'agentx.core.images', operations };
}

module.exports = { acceptedImageReply };
