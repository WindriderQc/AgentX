'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const emailAction = require('../email-action');
const secretaryMcp = require('../secretary-mcp');

const TEST_ENV = Object.freeze({
  LEANTIME_BASE_URL: 'http://leantime.test:8080/',
  LEANTIME_API_KEY: 'synthetic-test-key',
  LEANTIME_EMAIL_ACTION_PROJECT_ID: '4',
  LEANTIME_EMAIL_ACTION_USER_ID: '7'
});

const TARGET_PROOF = Object.freeze({
  'leantime.rpc.Projects.getProject': Object.freeze({
    id: 4,
    name: 'Secretary — Email Actions',
    psettings: 'restricted'
  }),
  'leantime.rpc.Users.getUser': Object.freeze({ id: 7 }),
  'leantime.rpc.Projects.getProjectIdAssignedToUser': Object.freeze([4])
});

function verifiedRpc(handler, calls = []) {
  return async (method, params) => {
    calls.push([method, params]);
    if (Object.hasOwn(TARGET_PROOF, method)) return TARGET_PROOF[method];
    return handler(method, params);
  };
}

function receipt(values = {}) {
  return {
    gmailThreadId: 'aaaaaaaaaaaaaaa1',
    gmailMessageId: '',
    category: 'Needs Reply',
    action: 'Reply to example sender',
    subject: '',
    sender: '',
    messageDate: '',
    dueAt: null,
    gmailUrl: 'https://mail.google.com/mail/#all/aaaaaaaaaaaaaaa1',
    leantimeProjectId: 4,
    leantimeTicketId: null,
    state: 'pending',
    lastError: '',
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...values
  };
}

function actionInput(overrides = {}) {
  return {
    gmailThreadId: 'aaaaaaaaaaaaaaa1',
    gmailMessageId: 'aaaaaaaaaaaaaaa2',
    category: 'Needs Reply',
    action: 'Reply to example sender',
    sender: 'example.test',
    messageDate: '2030-01-01 12:00',
    ...overrides
  };
}

test('normalization preserves the exact bounded Gmail intake contract', () => {
  const config = emailAction.emailActionConfig({
    ...TEST_ENV,
    LEANTIME_EMAIL_ACTION_PROJECT_NAME: 'caller-controlled name must be ignored'
  });
  assert.equal('leantimeProjectName' in config, false);
  const normalized = emailAction.normalizeInput(actionInput({
    action: '  Review   account notice\nnow  ',
    body: 'must never cross the intake boundary'
  }), config);

  assert.equal(normalized.action, 'Review account notice now');
  assert.equal(normalized.gmailUrl, 'https://mail.google.com/mail/#all/aaaaaaaaaaaaaaa1');
  assert.equal(normalized.leantimeProjectId, 4);
  assert.equal('body' in normalized, false);

  for (const [input, code] of [
    [actionInput({ gmailThreadId: 'not an id' }), 'EMAIL_ACTION_BAD_THREAD_ID'],
    [actionInput({ gmailMessageId: 'bad id' }), 'EMAIL_ACTION_BAD_MESSAGE_ID'],
    [actionInput({ category: 'Review' }), 'EMAIL_ACTION_BAD_CATEGORY'],
    [actionInput({ action: ' \n ' }), 'EMAIL_ACTION_ACTION_REQUIRED'],
    [actionInput({ dueAt: 'not-a-date' }), 'EMAIL_ACTION_BAD_DUE_DATE']
  ]) {
    assert.throws(
      () => emailAction.normalizeInput(input, config),
      (error) => error instanceof emailAction.EmailActionError && error.code === code
    );
  }
});

