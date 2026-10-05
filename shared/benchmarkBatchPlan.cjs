'use strict';

/**
 * The closed request an operator agent may prepare and start as a Benchmark
 * batch (#394), and the identity of a prepared plan.
 *
 * `./agentx action` and the OpenClaw maintenance plugin both validate through
 * this module, so the approval an owner reads and the request the action
 * launches are the same normalized values. A plan reference carries a digest
 * of those values: a start that restates other values cannot name the plan.
 */

const crypto = require('node:crypto');
const { BENCHMARK_CATEGORY_KEYS } = require('./benchmarkCategories');

const REQUEST_FIELDS = Object.freeze(['host', 'model', 'categories', 'levels', 'repeats', 'judgeHost', 'judgeModel', 'name', 'tag']);
const HOST = /^https?:\/\/[A-Za-z0-9.-]{1,60}(:\d{1,5})?$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
// Ollama serves cloud-offloaded models under a "cloud" tag; they are not local.
const CLOUD_MODEL = /(^|[-:])cloud$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:+()#-]{0,59}$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const PLAN_REF = /^bp-([0-9a-f]{16})-([0-9a-f]{16})$/;
const BATCH_ID = /^[0-9a-f]{24}$/;
// The tag a launched batch carries, so Benchmark itself says which batch a plan produced.
const PLAN_TAG_PREFIX = 'agentx-plan-';

function integerList(value, label, min, max) {
  const list = Array.isArray(value) ? [...new Set(value)] : [];
  if (!list.length || list.some(item => !Number.isInteger(item) || item < min || item > max)) {
    throw new Error(`${label} needs integers from ${min} to ${max}`);
  }
  return list.sort((a, b) => a - b);
}

function localModel(value, label) {
  if (typeof value !== 'string' || !MODEL.test(value)) throw new Error(`${label} is not a valid model name`);
  if (CLOUD_MODEL.test(value)) throw new Error(`${label} names a cloud model; only local models are allowed`);
  return value;
}

function ollamaHost(value, label) {
  if (typeof value !== 'string' || !HOST.test(value)) throw new Error(`${label} must be an Ollama host URL without a path`);
  return value;
}

/**
 * The normalized request, or an Error naming the first problem. `also` lists
 * the caller's own fields (the action name, the plan); any other field is
 * refused. A start restates the judge the plan pinned: `judgeRequired`.
 */
function batchRequest(params, { also = [], judgeRequired = false } = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('The batch request must be an object');
  const unknown = Object.keys(params).filter(key => !REQUEST_FIELDS.includes(key) && !also.includes(key));
  if (unknown.length) throw new Error(`Unknown field: ${unknown.join(', ')}`);
  const given = key => params[key] !== undefined && params[key] !== null;

  const categories = Array.isArray(params.categories) ? [...new Set(params.categories)] : [];
  if (!categories.length || categories.some(category => !BENCHMARK_CATEGORY_KEYS.includes(category))) {
    throw new Error(`categories needs one or more of ${BENCHMARK_CATEGORY_KEYS.join(', ')}`);
  }
  if (given('judgeHost') !== given('judgeModel')) throw new Error('judgeHost and judgeModel go together');
  if (judgeRequired && !given('judgeHost')) throw new Error('The start restates the judge of the prepared plan');
  if (given('name') && (typeof params.name !== 'string' || !NAME.test(params.name))) {
    throw new Error('name needs 1 to 60 letters, digits, spaces or . _ : + ( ) # -');
  }
  if (given('tag') && (typeof params.tag !== 'string' || !TAG.test(params.tag) || params.tag.startsWith(PLAN_TAG_PREFIX))) {
    throw new Error('tag needs 1 to 40 lowercase letters, digits or . _ -');
  }
  return Object.freeze({
    host: ollamaHost(params.host, 'host'),
    model: localModel(params.model, 'model'),
    categories: Object.freeze(BENCHMARK_CATEGORY_KEYS.filter(category => categories.includes(category))),
    levels: Object.freeze(integerList(given('levels') ? params.levels : [1, 2, 3, 4, 5], 'levels', 1, 5)),
    repeats: integerList([given('repeats') ? params.repeats : 1], 'repeats', 1, 5)[0],
    judgeHost: given('judgeHost') ? ollamaHost(params.judgeHost, 'judgeHost') : null,
    judgeModel: given('judgeModel') ? localModel(params.judgeModel, 'judgeModel') : null,
    name: given('name') ? params.name : null,
    tag: given('tag') ? params.tag : null,
  });
}

function planRef(id, request) {
  const digest = crypto.createHash('sha256').update(JSON.stringify([id, ...REQUEST_FIELDS.map(field => request[field])])).digest('hex');
  return `bp-${id}-${digest.slice(0, 16)}`;
}

const newPlanRef = request => planRef(crypto.randomBytes(8).toString('hex'), request);

/** The plan id inside a reference, or an Error when it is not one. */
function planId(ref) {
  const match = PLAN_REF.exec(typeof ref === 'string' ? ref : '');
  if (!match) throw new Error('plan must be the reference a prepared plan returned');
  return match[1];
}

const planTag = id => `${PLAN_TAG_PREFIX}${id}`;

function batchId(value) {
  if (typeof value !== 'string' || !BATCH_ID.test(value)) throw new Error('id must be a Benchmark batch id');
  return value;
}

/** One line naming every value of a request, for an approval prompt or a lease note. */
function describeRequest(request) {
  return [
    `${request.model} on ${request.host}`,
    `${request.categories.join(',')} L${request.levels.join('')} x${request.repeats}`,
    `judge ${request.judgeModel ? `${request.judgeModel} on ${request.judgeHost}` : 'default'}`,
    ...(request.name ? [`name ${request.name}`] : []),
    ...(request.tag ? [`tag ${request.tag}`] : []),
  ].join('; ');
}

module.exports = { REQUEST_FIELDS, batchRequest, planRef, newPlanRef, planId, planTag, batchId, describeRequest };
