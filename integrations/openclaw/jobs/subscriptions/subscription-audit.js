#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_REPORT_DIR = path.resolve(process.cwd(), 'reports', 'subscription-audit');
const DEFAULT_STATE_PATH = path.resolve(DEFAULT_REPORT_DIR, 'state.json');
const ACTIONS = new Set(['kept', 'unsubscribed', 'cancelled', 'ignored', 'snoozed']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '...' : text;
}

function parseSender(from) {
  const raw = String(from || 'unknown');
  const emailMatch = raw.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  const domain = emailMatch ? emailMatch[1].toLowerCase() : 'unknown';
  const label = raw
    .replace(/<[^>]+>/g, '')
    .replace(/["']/g, '')
    .replace(/\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\s*/i, '')
    .trim();
  return {
    sender: raw,
    domain,
    vendor: label || domain
  };
}

function normalizeMessages(input) {
  const source = Array.isArray(input) ? input : input?.emails || input?.messages || [];
  return source.map((message) => {
    const sender = parseSender(message.from_ || message.from || message.sender);
    return {
      id: message.id || message.message_id || message.messageId || '',
      vendor: sender.vendor,
      domain: sender.domain,
      sender: sender.sender,
      subject: truncate(message.subject || message.display_title || ''),
      snippet: truncate(message.snippet || message.summary || ''),
      date: message.email_ts || message.date || message.timestamp || '',
      labels: Array.isArray(message.labels) ? message.labels : [],
      hasAttachment: Boolean(message.has_attachment || message.hasAttachment),
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((a) => ({ filename: a.filename, mime_type: a.mime_type, size_bytes: a.size_bytes }))
        : [],
      displayUrl: message.display_url || ''
    };
  }).filter((message) => message.subject || message.snippet || message.sender);
}

function findSignals(messages) {
  const text = messages.map((message) => `${message.subject} ${message.snippet}`).join(' ').toLowerCase();
  const labels = new Set(messages.flatMap((message) => message.labels || []));
  return {
    payment: /\b(receipt|invoice|payment|paid|billing|charge|merchant|monthly invoice)\b/.test(text),
    renewal: /\b(renew|renewal|renews|subscription|plan|trial|membership)\b/.test(text),
    newsletter: /\b(newsletter|news|updates|deal|sale|promo|offer|exclusive|digest)\b/.test(text) || labels.has('CATEGORY_PROMOTIONS'),
    unsubscribe: /\b(unsubscribe|manage preferences|email preferences)\b/.test(text),
    cancelled: /\b(cancelled|canceled|cancellation|ended|closed)\b/.test(text),
    activity: /\b(activity|usage|used|login|sign-in|security|account|purchase|order|receipt)\b/.test(text)
  };
}

function classifyGroup(messages, resolution) {
  const signals = findSignals(messages);
  if (resolution?.status && resolution.status !== 'snoozed') {
    const resolvedAction = resolution.status === 'kept'
      ? 'active_keep'
      : resolution.status === 'ignored'
        ? 'manual_review'
        : 'cancelled_or_done';
    return {
      action: resolvedAction,
      confidence: 'high',
      reason: `Operator marked this vendor as ${resolution.status}.`,
      signals
    };
  }
  if (resolution?.status === 'snoozed' && resolution.snoozeUntil) {
    const until = Date.parse(resolution.snoozeUntil);
    if (!Number.isNaN(until) && until > Date.now()) {
      return {
        action: 'manual_review',
        confidence: 'medium',
        reason: `Operator snoozed this vendor until ${resolution.snoozeUntil}.`,
        signals
      };
    }
  }
  if (signals.cancelled) {
    return { action: 'cancelled_or_done', confidence: 'high', reason: 'Cancellation or completed-service language found.', signals };
  }
  if (signals.payment || signals.renewal) {
    return { action: 'validate_usage', confidence: signals.payment && signals.renewal ? 'high' : 'medium', reason: 'Billing, renewal, receipt, invoice, or subscription language found.', signals };
  }
  if (signals.newsletter || signals.unsubscribe) {
    return { action: 'unsubscribe_candidate', confidence: signals.unsubscribe ? 'high' : 'medium', reason: 'Newsletter, promotion, or unsubscribe/preference signal found.', signals };
  }
  if (signals.activity) {
    return { action: 'active_keep', confidence: 'low', reason: 'Recent account or purchase activity signal found.', signals };
  }
  return { action: 'manual_review', confidence: 'low', reason: 'Not enough signal for a stronger recommendation.', signals };
}

function groupMessages(messages, state) {
  const groups = new Map();
  for (const message of messages) {
    const key = message.domain || message.vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        vendor: message.vendor,
        domain: message.domain,
        messages: []
      });
    }
    groups.get(key).messages.push(message);
  }

  return [...groups.values()].map((group) => {
    group.messages.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const resolution = state.resolutions?.[group.key];
    const classification = classifyGroup(group.messages, resolution);
    const signature = crypto
      .createHash('sha1')
      .update(`${group.key}|${classification.action}|${group.messages[0]?.date || ''}|${group.messages.length}`)
      .digest('hex');
    const previous = state.vendors?.[group.key];
    const repeated = previous?.lastSignature === signature;
    return {
      ...group,
      ...classification,
      lastSeen: group.messages[0]?.date || '',
      count: group.messages.length,
      resolution,
      signature,
      repeated,
      alertSuppressed: repeated && previous?.lastAlertedAt
    };
  }).sort((a, b) => {
    const weight = { validate_usage: 0, manual_review: 1, unsubscribe_candidate: 2, active_keep: 3, cancelled_or_done: 4 };
    return (weight[a.action] ?? 9) - (weight[b.action] ?? 9) || String(b.lastSeen).localeCompare(String(a.lastSeen));
  });
}