test('Leantime descriptions escape bounded metadata and retain no message body', () => {
  const normalized = emailAction.normalizeInput(actionInput({
    subject: '<script>private()</script>',
    sender: '<img src=x onerror=private()>',
    messageDate: 'today\" onclick=private()',
    body: 'TOP SECRET BODY'
  }), emailAction.emailActionConfig(TEST_ENV));
  const description = emailAction.buildDescription(normalized);

  assert.doesNotMatch(description, /<script>|<img|TOP SECRET BODY/);
  assert.match(description, /&lt;script&gt;private\(\)&lt;\/script&gt;/);
  assert.match(description, /today&quot; onclick=private\(\)/);
  assert.match(description, /Gmail thread: aaaaaaaaaaaaaaa1/);
  assert.match(description, /The email body remains in Gmail and is not copied into Leantime/);
});

test('one restricted-project Leantime ticket activates the Mongo receipt', async () => {
  let createInput;
  const doc = receipt();
  const model = {
    async findOne() { return null; },
    async create(input) {
      createInput = { ...input };
      Object.assign(doc, input);
      return doc;
    }
  };
  const calls = [];
  const rpc = verifiedRpc(async (method) => {
    if (method === 'leantime.rpc.Tickets.getAll') return [];
    if (method === 'leantime.rpc.Tickets.quickAddTicket') return { id: 88 };
    throw new Error(`unexpected method ${method}`);
  }, calls);

  const result = await emailAction.addEmailAction(actionInput({
    subject: 'Account notice',
    body: 'must stay in Gmail',
    leantimeProjectId: 999,
    leantimeUserId: 999
  }), { model, rpc, env: TEST_ENV });

  assert.deepEqual(calls.slice(0, 3).map(([method]) => method), [
    'leantime.rpc.Projects.getProject',
    'leantime.rpc.Users.getUser',
    'leantime.rpc.Projects.getProjectIdAssignedToUser'
  ]);
  assert.equal(calls[3][0], 'leantime.rpc.Tickets.getAll');
  assert.deepEqual(calls[3][1], { searchCriteria: { currentProject: 4, status: '' } });
  assert.equal(calls[4][0], 'leantime.rpc.Tickets.quickAddTicket');
  assert.equal(calls[4][1].params.projectId, 4);
  assert.equal(calls[4][1].params.userId, 7);
  assert.equal('status' in calls[4][1].params, false, 'Leantime resolves the project NEW status');
  assert.equal(calls[4][1].params.headline, 'Reply to example sender');
  assert.doesNotMatch(JSON.stringify(calls), /must stay in Gmail/);
  assert.equal('body' in createInput, false);
  assert.equal(createInput.leantimeProjectId, 4, 'callers cannot select another Leantime project');
  assert.equal(doc.leantimeTicketId, 88);
  assert.equal(doc.state, 'active');
  assert.equal(doc.lastError, '');
  assert.equal(doc.saveCalls, 1);
  assert.deepEqual(result, {
    created: true,
    recovered: false,
    gmailThreadId: 'aaaaaaaaaaaaaaa1',
    category: 'Needs Reply',
    action: 'Reply to example sender',
    dueAt: null,
    leantimeProjectId: 4,
    leantimeTicketId: 88,
    leantimeUrl: 'http://leantime.test:8080/dashboard/home#/tickets/showTicket/88',
    state: 'active'
  });
});

test('an active Mongo receipt is idempotent without another Leantime call', async () => {
  const doc = receipt({ leantimeTicketId: 91, state: 'active' });
  let creates = 0;
  let rpcCalls = 0;
  const model = {
    async findOne() { return doc; },
    async create() { creates += 1; }
  };

  const result = await emailAction.addEmailAction(actionInput(), {
    model,
    rpc: async () => { rpcCalls += 1; },
    env: TEST_ENV
  });

  assert.equal(creates, 0);
  assert.equal(rpcCalls, 0);
  assert.equal(result.created, false);
  assert.equal(result.leantimeTicketId, 91);
});

