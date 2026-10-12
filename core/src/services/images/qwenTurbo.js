'use strict';
// Checkpoint-owned eight-step schedule, followed by terminal zero.
// https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/d65dbc9a7e8f6b5479e33dee6030eaab2a906509/model_index.json
const SAMPLING = 'qwen21-turbo';
const SIGMAS = Object.freeze([1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0]);
function validateSampling(profile) {
  if (profile.sampling === undefined) return;
  if (profile.sampling !== SAMPLING || profile.family !== 'qwen21' || profile.steps !== 8) {
    throw new Error('Qwen Turbo sampling requires the qwen21 family and exactly eight steps');
  }
}
module.exports = { SAMPLING, SIGMAS, validateSampling };
