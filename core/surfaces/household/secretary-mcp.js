'use strict';


const { ACTION_CATEGORIES, EmailActionError, addEmailAction } = require('./email-action');
const { dayLabel } = require('../../src/services/personalBriefing');
const { familyTimeZone } = require('../../src/domains/household/family');

const SECRETARY_MCP_META = Object.freeze({
  'agentx/owner': 'agentx-household',
  'agentx/version': '1.46.0',
  'agentx/capability': 'nestor-secretary-tools'
});

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const SECRETARY_TOOLS = Object.freeze([
  Object.freeze({
    name: 'get_sound',
    title: 'Get Animal Sound Recording',
    description: 'Return an existing local animal recording or labelled sound effect for a connected client to play. Use this for animal sounds, not text-to-speech. Required argument: query (string), a sound id or a French/English animal sound request, e.g. {"query":"elephant"}. The structured sound includes its URL, kind and playback gain; do not read its URL aloud or claim playback has happened.',
    inputSchema: objectSchema({ query: { type: 'string', minLength: 1, maxLength: 500 } }, ['query']),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'add_personal_task',
    title: 'Add Personal Task',
    description: 'Add one real-life errand, reminder, purchase, call, appointment, or household task to Dad\'s canonical personal pipeline. Use create_todo for specified platform or code work; software deployments, CI, hosting and service alerts are never personal tasks. An idea to keep, or anything you are unsure how to file, goes to add_idea instead. Skip a task whose activity has already happened (an old email about a past event).',
    inputSchema: objectSchema({
      title: { type: 'string', minLength: 1, maxLength: 200 },
      note: { type: 'string', maxLength: 2000 },
      dueAt: { type: 'string', maxLength: 40, description: 'When Dad must act (ISO date or datetime).' },
      relevantUntil: { type: 'string', maxLength: 40, description: 'Date of the activity or event the task serves (e.g. the camp day for its form or lunch). After it the task is pointless. Omit when the task stays useful regardless of any event.' },
      priority: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      origin: { type: 'string', enum: ['chat', 'email'], description: 'email only when the task comes from a Gmail thread you inspected; otherwise omit.' }
    }, ['title']),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'add_idea',
    title: 'Keep An Idea',
    description: 'Keep one raw idea for Dad to sort later in the idea inbox. Real-life errand with an action → add_personal_task; specified platform or code work → create_todo; anything else, or any doubt → add_idea. Keep the person’s own words as text. One message may hold several ideas: call once per idea. Nothing is queued or executed until Dad reviews it.',
    inputSchema: objectSchema({
      text: { type: 'string', minLength: 1, maxLength: 2000, description: 'The idea in the person’s own words.' },
      tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 5, description: 'Optional areas, e.g. maison, voyage, agentx.' }
    }, ['text']),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'list_personal_tasks',
    title: 'List Personal Tasks',
    description: 'List Dad\'s personal tasks from the canonical pipeline, most urgent first. Call this before answering what is due, next, or on the list. Name days exactly as dueLocal, relevantUntilLocal and todayLocal give them; never compute a weekday yourself.',
    inputSchema: objectSchema({
      includeDone: { type: 'boolean', default: false },
      includeNotes: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'update_personal_task',
    title: 'Update Personal Task',
    description: 'Change the due date, priority or activity date (relevantUntil) of one open personal task by numeric id. Pass null to clear a date. Use it when Dad says a late task still matters until a given day.',
    inputSchema: objectSchema({
      ref: { type: 'string', pattern: '^[0-9]{1,4}$' },
      dueAt: { type: ['string', 'null'], maxLength: 40 },
      priority: { type: 'integer', minimum: 1, maximum: 5 },
      relevantUntil: { type: ['string', 'null'], maxLength: 40 }
    }, ['ref']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'personal_briefing',
    title: 'Personal Morning Briefing',
    description: 'Compose Dad\'s French morning brief (at most six lines) from all open personal tasks: late and today items, the next preparation, old deadlines to confirm, tasks whose activity has passed, and undated tasks. Relay its text as is. Read-only; delivers nothing.',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'complete_personal_task',
    title: 'Complete Personal Task',
    description: 'Mark exactly one personal task done by numeric id or distinctive title phrase. Ambiguous phrases fail with candidates instead of guessing.',
    inputSchema: objectSchema({
      ref: { type: 'string', minLength: 1, maxLength: 200 },
      note: { type: 'string', maxLength: 2000 },
      by: { type: 'string', maxLength: 120 }
    }, ['ref']),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'add_email_action',
    title: 'Add Email Action to Leantime',
    description: 'Idempotently create or reuse one card in the restricted Secretary — Email Actions Leantime project for one inspected Gmail thread. Use only for Urgent, Needs Reply, or Waiting. The Gmail thread id is the deduplication key; never include the message body.',
    inputSchema: objectSchema({
      gmailThreadId: { type: 'string', minLength: 8, maxLength: 256 },
      gmailMessageId: { type: 'string', minLength: 8, maxLength: 256 },
      category: { type: 'string', enum: ACTION_CATEGORIES },
      action: { type: 'string', minLength: 1, maxLength: 200 },
      subject: { type: 'string', maxLength: 300 },
      sender: { type: 'string', maxLength: 200 },
      messageDate: { type: 'string', maxLength: 60 },
      dueAt: { type: 'string', maxLength: 40 }
    }, ['gmailThreadId', 'category', 'action']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  }),
  Object.freeze({
    name: 'shopping_list',
    title: 'Household Shopping List',
    description: 'The household\'s single running grocery and shopping list. Use it whenever Dad names things to buy (not a note, not a task): action add with the items, list to read it back, bought to cross items off. Adding an item already on the list is harmless. Reply with the current list it returns.',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['add', 'list', 'bought'] },
      items: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 }, maxItems: 30 }
    }, ['action']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    _meta: SECRETARY_MCP_META
  })
]);