test('concurrent calls for one Gmail thread coalesce into one write path', async () => {
  const doc = receipt();
  let finds = 0;
  let creates = 0;
  let rpcCalls = 0;
  const model = {
    async findOne() { finds += 1; return null; },
    async create(input) { creates += 1; Object.assign(doc, input); return doc; }
  };
  const rpc = verifiedRpc(async (method) => {
    rpcCalls += 1;
    if (method === 'leantime.rpc.Tickets.getAll') return [];
    if (method === 'leantime.rpc.Tickets.quickAddTicket') return 92;
    throw new Error(`unexpected method ${method}`);
  });

  const [first, second] = await Promise.all([
    emailAction.addEmailAction(actionInput(), { model, rpc, env: TEST_ENV }),
    emailAction.addEmailAction(actionInput(), { model, rpc, env: TEST_ENV })
  ]);

  assert.equal(finds, 1);
  assert.equal(creates, 1);
  assert.equal(rpcCalls, 2);
  assert.equal(first.leantimeTicketId, 92);
  assert.deepEqual(second, first);
});

test('duplicate-key races and interrupted saves recover by the exact project marker', async () => {
  const doc = receipt();
  let finds = 0;
  const model = {
    async findOne() { finds += 1; return finds === 1 ? null : doc; },
    async create() { const error = new Error('duplicate'); error.code = 11000; throw error; }
  };
  const calls = [];
  const rpc = verifiedRpc(async (method) => {
    if (method !== 'leantime.rpc.Tickets.getAll') throw new Error(`unexpected method ${method}`);
    return [
      { id: 98, projectId: 4, description: 'Gmail thread: another-thread' },
      { id: 99, projectId: 4, description: 'Gmail thread: aaaaaaaaaaaaaaa1' }
    ];
  }, calls);

  const result = await emailAction.addEmailAction(actionInput(), { model, rpc, env: TEST_ENV });

  assert.equal(finds, 2);
  assert.equal(calls.length, 4);
  assert.equal(calls[3][1].searchCriteria.currentProject, 4);
  assert.equal(result.recovered, true);
  assert.equal(result.leantimeTicketId, 99);
});

test('opaque Leantime success is verified by marker and otherwise fails closed', async () => {
  const recoveredDoc = receipt({ gmailThreadId: 'bbbbbbbbbbbbbbb1' });
  const model = {
    async findOne() { return null; },
    async create(input) { Object.assign(recoveredDoc, input); return recoveredDoc; }
  };
  const recoveredCalls = [];
  let recoveredDeliveryCalls = 0;
  const recoveredRpc = verifiedRpc(async (method) => {
    recoveredDeliveryCalls += 1;
    if (method === 'leantime.rpc.Tickets.getAll' && recoveredDeliveryCalls === 1) return [];
    if (method === 'leantime.rpc.Tickets.quickAddTicket') return true;
    if (method === 'leantime.rpc.Tickets.getAll') {
      return [{ id: 101, projectId: 4, description: 'Gmail thread: bbbbbbbbbbbbbbb1' }];
    }
    throw new Error(`unexpected method ${method}`);
  }, recoveredCalls);
  const recovered = await emailAction.addEmailAction(actionInput({
    gmailThreadId: 'bbbbbbbbbbbbbbb1',
    gmailMessageId: 'bbbbbbbbbbbbbbb2'
  }), { model, rpc: recoveredRpc, env: TEST_ENV });

  assert.deepEqual(recoveredCalls.map(([method]) => method), [
    'leantime.rpc.Projects.getProject',
    'leantime.rpc.Users.getUser',
    'leantime.rpc.Projects.getProjectIdAssignedToUser',
    'leantime.rpc.Tickets.getAll',
    'leantime.rpc.Tickets.quickAddTicket',
    'leantime.rpc.Tickets.getAll'
  ]);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.leantimeTicketId, 101);

  const failedDoc = receipt({ gmailThreadId: 'ccccccccccccccc1' });
  const failedModel = {
    async findOne() { return null; },
    async create(input) { Object.assign(failedDoc, input); return failedDoc; }
  };
  await assert.rejects(
    emailAction.addEmailAction(actionInput({
      gmailThreadId: 'ccccccccccccccc1',
      gmailMessageId: 'ccccccccccccccc2'
    }), {
      model: failedModel,
      rpc: verifiedRpc(async (method) => method.endsWith('getAll') ? [] : true),
      env: TEST_ENV
    }),
    (error) => error.code === 'EMAIL_ACTION_LEANTIME_CREATE_FAILED'
  );
  assert.equal(failedDoc.state, 'error');
  assert.equal(failedDoc.lastError, 'EMAIL_ACTION_LEANTIME_CREATE_FAILED');
});

