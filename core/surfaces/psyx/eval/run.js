#!/usr/bin/env node
'use strict';

// PsyX scenario evaluation. Builds each reply exactly as the PsyX chat does
// (domain prompt, control, longitudinal state, safety check), asks Core's
// router for it, then scores it: deterministic checks plus a judge model
// grading each scenario's criteria. Results go to --out, never into Git.
//
//   node core/surfaces/psyx/eval/run.js [--only id,id] [--repeat 2] [--out file.json]
//     [--compare previous.json] [--judge-task deep_reasoning] [--judge-model name]
//     [--base https://agentx.example] [--code-file ~/.agentx/access/parental-code]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const domain = require('../../../src/domains/psyx/domain');
const { normalizeState } = require('../../../src/domains/psyx/stateRepository');
const { detectCrisis } = require('../../../src/domains/psyx/safety');

const GENERIC_CRITERIA = [
  { id: 'french', text: 'Answers in natural Québec-friendly French.' },
  { id: 'specific', text: 'Engages with the specifics the user gave; nothing generic that would fit any message.' },
  { id: 'no_boilerplate', text: 'No generic disclaimers, no "as an AI", no therapist clichés or filler.' }
];

const JUDGE_PROMPT = `You grade one reply of PsyX, a psychological thinking partner, against criteria. Be strict and concrete: 2 = clearly met, 1 = partly met, 0 = missed or contradicted. Judge the reply only, not what it could have said elsewhere. Return only JSON:
{"criteria":[{"id":"criterion id","score":0,"why":"one short sentence"}],"overall":1,"verdict":"one sentence"}
overall is 1-5: how helpful this reply would be to a thoughtful adult at this moment of the conversation.`;

function args(argv) {
  const options = { repeat: 1, judgeTask: 'deep_reasoning' };
  for (let index = 2; index < argv.length; index += 1) {
    const [key, value] = [argv[index], argv[index + 1]];
    if (key === '--only') options.only = value.split(',');
    else if (key === '--repeat') options.repeat = Math.max(1, Number(value) || 1);
    else if (key === '--out') options.out = value;
    else if (key === '--compare') options.compare = value;
    else if (key === '--judge-task') options.judgeTask = value;
    else if (key === '--judge-model') options.judgeModel = value;
    else if (key === '--base') options.base = value;
    else if (key === '--code-file') options.codeFile = value;
    else continue;
    index += 1;
  }
  options.base = (options.base || process.env.AGENTX_BASE_URL || 'https://agentx.specialblend.icu').replace(/\/$/, '');
  options.codeFile = options.codeFile || process.env.AGENTX_ACCESS_CODE_FILE || path.join(os.homedir(), '.agentx', 'access', 'parental-code');
  return options;
}

async function infer(options, body) {
  const code = fs.readFileSync(options.codeFile, 'utf8').trim();
  const started = Date.now();
  const response = await fetch(`${options.base}/api/inference/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'chat', stream: false, callerDetail: 'psyx/eval', ...body })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Inference ${response.status}: ${payload.message || payload.code || 'failed'}`);
  return { content: String(payload.message?.content || payload.response || '').trim(), model: payload.model || null, ms: Date.now() - started };
}

// The same system context, control and safety override as the chat handler.
function replyRequest(scenario) {
  const state = normalizeState(scenario.state || {}, 'eval');
  const safety = detectCrisis(scenario.message);
  const resolved = domain.resolveControl(domain.normalizeControl(scenario.control || {}), null);
  const control = safety ? { ...resolved, mode: 'talk', depth: 'normal', reason: '' } : resolved;
  const system = domain.composeSystemContext(state, control, { conversationId: scenario.newSession ? null : 'eval', safety });
  return {
    taskType: control.depth === 'deep' ? 'deep_reasoning' : 'analysis',
    think: control.depth === 'deep',
    options: { temperature: safety ? 0.4 : control.mode === 'challenge' ? 0.55 : 0.7 },
    messages: [{ role: 'system', content: system }, ...domain.boundedContext(scenario.history || []), { role: 'user', content: scenario.message }],
    safety: Boolean(safety)
  };
}

function judgeRequest(options, scenario, reply) {
  const criteria = [...scenario.criteria, ...GENERIC_CRITERIA];
  const transcript = [...(scenario.history || []), { role: 'user', content: scenario.message }]
    .map(turn => `${turn.role === 'assistant' ? 'PsyX' : 'User'}: ${turn.content}`).join('\n');
  return {
    ...(options.judgeModel ? { model: options.judgeModel } : { taskType: options.judgeTask }),
    think: false, format: 'json', options: { temperature: 0 },
    messages: [
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: `Skill under test: ${scenario.skill}\n\nConversation so far:\n${transcript}\n\nPsyX reply:\n${reply}\n\nCriteria:\n${criteria.map(item => `- ${item.id}: ${item.text}`).join('\n')}` }
    ]
  };
}