function buildNextState(state, groups, run) {
  const vendors = { ...(state.vendors || {}) };
  const now = run.generatedAt;
  for (const group of groups) {
    vendors[group.key] = {
      vendor: group.vendor,
      domain: group.domain,
      lastAction: group.action,
      lastSeen: group.lastSeen,
      lastSignature: group.signature,
      lastAlertedAt: group.repeated ? vendors[group.key]?.lastAlertedAt : now,
      messageCount: group.count
    };
  }
  return {
    version: 1,
    lastRunAt: now,
    lastSource: run.source,
    lastReport: run.reportPath,
    resolutions: state.resolutions || {},
    vendors
  };
}

function renderBadge(action) {
  const labels = {
    validate_usage: 'Validate usage',
    unsubscribe_candidate: 'Unsubscribe candidate',
    active_keep: 'Active keep',
    cancelled_or_done: 'Cancelled or done',
    manual_review: 'Manual review'
  };
  return labels[action] || action;
}

function renderHtml(run, groups) {
  const cards = groups.map((group) => {
    const signalList = Object.entries(group.signals)
      .filter(([, value]) => value)
      .map(([key]) => `<span>${escapeHtml(key)}</span>`)
      .join('');
    const messages = group.messages.slice(0, 3).map((message) => `
      <li>
        <strong>${escapeHtml(message.subject || '(no subject)')}</strong>
        <small>${escapeHtml(message.date)} · ${escapeHtml(message.sender)}</small>
        <p>${escapeHtml(message.snippet)}</p>
      </li>`).join('');
    const resolution = group.resolution
      ? `<p class="resolution">Operator resolution: ${escapeHtml(group.resolution.status)}${group.resolution.snoozeUntil ? ` until ${escapeHtml(group.resolution.snoozeUntil)}` : ''}</p>`
      : '';
    return `
      <article class="vendor ${escapeHtml(group.action)}">
        <div class="vendor-head">
          <div>
            <h2>${escapeHtml(group.vendor)}</h2>
            <p>${escapeHtml(group.domain)} · ${group.count} message${group.count === 1 ? '' : 's'} · last seen ${escapeHtml(group.lastSeen || 'unknown')}</p>
          </div>
          <div class="badge">${escapeHtml(renderBadge(group.action))}</div>
        </div>
        <p class="reason">${escapeHtml(group.reason)} Confidence: ${escapeHtml(group.confidence)}.${group.alertSuppressed ? ' Repeated alert suppressed from prior run.' : ''}</p>
        <div class="signals">${signalList || '<span>no strong signals</span>'}</div>
        ${resolution}
        <ul>${messages}</ul>
      </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentX Subscription Audit</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, Segoe UI, Arial, sans-serif; }
    body { margin: 0; background: #f7f8fb; color: #18202f; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    header { display: grid; gap: 10px; margin-bottom: 22px; }
    h1 { margin: 0; font-size: 30px; letter-spacing: 0; }
    h2 { margin: 0 0 4px; font-size: 18px; letter-spacing: 0; }
    p { margin: 0; line-height: 1.5; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 18px 0; }
    .metric, .notice, .instructions, .vendor { border: 1px solid #d7dce6; background: #fff; border-radius: 8px; }
    .metric { padding: 12px; }
    .metric strong { display: block; font-size: 22px; margin-top: 4px; }
    .notice { padding: 14px 16px; border-left: 5px solid #3b82f6; }
    .instructions { padding: 16px; margin: 18px 0 24px; }
    code { background: #edf1f7; padding: 2px 5px; border-radius: 4px; }
    .vendor { padding: 16px; margin: 12px 0; }
    .vendor-head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
    .badge { font-weight: 700; padding: 7px 10px; border-radius: 999px; background: #edf1f7; white-space: nowrap; }
    .validate_usage .badge { background: #fff0c2; color: #644400; }
    .unsubscribe_candidate .badge { background: #fee2e2; color: #7f1d1d; }
    .active_keep .badge { background: #dcfce7; color: #14532d; }
    .cancelled_or_done .badge { background: #e5e7eb; color: #374151; }
    .manual_review .badge { background: #dbeafe; color: #1e3a8a; }
    .reason, .resolution { margin: 12px 0; }
    .signals { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
    .signals span { background: #eef2ff; color: #312e81; padding: 4px 7px; border-radius: 999px; font-size: 12px; }
    ul { padding-left: 20px; margin-bottom: 0; }
    li { margin: 10px 0; }
    small { display: block; color: #667085; margin-top: 3px; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      .metric, .notice, .instructions, .vendor { background: #172033; border-color: #2d374b; }
      code, .badge { background: #253047; }
      small { color: #aab3c2; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>AgentX Subscription Audit</h1>
      <p>Recurring review of subscription, renewal, receipt, newsletter, trial, cancellation, and unsubscribe signals found in email.</p>
      <p>Run generated ${escapeHtml(run.generatedAt)} from ${escapeHtml(run.source)}${run.dryRun ? ' · dry run' : ''}.</p>
    </header>
    <section class="notice">
      <strong>No automatic action taken.</strong>
      This workflow does not unsubscribe, cancel, delete, archive, mark messages read, or store full raw message bodies. It stores only headers, snippets, evidence summaries, and operator resolution state.
    </section>
    <section class="summary">
      ${Object.entries(run.counts).map(([key, value]) => `<div class="metric">${escapeHtml(renderBadge(key))}<strong>${value}</strong></div>`).join('')}
    </section>
    <section class="instructions">
      <h2>Operator Instructions</h2>
      <p>Run manually with <code>node integrations/openclaw/jobs/subscriptions/subscription-audit.js run --fixture</code>, or pass Gmail connector search output with <code>--input path/to/gmail-search.json</code>. Mark outcomes with <code>node integrations/openclaw/jobs/subscriptions/subscription-audit.js resolve --vendor vendor-domain --status kept|unsubscribed|cancelled|ignored|snoozed</code>. Use <code>--snooze-until YYYY-MM-DD</code> for snoozed vendors.</p>
    </section>
    ${cards || '<p>No subscription-like messages found for this run.</p>'}
  </main>
</body>
</html>
`;
}

function renderMarkdown(run, groups) {
  const lines = [
    '# AgentX Subscription Audit',
    '',
    'Recurring review of subscription, renewal, receipt, newsletter, trial, cancellation, and unsubscribe signals found in email.',
    '',
    `- Generated: ${run.generatedAt}`,
    `- Source: ${run.source}`,
    `- Dry run: ${run.dryRun ? 'yes' : 'no'}`,
    '- Safety: no automatic unsubscribe, cancel, delete, archive, read-state, or raw-body storage.',
    '',
    '## Summary',
    ''
  ];
  for (const [key, value] of Object.entries(run.counts)) {
    lines.push(`- ${renderBadge(key)}: ${value}`);
  }
  lines.push('', '## Operator Instructions', '');
  lines.push('Run manually with `node integrations/openclaw/jobs/subscriptions/subscription-audit.js run --fixture`, or pass Gmail connector search output with `--input path/to/gmail-search.json`.');
  lines.push('Record outcomes with `node integrations/openclaw/jobs/subscriptions/subscription-audit.js resolve --vendor vendor-domain --status kept|unsubscribed|cancelled|ignored|snoozed`.');
  lines.push('', '## Vendors', '');
  for (const group of groups) {
    lines.push(`### ${group.vendor} (${group.domain})`);
    lines.push(`- Recommendation: ${renderBadge(group.action)} (${group.confidence})`);
    lines.push(`- Reason: ${group.reason}`);
    lines.push(`- Last seen: ${group.lastSeen || 'unknown'}`);
    lines.push(`- Signals: ${Object.entries(group.signals).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
    if (group.alertSuppressed) lines.push('- Deduplication: repeated alert suppressed from prior run.');
    for (const message of group.messages.slice(0, 3)) {
      lines.push(`- Evidence: ${message.date || 'unknown'} — ${message.subject || '(no subject)'} — ${message.sender}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function summarizeCounts(groups) {
  const counts = {
    validate_usage: 0,
    unsubscribe_candidate: 0,
    active_keep: 0,
    cancelled_or_done: 0,
    manual_review: 0
  };
  for (const group of groups) counts[group.action] = (counts[group.action] || 0) + 1;
  return counts;
}

function sampleInput() {
  return {
    emails: [
      {
        id: 'sample-1',
        from_: 'Example Host Billing billing@example-host.invalid',
        subject: 'Monthly invoice 05/2026',
        snippet: 'Attached is your monthly invoice. Payment will be processed automatically using your payment method on file.',
        labels: ['CATEGORY_UPDATES'],
        email_ts: '2026-05-10T08:02:43Z'
      },
      {
        id: 'sample-2',
        from_: 'Example Audio News newsletters@example-audio.invalid',
        subject: 'Hundreds of titles, up to 80% off!',
        snippet: 'Shop monthly deals. You can manage preferences or unsubscribe from this newsletter.',
        labels: ['CATEGORY_PROMOTIONS'],
        email_ts: '2026-05-12T11:57:11Z'
      },
      {
        id: 'sample-3',
        from_: 'Cloud Trial notices@example-cloud.invalid',
        subject: 'Your trial ends soon',
        snippet: 'Your trial subscription renews next week unless cancelled.',
        labels: ['CATEGORY_UPDATES'],
        email_ts: '2026-05-06T09:00:00Z'
      }
    ]
  };
}

function runAudit(args) {
  const reportDir = path.resolve(args['report-dir'] || DEFAULT_REPORT_DIR);
  const statePath = path.resolve(args.state || DEFAULT_STATE_PATH);
  const state = readJson(statePath, { version: 1, resolutions: {}, vendors: {} });
  const input = args.fixture ? sampleInput() : readJson(path.resolve(args.input), null);
  if (!input) throw new Error('Provide --input <gmail-search-json> or --fixture');

  const messages = normalizeMessages(input);
  const groups = groupMessages(messages, state);
  const counts = summarizeCounts(groups);
  const generatedAt = new Date().toISOString();
  const run = {
    generatedAt,
    source: args.source || (args.fixture ? 'local fixture' : 'Gmail connector search export'),
    dryRun: Boolean(args['dry-run'] || args.fixture),
    counts,
    reportPath: path.join(reportDir, 'latest.html')
  };
  ensureDir(reportDir);
  fs.writeFileSync(path.join(reportDir, 'latest.html'), renderHtml(run, groups), 'utf8');
  fs.writeFileSync(path.join(reportDir, 'latest.md'), renderMarkdown(run, groups), 'utf8');
  writeJson(path.join(reportDir, 'latest.summary.json'), {
    generatedAt,
    source: run.source,
    dryRun: run.dryRun,
    counts,
    vendors: groups.map((group) => ({
      key: group.key,
      vendor: group.vendor,
      domain: group.domain,
      action: group.action,
      confidence: group.confidence,
      lastSeen: group.lastSeen,
      count: group.count,
      repeated: group.repeated
    }))
  });
  writeJson(statePath, buildNextState(state, groups, run));
  return { run, groups };
}

function resolveVendor(args) {
  const vendor = args.vendor;
  const status = args.status;
  if (!vendor) throw new Error('--vendor is required');
  if (!ACTIONS.has(status)) throw new Error('--status must be one of kept, unsubscribed, cancelled, ignored, snoozed');
  const statePath = path.resolve(args.state || DEFAULT_STATE_PATH);
  const state = readJson(statePath, { version: 1, resolutions: {}, vendors: {} });
  state.resolutions = state.resolutions || {};
  state.resolutions[vendor] = {
    status,
    note: args.note || '',
    snoozeUntil: status === 'snoozed' ? args['snooze-until'] || '' : '',
    updatedAt: new Date().toISOString()
  };
  writeJson(statePath, state);
  return state.resolutions[vendor];
}

function runTests() {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-subscription-audit-'));
  try {
    const first = runAudit({ fixture: true, 'report-dir': tempDir, state: path.join(tempDir, 'state.json') });
    if (first.groups.length !== 3) throw new Error('expected three sample vendors');
    if (!first.groups.some((group) => group.action === 'validate_usage')) throw new Error('expected validate_usage classification');
    if (!first.groups.some((group) => group.action === 'unsubscribe_candidate')) throw new Error('expected unsubscribe_candidate classification');
    const second = runAudit({ fixture: true, 'report-dir': tempDir, state: path.join(tempDir, 'state.json') });
    if (!second.groups.every((group) => group.repeated)) throw new Error('expected second run to deduplicate repeated vendors');
    const html = fs.readFileSync(path.join(tempDir, 'latest.html'), 'utf8');
    if (!html.includes('No automatic action taken')) throw new Error('missing safety note');
    resolveVendor({ vendor: 'example-audio.invalid', status: 'snoozed', 'snooze-until': '2099-01-01', state: path.join(tempDir, 'state.json') });
    const state = readJson(path.join(tempDir, 'state.json'), {});
    if (state.resolutions['example-audio.invalid'].status !== 'snoozed') throw new Error('resolution was not persisted');
    console.log('subscription-audit tests passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'run') {
    const result = runAudit(args);
    console.log(JSON.stringify({
      status: 'ok',
      report: result.run.reportPath,
      vendors: result.groups.length,
      counts: result.run.counts
    }, null, 2));
    return;
  }
  if (command === 'resolve') {
    const resolution = resolveVendor(args);
    console.log(JSON.stringify({ status: 'ok', resolution }, null, 2));
    return;
  }
  if (command === 'test') {
    runTests();
    return;
  }
  console.log(`Usage:
  node integrations/openclaw/jobs/subscriptions/subscription-audit.js run --fixture
  node integrations/openclaw/jobs/subscriptions/subscription-audit.js run --input gmail-search.json --source "Gmail connector"
  node integrations/openclaw/jobs/subscriptions/subscription-audit.js resolve --vendor example.com --status kept|unsubscribed|cancelled|ignored|snoozed [--snooze-until YYYY-MM-DD]
  node integrations/openclaw/jobs/subscriptions/subscription-audit.js test`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  normalizeMessages,
  groupMessages,
  runAudit,
  resolveVendor,
  sampleInput
};