test('a failed delivery stores only its stable code and a later retry recovers safely', async () => {
  const doc = receipt();
  let firstLookup = true;
  const model = {
    async findOne() {
      if (firstLookup) { firstLookup = false; return null; }
      return doc;
    },
    async create(input) { Object.assign(doc, input); return doc; }
  };
  const deliveryError = new emailAction.EmailActionError(`transport failed ${'x'.repeat(700)}`, {
    code: 'EMAIL_ACTION_LEANTIME_HTTP',
    status: 502
  });

  await assert.rejects(
    emailAction.addEmailAction(actionInput(), {
      model,
      rpc: verifiedRpc(async () => { throw deliveryError; }),
      env: TEST_ENV
    }),
    deliveryError
  );
  assert.equal(doc.state, 'error');
  assert.equal(doc.lastError, 'EMAIL_ACTION_LEANTIME_HTTP');
  assert.doesNotMatch(doc.lastError, /transport failed|x{10}/);

  const retry = await emailAction.addEmailAction(actionInput(), {
    model,
    rpc: verifiedRpc(async (method) => {
      if (method === 'leantime.rpc.Tickets.getAll') {
        return [{ id: 103, projectId: 4, description: 'Gmail thread: aaaaaaaaaaaaaaa1' }];
      }
      throw new Error(`unexpected method ${method}`);
    }),
    env: TEST_ENV
  });
  assert.equal(retry.recovered, true);
  assert.equal(retry.leantimeTicketId, 103);
  assert.equal(doc.state, 'active');
  assert.equal(doc.lastError, '');
});

test('Leantime RPC retries only bounded 429 responses and rejects missing credentials', async () => {
  let fetchCalls = 0;
  const sleeps = [];
  const result = await emailAction.leantimeRpc('leantime.rpc.Tickets.getAll', {}, 0, {
    env: TEST_ENV,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls <= 4) return { status: 429, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({ result: [{ id: 1 }] }) };
    }
  });
  assert.deepEqual(result, [{ id: 1 }]);
  assert.equal(fetchCalls, 5);
  assert.deepEqual(sleeps, [1000, 2000, 3000, 4000]);

  let called = false;
  await assert.rejects(
    emailAction.leantimeRpc('leantime.rpc.Tickets.getAll', {}, 0, {
      env: { ...TEST_ENV, LEANTIME_API_KEY: '' },
      fetchImpl: async () => { called = true; }
    }),
    (error) => error.code === 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED' && error.status === 503
  );
  assert.equal(called, false);

  let exhaustedCalls = 0;
  await assert.rejects(
    emailAction.leantimeRpc('leantime.rpc.Tickets.getAll', {}, 0, {
      env: TEST_ENV,
      sleep: async () => {},
      fetchImpl: async () => {
        exhaustedCalls += 1;
        return { status: 429, ok: false, json: async () => ({}) };
      }
    }),
    (error) => error.code === 'EMAIL_ACTION_LEANTIME_HTTP' && error.status === 502
  );
  assert.equal(exhaustedCalls, 5, 'the initial request plus four retries is the hard ceiling');

  let storageReads = 0;
  await assert.rejects(
    emailAction.addEmailAction(actionInput(), {
      model: {
        async findOne() { storageReads += 1; },
        async create() { throw new Error('must not write'); }
      },
      env: { ...TEST_ENV, LEANTIME_EMAIL_ACTION_PROJECT_ID: 'not-a-project' }
    }),
    (error) => error.code === 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED' && error.status === 503
  );
  assert.equal(storageReads, 0, 'invalid restricted-project configuration fails before a receipt write');
  for (const name of ['LEANTIME_BASE_URL', 'LEANTIME_EMAIL_ACTION_PROJECT_ID', 'LEANTIME_EMAIL_ACTION_USER_ID']) {
    assert.throws(() => emailAction.emailActionConfig({ ...TEST_ENV, [name]: '' }),
      error => error.code === 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED', `${name} requires instance configuration`);
  }
});

