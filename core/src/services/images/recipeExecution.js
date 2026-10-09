'use strict';
const crypto = require('node:crypto');
const { workflow } = require('./workflows');
const BUILDER = Object.freeze({ id: 'agentx.local-images.workflows', version: 1 });
const token = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function declaredRecipe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'version') || !token(value.id) || !token(value.version)) {
    throw new Error('Invalid image recipe declaration');
  }
  return { id: value.id, version: value.version };
}

function requestedRecipe(body) {
  if (!Object.hasOwn(body, 'recipeId') && !Object.hasOwn(body, 'recipeVersion')) return undefined;
  if (!Object.hasOwn(body, 'recipeId') || !Object.hasOwn(body, 'recipeVersion')
      || !token(body.recipeId) || !token(body.recipeVersion)) throw fail('Une recette attendue exige un ID et une version valides.');
  return { id: body.recipeId, version: body.recipeVersion };
}

function assertRecipe(expected, profile) {
  if (expected && (profile.recipe?.id !== expected.id || profile.recipe?.version !== expected.version)) {
    throw fail('La recette attendue ne correspond plus à ce profil. Recharge les recettes disponibles.', 409);
  }
}

function buildExecution(profile, request, references, id) {
  const graph = workflow(profile, request, references, id);
  return { version: 1, builder: { ...BUILDER }, graph,
    graphSha256: crypto.createHash('sha256').update(JSON.stringify(graph)).digest('hex'),
    parameters: { width: request.width, height: request.height, seed: request.seed, steps: profile.steps } };
}

function executionDetails(execution) {
  if (!execution) return undefined;
  return { version: execution.version, builder: { id: execution.builder?.id, version: execution.builder?.version },
    graphSha256: execution.graphSha256, parameters: { width: execution.parameters?.width, height: execution.parameters?.height,
      seed: execution.parameters?.seed, steps: execution.parameters?.steps } };
}

module.exports = { declaredRecipe, requestedRecipe, assertRecipe, buildExecution, executionDetails };
