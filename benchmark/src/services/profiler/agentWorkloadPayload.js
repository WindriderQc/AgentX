'use strict';

/**
 * Deterministic payloads and exact scoring for the agent workload probe (#833).
 *
 * The task is the one a coding or documentation worker actually does: read
 * source files and check documented claims against them. Every file, claim
 * and expected answer comes from a seed, so two runs of the same artifact see
 * the same work, and scoring needs no judge model.
 */

const PAYLOAD_VERSION = 1;
const KEYS = ['RETRY_LIMIT', 'TIMEOUT_MS', 'BATCH_SIZE', 'MAX_WORKERS', 'CACHE_TTL_SEC', 'QUEUE_DEPTH', 'PAGE_SIZE',
  'BACKOFF_MS', 'POOL_SIZE', 'WINDOW_SEC', 'MAX_BYTES', 'POLL_MS', 'LEASE_SEC', 'BURST_LIMIT', 'GRACE_MS', 'SHARD_COUNT'];
const NOUNS = ['ledger', 'inventory', 'schedule', 'relay', 'archive', 'session', 'catalog', 'gateway', 'digest', 'monitor',
  'planner', 'registry', 'mailbox', 'journal', 'profile', 'tracker'];
const VERBS = ['normalize', 'collect', 'validate', 'project', 'publish', 'reconcile', 'measure', 'resolve', 'prepare', 'summarize'];

function rng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];
const pad = (n, width = 2) => String(n).padStart(width, '0');

function valueFor(random, key) {
  const scale = /MS$/.test(key) ? 250 : /BYTES$/.test(key) ? 4096 : /SEC$/.test(key) ? 15 : 1;
  return (2 + Math.floor(random() * 60)) * scale;
}

/** A plausible CommonJS module of about `chars` characters holding `facts`. */
function sourceFile(random, path, facts, chars) {
  const noun = pick(random, NOUNS);
  const lines = [`'use strict';`, '', `// ${path}: ${noun} service helpers.`, ''];
  for (const fact of facts) lines.push(`const ${fact.key} = ${fact.actual};`);
  lines.push('');
  let index = 0;
  while (lines.join('\n').length < chars) {
    const verb = pick(random, VERBS);
    const other = pick(random, NOUNS);
    index += 1;
    lines.push(
      `function ${verb}${other[0].toUpperCase()}${other.slice(1)}${index}(input, options = {}) {`,
      `  const items = Array.isArray(input?.${other}s) ? input.${other}s : [];`,
      `  const limit = Number(options.limit) > 0 ? Number(options.limit) : items.length;`,
      `  return items.slice(0, limit).map((item, position) => ({ ...item, position, source: '${noun}' }));`,
      '}', ''
    );
  }
  lines.push(`module.exports = { ${facts.map(fact => fact.key).join(', ')} };`);
  return lines.join('\n');
}

/** Claims, each owned by one file; `mismatch` claims document a wrong value. */
function claims(seed, count, mismatches) {
  const random = rng(seed);
  const keys = [...KEYS].sort(() => random() - 0.5);
  const wrong = new Set();
  while (wrong.size < Math.min(mismatches, count)) wrong.add(Math.floor(random() * count));
  return Array.from({ length: count }, (_, index) => {
    const key = keys[index % keys.length];
    const actual = valueFor(random, key);
    const documented = wrong.has(index) ? actual + (/MS$/.test(key) ? 250 : 1) * (1 + Math.floor(random() * 3)) : actual;
    return {
      id: `C${pad(index + 1)}`,
      path: `src/${pick(random, NOUNS)}/${key.toLowerCase().replace(/_/g, '-')}-${pad(index + 1)}.js`,
      key, actual, documented,
      verdict: documented === actual ? 'ok' : 'mismatch'
    };
  });
}

// ── Session growth: one claim per turn, the file arrives as a tool result ───

const SESSION_SYSTEM = 'You verify documentation claims against source files for a code review. '
  + 'For each request, answer with exactly one line: CHECK <claim id> <ok|mismatch> <actual value from the source>. No other text.';

function sessionTurn(seed, index, chars) {
  const [claim] = claims(seed * 1000 + index, 1, index % 3 === 1 ? 1 : 0);
  const id = `C${pad(index + 1)}`;
  const random = rng(seed * 7919 + index);
  const file = sourceFile(random, claim.path, [claim], chars);
  return {
    claim: { ...claim, id },
    content: `Tool result for read_file("${claim.path}"):\n\`\`\`js\n${file}\n\`\`\`\n\n`
      + `Claim ${id}: the documentation says ${claim.key} in ${claim.path} is ${claim.documented}. Check it against the source.`
  };
}

function scoreSessionAnswer(text, claim) {
  const match = String(text || '').match(/CHECK\s+(C\d+)\s+(ok|mismatch)\s+([0-9]+)/i);
  if (!match) return { correct: false, reason: 'format' };
  const correct = match[1].toUpperCase() === claim.id && match[2].toLowerCase() === claim.verdict && Number(match[3]) === claim.actual;
  return { correct, reason: correct ? null : 'wrong_answer' };
}