test('Leantime RPC has a deadline and sanitizes transport or response failures', async () => {
  let observedSignal;
  await assert.rejects(
    emailAction.leantimeRpc('leantime.rpc.Tickets.getAll', {}, 0, {
      env: TEST_ENV,
      fetchImpl: async (_url, options) => {
        observedSignal = options.signal;
        throw new Error('socket failed with private target details');
      }
    }),
    (error) => error.code === 'EMAIL_ACTION_LEANTIME_TRANSPORT'
      && error.message === 'Leantime RPC leantime.rpc.Tickets.getAll transport failed'
  );
  assert.ok(observedSignal instanceof AbortSignal);

  await assert.rejects(
    emailAction.leantimeRpc('leantime.rpc.Tickets.getAll', {}, 0, {
      env: TEST_ENV,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => { throw new Error('private parse detail'); }
      })
    }),
    (error) => error.code === 'EMAIL_ACTION_LEANTIME_RESPONSE_INVALID'
      && error.message === 'Leantime RPC leantime.rpc.Tickets.getAll returned invalid JSON'
  );

  await assert.rejects(
    emailAction.leantimeRpc('leantime.rpc.Tickets.getAll', {}, 0, {
      env: TEST_ENV,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => ({ error: { message: 'password=private C:\\Users\\operator sender@example.test' } })
      })
    }),
    (error) => error.code === 'EMAIL_ACTION_LEANTIME_RPC'
      && error.message === 'Leantime RPC leantime.rpc.Tickets.getAll was rejected'
      && !/private|operator|example/.test(error.message)
  );
});

test('email-action readiness proves the configured project, user assignment, and restricted ticket read', async () => {
  const calls = [];
  const ready = await emailAction.checkEmailActionReadiness({
    env: TEST_ENV,
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (method === 'leantime.rpc.Projects.getProject') {
        return { id: '4', name: 'Secretary — Email Actions', psettings: 'restricted' };
      }
      if (method === 'leantime.rpc.Users.getUser') return { id: 7 };
      if (method === 'leantime.rpc.Projects.getProjectIdAssignedToUser') return [4];
      if (method === 'leantime.rpc.Tickets.getAll') return [];
      throw new Error(`unexpected method ${method}`);
    }
  });
  assert.deepEqual(calls, [
    ['leantime.rpc.Projects.getProject', { id: 4 }],
    ['leantime.rpc.Users.getUser', { id: 7 }],
    ['leantime.rpc.Projects.getProjectIdAssignedToUser', { userId: 7 }],
    ['leantime.rpc.Tickets.getAll', { searchCriteria: { currentProject: 4, status: '' } }]
  ]);
  assert.deepEqual(ready, {
    readOnly: true,
    configured: true,
    projectAccessible: true,
    projectIdentityVerified: true,
    projectRestricted: true,
    userExists: true,
    userAssigned: true,
    ticketReadAccessible: true,
    restrictedProjectId: 4,
    restrictedUserId: 7,
    authorities: [
      'leantime.rpc.Projects.getProject',
      'leantime.rpc.Users.getUser',
      'leantime.rpc.Projects.getProjectIdAssignedToUser',
      'leantime.rpc.Tickets.getAll'
    ],
    code: 'EMAIL_ACTION_READY'
  });

  const missing = await emailAction.checkEmailActionReadiness({
    env: { ...TEST_ENV, LEANTIME_API_KEY: '' },
    rpc: async () => { throw new Error('must not run'); }
  });
  assert.deepEqual(missing, {
    readOnly: true,
    configured: false,
    projectAccessible: false,
    projectIdentityVerified: false,
    projectRestricted: false,
    userExists: false,
    userAssigned: false,
    ticketReadAccessible: false,
    code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED'
  });
});