function textResult(structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: false
  };
}

function emailActionPublicMessage(error) {
  const code = String(error?.code || '');
  if (['EMAIL_ACTION_BAD_THREAD_ID', 'EMAIL_ACTION_BAD_MESSAGE_ID', 'EMAIL_ACTION_BAD_CATEGORY',
    'EMAIL_ACTION_ACTION_REQUIRED', 'EMAIL_ACTION_BAD_DUE_DATE'].includes(code)) return error.message;
  if (code === 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED') return 'Email-action integration is not configured.';
  return 'Email action could not be recorded.';
}

function errorResult(error, { emailAction = false } = {}) {
  const expectedEmailError = error instanceof EmailActionError
    || String(error?.code || '').startsWith('EMAIL_ACTION_');
  const structuredContent = {
    error: emailAction && !expectedEmailError ? 'EMAIL_ACTION_ERROR' : (error.code || 'SECRETARY_TOOL_ERROR'),
    message: emailAction ? emailActionPublicMessage(error) : error.message,
    ...(!emailAction && error.details ? error.details : {})
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true
  };
}

function plainArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('arguments must be an object');
    error.code = 'INVALID_ARGUMENTS';
    throw error;
  }
  return value;
}

async function callSecretaryTool(name, args, deps) {
  try {
    const input = plainArguments(args || {});
    if (name === 'get_sound') {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 500) {
        throw Object.assign(new Error('query must contain 1-500 characters'), { code: 'INVALID_ARGUMENTS' });
      }
      const query = input.query.trim();
      const sound = deps.sounds?.get(query) || deps.sounds?.select(query, { explicitSoundIntent: true }) || null;
      return textResult({ status: sound ? 'available' : 'unavailable', sound,
        playback: 'client_required', message: sound ? 'Introduce the actual recording or labelled effect briefly; the client plays the sound.' : 'No matching local recording is available. Do not replace it with a different animal or synthesized speech.' });
    }
    if (name === 'add_personal_task') return textResult(await deps.personalTasks.create({ ...input, source: 'nestor-secretary' }));
    if (name === 'complete_personal_task') return textResult(await deps.personalTasks.complete({ ...input, by: input.by || 'nestor-secretary' }));
    if (name === 'update_personal_task') return textResult(await deps.personalTasks.update({ ...input, by: 'nestor-secretary' }));
    if (name === 'add_idea') return textResult(await (deps.ideaInbox || require('../../src/services/ideaInboxService')).captureIdea({ text: input.text, tags: input.tags, origin: 'nestor' }));
    if (name === 'personal_briefing') return textResult(await deps.personalTasks.briefing());
    if (name === 'add_email_action') {
      const writer = deps.emailActionWriter || addEmailAction;
      return textResult(await writer(input, {
        model: deps.EmailAction,
        env: deps.emailActionEnv || process.env
      }));
    }
    if (name === 'shopping_list') return textResult(await deps.shoppingList({ action: input.action, items: input.items }));
    if (name === 'list_personal_tasks') {
      const result = await deps.personalTasks.list(input);
      const includeNotes = input.includeNotes === true;
      // Weekday names are computed here, in the household time zone: the model
      // announced "mercredi 24" for a Thursday when it had only ISO dates (#43).
      const timeZone = familyTimeZone();
      const local = (value) => (value && !Number.isNaN(new Date(value).getTime()) ? dayLabel(new Date(value), timeZone) : null);
      return textResult({
        ...result,
        todayLocal: local(deps.now ? deps.now() : new Date()),
        tasks: result.tasks.map((task) => {
          const { note, ...summary } = task;
          const days = { dueLocal: local(summary.dueAt), relevantUntilLocal: local(summary.relevantUntil) };
          if (!includeNotes) return { ...summary, ...days };
          return { ...summary, ...days, note: String(note || '').slice(0, 240), noteTruncated: String(note || '').length > 240 };
        })
      });
    }
    const error = new Error(`unknown personal secretary tool: ${name}`);
    error.code = 'UNKNOWN_TOOL';
    throw error;
  } catch (error) {
    return errorResult(error, { emailAction: name === 'add_email_action' });
  }
}