function readJudgement(raw, scenario) {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  const parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
  const ids = [...scenario.criteria, ...GENERIC_CRITERIA].map(item => item.id);
  const scores = Object.fromEntries(ids.map(id => {
    const found = (parsed.criteria || []).find(item => item.id === id);
    return [id, { score: Math.max(0, Math.min(2, Number(found?.score) || 0)), why: String(found?.why || 'not graded') }];
  }));
  return { scores, overall: Math.max(1, Math.min(5, Number(parsed.overall) || 1)), verdict: String(parsed.verdict || '') };
}

// Deterministic checks need no judge.
function measure(reply) {
  return {
    words: reply.split(/\s+/).filter(Boolean).length,
    questions: (reply.match(/\?/g) || []).length,
    markdown: /(^|\n)\s*(#{1,3} |[-*] |\d+\. )|\*\*/.test(reply)
  };
}

function scenarioScore(run) {
  const all = Object.values(run.judgement.scores).map(item => item.score);
  const specific = Object.entries(run.judgement.scores).filter(([id]) => !GENERIC_CRITERIA.some(item => item.id === id)).map(([, item]) => item.score);
  const percent = values => Math.round((values.reduce((sum, value) => sum + value, 0) / (2 * values.length)) * 100);
  return { criteria: percent(all), skill: percent(specific) };
}

function summarize(results) {
  const rows = results.map(result => {
    const runs = result.runs;
    const avg = pick => Math.round(runs.reduce((sum, run) => sum + pick(run), 0) / runs.length * 10) / 10;
    return {
      id: result.id,
      skill: avg(run => scenarioScore(run).skill),
      criteria: avg(run => scenarioScore(run).criteria),
      overall: avg(run => run.judgement.overall),
      words: avg(run => run.metrics.words),
      questions: avg(run => run.metrics.questions)
    };
  });
  const mean = key => Math.round(rows.reduce((sum, row) => sum + row[key], 0) / rows.length * 10) / 10;
  return { rows, totals: { skill: mean('skill'), criteria: mean('criteria'), overall: mean('overall'), words: mean('words'), questions: mean('questions') } };
}

function printSummary(summary, previous) {
  const before = previous ? Object.fromEntries(previous.summary.rows.map(row => [row.id, row])) : {};
  const delta = (now, then) => then === undefined ? '' : ` (${now - then >= 0 ? '+' : ''}${Math.round((now - then) * 10) / 10})`;
  console.log(['scenario'.padEnd(22), 'skill%', 'criteria%', 'overall', 'words', '?'].join('  '));
  for (const row of summary.rows) {
    const then = before[row.id] || {};
    console.log([row.id.padEnd(22), `${row.skill}${delta(row.skill, then.skill)}`, `${row.criteria}${delta(row.criteria, then.criteria)}`,
      `${row.overall}${delta(row.overall, then.overall)}`, `${row.words}`, `${row.questions}`].join('  '));
  }
  const totals = summary.totals, old = previous?.summary.totals || {};
  console.log(`\nMEAN  skill ${totals.skill}%${delta(totals.skill, old.skill)}  criteria ${totals.criteria}%${delta(totals.criteria, old.criteria)}  overall ${totals.overall}${delta(totals.overall, old.overall)}  words ${totals.words}  questions ${totals.questions}`);
}

async function main() {
  const options = args(process.argv);
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'));
  const scenarios = file.scenarios.filter(item => !options.only || options.only.includes(item.id));
  const results = [];
  for (const scenario of scenarios) {
    const result = { id: scenario.id, runs: [] };
    for (let attempt = 0; attempt < options.repeat; attempt += 1) {
      const { safety, ...request } = replyRequest(scenario);
      const reply = await infer(options, request);
      const judged = await infer(options, judgeRequest(options, scenario, reply.content));
      result.runs.push({ reply: reply.content, model: reply.model, ms: reply.ms, safety, metrics: measure(reply.content),
        judgement: readJudgement(judged.content, scenario), judgeModel: judged.model });
      process.stderr.write(`${scenario.id} #${attempt + 1}: ${scenarioScore(result.runs.at(-1)).skill}% skill, ${reply.ms} ms\n`);
    }
    results.push(result);
  }
  const summary = summarize(results);
  const report = { promptVersion: domain.PROMPT_VERSION, ranAt: new Date().toISOString(), options: { repeat: options.repeat, judge: options.judgeModel || options.judgeTask }, summary, results };
  const out = options.out || path.join(os.tmpdir(), `psyx-eval-v${domain.PROMPT_VERSION}-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  printSummary(summary, options.compare ? JSON.parse(fs.readFileSync(options.compare, 'utf8')) : null);
  console.log(`\nFull report: ${out}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { replyRequest, judgeRequest, readJudgement, measure, summarize, GENERIC_CRITERIA };