test('email-action readiness fails closed on identity, assignment, or ticket-scope drift', async () => {
  const scenarios = [
    {
      name: 'wrong project identity',
      resultFor: { 'leantime.rpc.Projects.getProject': { id: 99 } },
      code: 'EMAIL_ACTION_PROJECT_IDENTITY_MISMATCH',
      calls: 1
    },
    {
      name: 'project name or restriction drift',
      resultFor: {
        'leantime.rpc.Projects.getProject': {
          id: 4,
          name: 'Another project',
          psettings: 'open'
        }
      },
      code: 'EMAIL_ACTION_PROJECT_IDENTITY_MISMATCH',
      calls: 1
    },
    {
      name: 'wrong user identity',
      resultFor: {
        'leantime.rpc.Projects.getProject': {
          id: 4, name: 'Secretary — Email Actions', psettings: 'restricted'
        },
        'leantime.rpc.Users.getUser': { id: 99 }
      },
      code: 'EMAIL_ACTION_USER_UNAVAILABLE',
      calls: 2
    },
    {
      name: 'user not assigned',
      resultFor: {
        'leantime.rpc.Projects.getProject': {
          id: 4, name: 'Secretary — Email Actions', psettings: 'restricted'
        },
        'leantime.rpc.Users.getUser': { id: 7 },
        'leantime.rpc.Projects.getProjectIdAssignedToUser': [{ projectId: 9 }]
      },
      code: 'EMAIL_ACTION_USER_NOT_ASSIGNED',
      calls: 3
    },
    {
      name: 'ticket read escaped the restricted project',
      resultFor: {
        'leantime.rpc.Projects.getProject': {
          id: 4, name: 'Secretary — Email Actions', psettings: 'restricted'
        },
        'leantime.rpc.Users.getUser': { id: 7 },
        'leantime.rpc.Projects.getProjectIdAssignedToUser': [{ projectId: 4 }],
        'leantime.rpc.Tickets.getAll': [{ id: 1, projectId: 9 }]
      },
      code: 'EMAIL_ACTION_TICKET_READ_INVALID',
      calls: 4
    }
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const result = await emailAction.checkEmailActionReadiness({
      env: TEST_ENV,
      rpc: async (method) => {
        calls.push(method);
        return scenario.resultFor[method];
      }
    });
    assert.equal(result.code, scenario.code, scenario.name);
    assert.equal(result.ticketReadAccessible, false, scenario.name);
    assert.equal(calls.length, scenario.calls, `${scenario.name} must fail at the first invalid proof`);
  }
});