// ── Structured output: one JSON object per fact, all of them ───────────────

function structuredOutputPrompt(seed, items) {
  const facts = claims(seed + items, items, Math.ceil(items / 4)).map((claim, index) => ({ ...claim, id: `F${pad(index + 1, 3)}` }));
  const lines = facts.map(fact => `${fact.id} key=${fact.key} documented=${fact.documented} actual=${fact.actual}`);
  return {
    facts,
    prompt: `Below are ${items} facts from a documentation review. Return ONLY a JSON array with exactly one object per fact, `
      + 'in the same order, shaped {"id": string, "key": string, "value": number, "verdict": "ok" | "mismatch"}. '
      + '"value" is the actual value; "verdict" is "ok" when documented equals actual, otherwise "mismatch". '
      + `Do not skip, merge or summarize facts.\n\n${lines.join('\n')}\n`
  };
}

function firstJsonArray(text) {
  const body = String(text || '').replace(/```(?:json)?/gi, '');
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function scoreStructuredOutput(text, facts) {
  const rows = firstJsonArray(text);
  if (!rows) return { passed: false, parsed: false, exact: 0, total: facts.length };
  const exact = facts.filter((fact, index) => {
    const row = rows[index];
    return row && row.id === fact.id && row.key === fact.key && Number(row.value) === fact.actual && row.verdict === fact.verdict;
  }).length;
  return { passed: rows.length === facts.length && exact === facts.length, parsed: true, returned: rows.length, exact, total: facts.length };
}

// ── Verification task: find every planted mismatch in a long context ──────

function verificationPrompt(seed, targetChars, claimCount = 12, mismatchCount = 4) {
  const list = claims(seed, claimCount, mismatchCount);
  const random = rng(seed + 17);
  const perFile = Math.max(1200, Math.floor(targetChars / claimCount) - 400);
  const files = list.map(claim => `File ${claim.path}:\n\`\`\`js\n${sourceFile(random, claim.path, [claim], perFile)}\n\`\`\``);
  const doc = list.map(claim => `| ${claim.id} | ${claim.path} | ${claim.key} | ${claim.documented} |`).join('\n');
  return {
    claims: list,
    expected: list.filter(claim => claim.verdict === 'mismatch').map(claim => claim.id),
    prompt: 'You are reviewing documentation against source code. The documentation table lists configuration values; '
      + 'the source files follow.\n\n| Claim | File | Constant | Documented value |\n|---|---|---|---|\n'
      + `${doc}\n\n${files.join('\n\n')}\n\n`
      + 'Return ONLY a JSON array of the claims whose documented value differs from the source, shaped '
      + '{"id": string, "documented": number, "actual": number}. Return [] if every claim matches.'
  };
}

function scoreVerification(text, built) {
  const rows = firstJsonArray(text);
  if (!rows) return { passed: false, parsed: false, found: 0, falsePositives: 0, expected: built.expected.length };
  const byId = new Map(built.claims.map(claim => [claim.id, claim]));
  const reported = rows.filter(row => row && typeof row.id === 'string');
  const found = built.expected.filter(id => reported.some(row => row.id === id && Number(row.actual) === byId.get(id).actual)).length;
  const falsePositives = reported.filter(row => byId.get(row.id)?.verdict !== 'mismatch').length;
  return { passed: found === built.expected.length && falsePositives === 0, parsed: true, found, falsePositives, expected: built.expected.length };
}

// ── Tool turns: read each file, then record the check, through real tools ─

const TOOLS = Object.freeze([
  { type: 'function', function: { name: 'read_file', description: 'Read one source file of the repository.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'record_check', description: 'Record the verdict for one documentation claim.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['ok', 'mismatch'] }, value: { type: 'number' } },
      required: ['id', 'verdict', 'value'] } } }
]);

function toolTask(seed, count = 12) {
  const list = claims(seed, count, Math.ceil(count / 3));
  const random = rng(seed + 29);
  const files = new Map(list.map(claim => [claim.path, sourceFile(random, claim.path, [claim], 1600)]));
  const manifest = list.map(claim => `- ${claim.id}: ${claim.key} in ${claim.path} is documented as ${claim.documented}`).join('\n');
  return {
    claims: list,
    files,
    system: 'You are a code review agent. Use the tools: read_file to open a source file, record_check to record a verdict. '
      + 'Work through the claims in order. For each claim, read its file, then record its check. Stop when every claim is recorded.',
    user: `Verify these documentation claims against the source:\n${manifest}`
  };
}

module.exports = {
  PAYLOAD_VERSION, SESSION_SYSTEM, TOOLS,
  claims, sessionTurn, scoreSessionAnswer,
  structuredOutputPrompt, scoreStructuredOutput, firstJsonArray,
  verificationPrompt, scoreVerification, toolTask
};
