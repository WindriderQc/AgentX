'use strict';
// Read-only disclosures: no worker initialization, recovery or runtime claim.
const ImageOperation = require('../../../models/ImageOperation');
const { loadConfig } = require('./config');
const { MIN_EDGE, MULTIPLE, limits, recommended } = require('./sizes');
const { declaredRecipe, executionDetails } = require('./recipeExecution');
const constraints = require('../../../public/js/image-brief-constraints');
const text = value => typeof value === 'string' ? value.trim().slice(0,240) : null;
function workerInfo(workerUrl, config) {
  let address;
  try { address = new URL(workerUrl).hostname; } catch { return null; }
  const sameWorker = workerUrl === config?.workerUrl;
  const display = sameWorker ? config.presentation || {} : {};
  return { address, label: text(display.hostLabel) || address,
    gpu: text(display.gpuLabel), vramGiB: Number.isFinite(display.vramGiB) && display.vramGiB > 0 ? display.vramGiB : null,
    source: sameWorker ? 'current-worker-configuration' : 'recorded-worker-address' };
}
function recipeInfo(id, profile = {}) {
  const precision = profile.weightDtype || (/int8/i.test(profile.diffusion || '') ? 'INT8 (fichier déclaré)' : null);
  let declaration;
  try { declaration = declaredRecipe(profile.recipe); } catch { /* Legacy profile metadata is not a recipe declaration. */ }
  return { id, label: profile.label || id, family: profile.family || null,
    ...(declaration && { declaredIdentity: declaration }),
    diffusion: profile.diffusion || null, encoder: profile.encoder || null, vae: profile.vae || null,
    precision, steps: profile.steps ?? null, maxPixels: profile.maxPixels ?? null,
    maxEdge: limits(profile.family).maxEdge, sizes: recommended(profile),
    description: text(profile.presentation?.description),
    editingFraming: profile.family === 'qwen21' ? 'first-reference' : 'requested-format' };
}
function describe(config) {
  const profiles = Object.entries(config?.profiles || {}).map(([id, profile]) => recipeInfo(id, profile));
  return { worker: config ? workerInfo(config.workerUrl, config) : null, profiles,
    dimensions: { minEdge: MIN_EDGE, maxEdge: Math.max(limits().maxEdge, ...profiles.map(p => p.maxEdge)), multiple: MULTIPLE }, maxReferences: 2 };
}
function overview() { return describe(loadConfig()); }
async function details(id) {
  const op = await ImageOperation.findById(id).select('+request +workerUrl +execution').lean();
  if (!op) throw Object.assign(new Error('Opération image inconnue.'), { statusCode: 404 });
  return { id: op._id, recipe: recipeInfo(op.profile.id, op.profile),
    ...(op.expert && { expert: op.expert }),
    ...(op.lineage && { lineage: op.lineage }),
    ...(op.execution && { execution: executionDetails(op.execution) }),
    worker: workerInfo(op.workerUrl, loadConfig()),
    request: { prompt: op.request?.prompt, seed: op.request?.seed, width: op.request?.width, height: op.request?.height,
      ...(op.request?.constraints && { visualPrompt: op.request.visualPrompt, constraints: constraints.validate(op.request.constraints) }) },
    actualDimensions: op.artifact ? { width: op.artifact.width, height: op.artifact.height } : null,
    totalMs: op.timings?.totalMs ?? null, archivePath: text(op.artifact?.path),
    createdAt: op.createdAt, runtimeRestored: op.runtimeRestored === true };
}
module.exports = { overview, details, describe, recipeInfo, workerInfo };