test('every new or retried mutation re-proves the exact restricted target before quickAdd', async () => {
  const scenarios = [
    {
      name: 'renamed project',
      proof: {
        'leantime.rpc.Projects.getProject': {
          id: 4, name: 'Secretary Email Actions Copy', psettings: 'restricted'
        }
      },
      code: 'EMAIL_ACTION_PROJECT_IDENTITY_MISMATCH'
    },
    {
      name: 'open project',
      proof: {
        'leantime.rpc.Projects.getProject': {
          id: 4, name: 'Secretary — Email Actions', psettings: 'open'
        }
      },
      code: 'EMAIL_ACTION_PROJECT_IDENTITY_MISMATCH'
    },
    {
      name: 'missing configured user',
      proof: { 'leantime.rpc.Users.getUser': false },
      code: 'EMAIL_ACTION_USER_UNAVAILABLE'
    },
    {
      name: 'unassigned configured user',
      proof: { 'leantime.rpc.Projects.getProjectIdAssignedToUser': [9] },
      code: 'EMAIL_ACTION_USER_NOT_ASSIGNED'
    },
    {
      name: 'ticket read outside restricted project',
      tickets: [{ id: 400, projectId: 9, description: 'escaped result' }],
      code: 'EMAIL_ACTION_TICKET_READ_INVALID'
    }
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const gmailThreadId = `4${index}f6012a48bd8cb7`;
    const doc = receipt({ gmailThreadId });
    const model = {
      async findOne() { return null; },
      async create(input) { Object.assign(doc, input); return doc; }
    };
    const calls = [];
    let quickAdds = 0;
    const proof = { ...TARGET_PROOF, ...(scenario.proof || {}) };
    const rpc = async (method, params) => {
      calls.push([method, params]);
      if (Object.hasOwn(proof, method)) return proof[method];
      if (method === 'leantime.rpc.Tickets.getAll') return scenario.tickets || [];
      if (method === 'leantime.rpc.Tickets.quickAddTicket') {
        quickAdds += 1;
        return 999;
      }
      throw new Error(`unexpected method ${method}`);
    };

    await assert.rejects(
      emailAction.addEmailAction(actionInput({
        gmailThreadId,
        gmailMessageId: `5${index}f6012a48bd8cb8`
      }), { model, rpc, env: TEST_ENV }),
      (error) => error.code === scenario.code && error.status === 503,
      scenario.name
    );
    assert.equal(quickAdds, 0, `${scenario.name} must perform zero quickAdd calls`);
    assert.equal(
      calls.some(([method]) => method === 'leantime.rpc.Tickets.quickAddTicket'),
      false,
      scenario.name
    );
    assert.equal(doc.state, 'error', scenario.name);
    assert.equal(doc.lastError, scenario.code, scenario.name);
  }
});

test('the MCP merge exposes the email-action tool and the middleware records it', async () => {
  const tool = secretaryMcp.SECRETARY_TOOLS.find((entry) => entry.name === 'add_email_action');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['gmailThreadId', 'category', 'action']);
  assert.deepEqual(tool.inputSchema.properties.category.enum, emailAction.ACTION_CATEGORIES);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal('body' in tool.inputSchema.properties, false);
  assert.equal(tool.annotations.idempotentHint, true);

  const collision = secretaryMcp.mergeTools({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name: 'check_health' }, { name: 'add_email_action' }] }
  });
  assert.deepEqual(collision.error.data, {
    code: 'MCP_TOOL_OWNERSHIP_COLLISION', tool: 'add_email_action'
  });

  const merged = secretaryMcp.mergeTools({
    jsonrpc: '2.0',
    id: 2,
    result: { tools: [{ name: 'check_health' }, tool, tool] }
  });
  assert.equal(merged.result.tools.filter((entry) => entry.name === 'add_email_action').length, 1);
  assert.equal(
    merged.result.tools.find((entry) => entry.name === 'add_email_action'),
    tool,
    'an exact same-owner/version remerge is idempotent'
  );
  assert.equal(tool._meta['agentx/owner'], 'agentx-household');
  assert.equal(tool._meta['agentx/version'], '1.46.0');
  assert.deepEqual(secretaryMcp.mergeTools({ error: 'Unauthorized' }), { error: 'Unauthorized' });

  let writes = 0;
  const middleware = secretaryMcp.secretaryMcpMiddleware({
    EmailAction: {},
    emailActionWriter: async (input) => {
      writes += 1;
      return { gmailThreadId: input.gmailThreadId, leantimeTicketId: 110, state: 'active' };
    }
  });

  async function invoke(token) {
    const state = { status: 200, body: null, next: false };
    const req = {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'add_email_action', arguments: actionInput() }
      },
      get(name) { return name === 'authorization' && token ? `Bearer ${token}` : ''; }
    };
    const res = {
      status(code) { state.status = code; return this; },
      json(value) { state.body = value; return value; },
      end() { state.ended = true; }
    };
    await middleware(req, res, () => { state.next = true; });
    return state;
  }

  const authorized = await invoke('');
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.result.isError, false);
  assert.equal(authorized.body.result.structuredContent.state, 'active');
  assert.equal(writes, 1);
});
