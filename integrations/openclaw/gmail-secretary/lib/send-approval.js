import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readBase, mutateBase, required, runGog } from './gmail.js';

const APPROVAL_MS = 300000, GRANT_MS = 30000, MAX_RAW = 40000000;
const parser = fileURLToPath(new URL('./send-snapshot.py', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = params => digest(JSON.stringify(canonical(params)));
const visible = text => JSON.stringify(String(text)).replace(/[\p{Cf}\p{Cc}]/gu,
  char => `\\u{${char.codePointAt(0).toString(16)}}`);

export function inspectSnapshot(raw) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [parser], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', data => { output += data; if (output.length > 100000) child.kill(); });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Gmail snapshot parser unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Cannot safely inspect the Gmail send snapshot'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid Gmail snapshot inspection')); }
    });
    child.stdin.end(raw);
  });
}

// Use Gmail's own compose paths to resolve reply-all recipients, signatures,
// quoted bodies and inherited forward attachments before asking the owner.
export function draftPreparation(sendCommand, action) {
  const verbs = { new: 'create', reply: 'reply', reply_all: 'reply-all', forward: 'forward' };
  const verb = verbs[action];
  if (!verb) throw new Error('Unsupported send action');
  const index = sendCommand.args.indexOf('gmail');
  if (index < 0) throw new Error('Invalid Gmail send command');
  return { ...sendCommand, args: [
    ...sendCommand.args.slice(0, index).filter(arg => !arg.startsWith('--enable-commands-exact=')),
    '--gmail-no-send', `--enable-commands-exact=gmail.drafts.${verb}`,
    'gmail', 'drafts', verb, ...sendCommand.args.slice(index + 2),
  ] };
}

async function readSnapshot(id, config, run) {
  // This internal byte snapshot never enters model context. gog's content
  // wrapper would change the raw base64; the parser supplies the bounded view.
  const value = await run({ args: [...readBase(config, 'gmail.drafts.get').filter(arg => arg !== '--wrap-untrusted'),
    'gmail', 'drafts', 'get', id, '--format=raw'] }, { ...config, maxOutputBytes: MAX_RAW });
  const draft = value?.draft ?? value;
  const raw = draft?.message?.raw;
  if (draft?.id !== id || typeof raw !== 'string' || !raw || raw.length > MAX_RAW
    || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) throw new Error('Gmail returned no exact draft snapshot');
  return { raw, threadId: draft.message.threadId };
}

export function sendDescription(snapshot, origin) {
  const { info, draftId } = snapshot;
  // Never truncate recipients, the subject, counts or review identity. Only the
  // explicitly labelled preview is shortened to fit the native 512-char limit.
  const start = `Send; From:${info.from.map(visible).join(',')}; To:${info.to.map(visible).join(',')}; Cc:${info.cc.map(visible).join(',') || '-'}; Bcc:${info.bcc.map(visible).join(',') || '-'}; Attachments:${info.attachments}; Subject:${visible(info.subject)}; `;
  const end = `; Review Gmail draft ${draftId}; SHA256:${info.sha256.slice(0, 12)} [origin:${origin}]`;
  let preview = info.bodyPreview;
  while (preview && (start + `Body preview (${info.bodyLength} chars):${visible(preview)}` + end).length > 512) {
    preview = [...preview].slice(0, -1).join('');
  }
  const description = start + `Body preview (${info.bodyLength} chars):${visible(preview)}` + end;
  if (description.length > 512 || (info.bodyLength && !preview)) {
    throw new Error('Send details exceed the native approval display; review and send this draft in Gmail');
  }
  return description;
}

export function sendGate({ run = runGog, inspect = inspectSnapshot, now = Date.now } = {}) {
  const pending = new Map();
  const key = (id, context) => JSON.stringify([required(context?.agentId, 'native agent id'),
    required(context?.sessionKey, 'native session key'), required(id, 'native tool call id')]);
  const prune = () => { for (const [id, value] of pending) if (value.expires <= now()) pending.delete(id); };
  return {
    async before(event, config, origin, build, context) {
      prune();
      const id = key(event.toolCallId, context);
      const params = structuredClone(event.params), request = fingerprint(params);
      const entry = { request, expires: now() + APPROVAL_MS, approved: false };
      pending.set(id, entry);
      try {
        let draftId = params.action === 'draft' ? required(params.id, 'draft id') : null;
        if (!draftId) {
          const prepared = await run(draftPreparation(await build(params, config), params.action), config);
          draftId = required(prepared?.draftId ?? prepared?.draft?.id ?? prepared?.id, 'prepared draft id');
        }
        const source = await readSnapshot(draftId, config, run);
        const info = await inspect(source.raw);
        entry.snapshot = { ...source, info, draftId };
        const description = sendDescription(entry.snapshot, origin);
        return { requireApproval: { title: 'Send Gmail message', description, severity: 'warning',
          allowedDecisions: ['allow-once', 'deny'], timeoutMs: APPROVAL_MS, timeoutBehavior: 'deny',
          onResolution(decision) {
            if (pending.get(id) !== entry || entry.resolved) return;
            entry.resolved = true;
            if (decision !== 'allow-once' || entry.expires <= now()) { pending.delete(id); return; }
            entry.approved = true;
            entry.expires = now() + GRANT_MS;
          } } };
      } catch (error) {
        if (pending.get(id) === entry) pending.delete(id);
        throw error;
      }
    },
    async execute(callId, params, config, context) {
      prune();
      const id = key(callId, context);
      const entry = pending.get(id);
      pending.delete(id); // Consume before any I/O, including uncertain sends.
      if (!entry?.approved || entry.request !== fingerprint(params)) {
        throw new Error('Gmail send requires a matching native one-time approval');
      }
      const snapshot = entry.snapshot;
      const current = await readSnapshot(snapshot.draftId, config, run);
      if (digest(Buffer.from(current.raw, 'base64url')) !== snapshot.info.sha256
        || current.threadId !== snapshot.threadId) throw new Error('Gmail draft changed; obtain a new approval');
      // Send the immutable RFC822 bytes, never re-resolve a mutable draft ID,
      // file path, reply-all recipient list or forwarded attachment after approval.
      const args = [...mutateBase(config, 'gmail.send', { maySend: true }), 'gmail', 'send', '--raw-file=-'];
      if (snapshot.threadId) args.push(`--thread-id=${snapshot.threadId}`);
      const value = await run({ args, stdin: Buffer.from(snapshot.raw, 'base64url') }, config);
      return { ...value, approvedSnapshot: snapshot.info.sha256,
        retainedDraftId: snapshot.draftId, draftRetained: true };
    },
  };
}