function mergeTools(body) {
  if (!Array.isArray(body?.result?.tools)) return body;
  const privateTools = new Map(SECRETARY_TOOLS.map((tool) => [tool.name, tool]));
  for (const tool of body.result.tools) {
    const replacement = privateTools.get(tool?.name);
    if (!replacement) continue;
    if (tool?._meta?.['agentx/owner'] !== SECRETARY_MCP_META['agentx/owner']
      || tool?._meta?.['agentx/version'] !== SECRETARY_MCP_META['agentx/version']) {
      return {
        jsonrpc: body.jsonrpc || '2.0',
        id: body.id ?? null,
        error: {
          code: -32009,
          message: 'MCP tool ownership collision',
          data: { code: 'MCP_TOOL_OWNERSHIP_COLLISION', tool: tool.name }
        }
      };
    }
  }
  const inserted = new Set();
  const tools = [];
  for (const tool of body.result.tools) {
    const replacement = privateTools.get(tool?.name);
    if (!replacement) {
      tools.push(tool);
    } else if (!inserted.has(tool.name)) {
      tools.push(replacement);
      inserted.add(tool.name);
    }
  }
  for (const tool of SECRETARY_TOOLS) if (!inserted.has(tool.name)) tools.push(tool);
  return {
    ...body,
    result: {
      ...body.result,
      tools
    }
  };
}

function secretaryMcpMiddleware(deps) {
  const privateNames = new Set(SECRETARY_TOOLS.map((tool) => tool.name));
  return async (req, res, next) => {
    const message = req.body;
    if (req.method !== 'POST' || !message || message.jsonrpc !== '2.0') return next();
    if (message.method === 'tools/list') {
      const downstreamJson = res.json.bind(res);
      res.json = (body) => downstreamJson(mergeTools(body));
      return next();
    }
    const name = message.method === 'tools/call' ? message.params?.name : null;
    if (!privateNames.has(name)) return next();
    if (message.id === undefined || message.id === null) return res.status(204).end();
    const result = await callSecretaryTool(name, message.params?.arguments || {}, deps);
    return res.json({ jsonrpc: '2.0', id: message.id, result });
  };
}

function registerSecretaryMcp({ app, standardJsonParser, models, personalTasks, sounds }) {
  const middleware = secretaryMcpMiddleware({
    personalTasks,
    shoppingList: require('../../src/services/shoppingListService').shoppingList,
    EmailAction: models.EmailAction,
    sounds
  });
  app.use(['/mcp', '/api/mcp'], standardJsonParser, middleware);
  return middleware;
}

module.exports = {
  SECRETARY_TOOLS,
  callSecretaryTool,
  mergeTools,
  registerSecretaryMcp,
  secretaryMcpMiddleware
};
