'use strict';

process.env.AGENTX_PARENTAL_CODE = '739251';
process.env.PSYX_ACCESS_MODE = 'token';
process.env.PSYX_LOOPBACK_BYPASS = 'false';
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { app } = require('../../src/app');
const { registerParentalAccess, familyRequest } = require('../../src/middleware/parentalAccess');
const edge = pending => pending.set('X-AgentX-Entry', 'household');

describe('parental access at the single household gateway', () => {
  test('service gateway authorization shares adult access and fails closed without the entry marker', async () => {
    await request(app).get('/api/access/authorize').expect(401);
    await edge(request(app).get('/api/access/authorize')).expect(401);
    const unlock = await edge(request(app).post('/api/access/unlock')).send({ code: '739251' }).expect(200);
    const cookie = unlock.headers['set-cookie'][0].split(';')[0];
    await request(app).get('/api/access/authorize').set('Cookie', cookie).expect(204).expect('Cache-Control', 'private, no-store');
    await edge(request(app).get('/panel')).set('Cookie', cookie).expect(200);
    await request(app).get('/api/access/authorize').set('Cookie', cookie).expect(401);
    await request(app).get('/api/access/authorize').set('Authorization', 'Bearer 739251').expect(204);
    await request(app).get('/api/access/authorize').set('Authorization', 'Bearer invalid').expect(401);
  });
  test('anonymous family navigation works while direct adult APIs, parent controls and path variants stay closed', async () => {
    const landing = await edge(request(app).get('/')).expect(200);
    expect(landing.text).toContain('Choisir un espace');
    expect(landing.text).not.toContain('household/workspaces');
    await edge(request(app).get('/panel')).expect(200);
    await edge(request(app).get('/dad')).expect(302).expect('Location', '/unlock?next=%2Fdad');
    await edge(request(app).get('/api/family/profiles')).expect(200);
    // The docked avatar is shared with the family page; unconfigured here, so past the gate it is a 404.
    expect((await edge(request(app).get('/api/household/avatar/llmx-face.js')).expect(404)).body.code).toBe('AVATAR_NOT_CONFIGURED');
    // The family conversation loads Core's shared voice loop and its capture worklet; other Core scripts stay closed.
    for (const name of ['speech-language', 'playback-hold', 'voice-timeline', 'browser-conversation', 'speech-ladder', 'voice-capture-worklet']) {
      await edge(request(app).get(`/js/voice/${name}.js`)).expect(200).expect('Content-Type', /javascript/);
    }
    await edge(request(app).get('/js/dashboard.js')).expect(302);
    // Both household pages load the same content-free editor; its private API stays behind the gate.
    await edge(request(app).get('/js/conversation-recap.js')).expect(200).expect('Content-Type', /javascript/);
    await edge(request(app).get('/css/conversation-recap.css')).expect(200).expect('Content-Type', /css/);
    for (const method of ['get', 'put', 'post']) {
      const path = '/api/voice-personas/private/sessions/unknown-session/recap' + (method === 'post' ? '/draft' : '');
      expect((await edge(request(app)[method](path)).send({}).expect(401)).body.code).toBe('ADULT_LOCKED');
    }
    for (const pathname of ['/js/conversation-recap.js/x', '/css/conversation-recap.css/x']) {
      expect(familyRequest({ method: 'GET' }, pathname)).toBe(false);
    }
    expect(familyRequest({ method: 'POST' }, '/js/conversation-recap.js')).toBe(false);
    for (const pathname of ['/js/voice/../dashboard.js', '/js/voice/x/../../dashboard.js', '/js/voice/%2e%2e/dashboard.js', '/js/voice/', '/js/voice/browser-conversation.js/x']) {
      expect(familyRequest({ method: 'GET' }, pathname)).toBe(false);
    }
    expect(familyRequest({ method: 'POST' }, '/js/voice/browser-conversation.js')).toBe(false);
    // The family voice page may send a turn's timeline; the route validates it, and the private one stays locked.
    expect((await edge(request(app).post('/api/voice-personas/family/sessions/any-session/voice-timings')).send({}).expect(400)).body.code).toBe('VOICE_TIMINGS_INVALID');
    expect((await edge(request(app).post('/api/voice-personas/private/sessions/any-session/voice-timings')).send({}).expect(401)).body.code).toBe('ADULT_LOCKED');
    // The child's page may record the mask's math receipt; the route itself validates the family turn.
    expect((await edge(request(app).post('/api/family/math-receipts')).send({}).expect(400)).body.code).toBe('MATH_RECEIPT_INVALID');
    // Family pictures pass the gate; the route only serves sources allowed for Famille (#168).
    expect((await edge(request(app).get('/api/voice-personas/family/visuals/file?source=photos&path=a.jpg')).expect(404)).body.code).toBe('HOUSEHOLD_IMAGE_NOT_FOUND');
    expect((await edge(request(app).get('/api/voice-personas/private/visuals/file?source=photos&path=a.jpg')).expect(401)).body.code).toBe('ADULT_LOCKED');
    expect((await edge(request(app).get('/api/voice-personas/family/visuals/generated?path=%2Fx%2Fmedia%2Fa.png')).expect(404)).body.code).toBe('HOUSEHOLD_IMAGE_NOT_FOUND');
    expect((await edge(request(app).get('/api/voice-personas/private/visuals/generated?path=%2Fx%2Fmedia%2Fa.png')).expect(401)).body.code).toBe('ADULT_LOCKED');
    // The family page follows its own conversation's background review; the private one stays locked (#169).
    expect((await edge(request(app).get('/api/voice-personas/family/sessions/unknown-session/brain')).expect(404)).body.code).toBe('VOICE_PERSONA_SESSION_NOT_FOUND');
    expect((await edge(request(app).get('/api/voice-personas/private/sessions/unknown-session/brain')).expect(401)).body.code).toBe('ADULT_LOCKED');
    for (const url of ['/api/voice-personas/private/agents', '/api/psyx/state', '/api/rag/search',
      '/api/history', '/api/memory-review', '/API/VOICE-PERSONAS/private/agents/', '/api/%70syx/state']) {
      const response = await edge(request(app).get(url)).expect(401);
      expect(response.body.code).toBe('ADULT_LOCKED');
    }
    // The idea inbox is the parent's review (#13); children capture only through Nestor.
    await edge(request(app).get('/api/family/ideas')).expect(401);
    // Birth dates are the parent's: the Family page reads only the public profile projection.
    for (const url of ['/api/family/profiles/details', '/API/family/profiles/details/']) {
      expect((await edge(request(app).get(url)).expect(401)).body.code).toBe('ADULT_LOCKED');
    }
    expect((await edge(request(app).post('/api/family/profiles/birth-date')).send({ profileId: 'any', birthDate: '2016-03-14' })
      .expect(401)).body.code).toBe('ADULT_LOCKED');
    for (const url of ['/api/family/chores/approve', '/api/family/launch', '/api/family/shopping/bought',
      '/api/family/ideas/any/promote', '/api/family/ideas/any/set-aside',
      '/api/voice-personas/private/notes', '/mcp']) {
      await edge(request(app).post(url)).send({}).expect(401);
    }
    // Children keep their conversations; erasing one is the parent's (#62 follow-up).
    const erase = await edge(request(app).delete('/api/voice-personas/family/sessions/any-session'))
      .send({ confirmation: 'DELETE CONVERSATION' }).expect(401);
    expect(erase.body.code).toBe('ADULT_LOCKED');
    // Children read the shopping list and add to it; crossing off is the parent's.
    await edge(request(app).post('/api/family/shopping/add')).send({ items: ['Synthetic milk'] }).expect(200);
    expect((await edge(request(app).get('/api/family/shopping')).expect(200)).body.data.items).toContain('Synthetic milk');
    // Trusted raw/internal service traffic retains its existing contract.
    await request(app).get('/api/family/profiles').expect(200);
  });

  test('a locked family page offers the unlock entry and the home destination survives the unlock round trip', async () => {
    const panel = await edge(request(app).get('/panel')).expect(200);
    expect(panel.text).toContain('href="/unlock?next=%2F" data-access="unlock"');
    expect(panel.text).toContain('href="/" class="nav-brand"');
    expect(panel.text).toMatch(/href="\/playground"[^>]*data-access="adult"/);
    await edge(request(app).get('/unlock?next=%2F')).expect(200);
    const session = await edge(request(app).get('/api/access/session')).expect(200);
    expect(session.body.data.numericCodeLength).toBe(6);
    const unlock = await edge(request(app).post('/api/access/unlock')).send({ code: '739251', next: '/' }).expect(200);
    expect(unlock.body.data.next).toBe('/');
    const cookie = unlock.headers['set-cookie'][0].split(';')[0];
    const home = await edge(request(app).get('/')).set('Cookie', cookie).expect(200);
    expect(home.text).toContain('id="householdTools"');
  });

  test('parent controls and their legacy reading URLs stay adult-only without revoking the parent session', async () => {
    const urls = ['/dad/family', '/lecture/parents', '/lecture/parents.html'];
    for (const url of urls) {
      await edge(request(app).get(url)).expect(302).expect('Location', '/unlock?next=' + encodeURIComponent(url));
    }
    const unlock = await edge(request(app).post('/api/access/unlock')).send({ code: '739251', next: '/dad/family' }).expect(200);
    const cookie = unlock.headers['set-cookie'][0].split(';')[0];
    for (const url of urls) {
      const page = await edge(request(app).get(url)).set('Cookie', cookie).expect(200);
      expect(page.text).toMatch(/id="nav-trigger-family-group"[^>]*aria-expanded="false"/);
      expect(page.text).toMatch(/href="\/dad\/family" class="dropdown-item active"\s+aria-current="page"\s+data-access="adult"/);
      expect(page.text).not.toContain('Suivi des lectures');
      await edge(request(app).get('/api/access/authorize')).set('Cookie', cookie).expect(204);
    }
  });

  test('one parental cookie opens both personal surfaces; family navigation revokes it for all tabs', async () => {
    const unlock = await edge(request(app).post('/api/access/unlock')).send({ code: '739251', next: '//elsewhere.invalid' }).expect(200);
    expect(unlock.body.data.next).toBe('/dad');
    const cookie = unlock.headers['set-cookie'][0].split(';')[0];
    expect(unlock.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(unlock.headers['set-cookie'][0]).toContain('SameSite=Strict');
    await edge(request(app).get('/dad')).set('Cookie', cookie).expect(200);
    await edge(request(app).get('/api/psyx/state')).set('Cookie', cookie).expect(200);
    await edge(request(app).get('/api/voice-personas/private/agents')).set('Cookie', cookie).expect(200);
    await edge(request(app).get('/panel')).set('Cookie', cookie).expect(200);
    await edge(request(app).get('/api/psyx/state')).set('Cookie', cookie).expect(401);
    await edge(request(app).post('/api/voice-personas/private/notes')).set('Cookie', cookie).send({ operation: 'list' }).expect(401);
  });

  test('common home aliases and chrome load while locked, while service health and private pages stay guarded', async () => {
    for (const url of ['/', '/portal/', '/ecosystem/']) {
      const landing = await edge(request(app).get(url)).expect(200);
      expect(landing.text).toContain('Choisir un espace');
      expect(landing.headers.location).toBeUndefined();
    }
    for (const asset of ['/css/home.css', '/css/product-shell.css', '/js/product-navigation.js',
      '/vendor/fonts/space-grotesk/5.3.0/files/space-grotesk-latin-wght-normal.woff2']) {
      await edge(request(app).get(asset)).expect(200);
    }
    await edge(request(app).get('/api/portal/health')).expect(401);
    for (const page of ['/pipeline', '/finance', '/psyx', '/data-toolbox']) {
      await edge(request(app).get(page)).expect(302).expect('Location', '/unlock?next=' + encodeURIComponent(page));
    }
  });

  test('PsyX uses the parent Core navigation authority and trusted launchers', async () => {
    const previousUrls = app.locals.publicUrls;
    const previousLaunchers = app.locals.trustedRuntimeNavItems;
    try {
      app.locals.publicUrls = { core: 'https://core.example.test', benchmark: 'https://bench.example.test', rag: 'https://rag.example.test' };
      app.locals.trustedRuntimeNavItems = [{ id: 'test-runtime', label: 'Test runtime', href: '/api/test-runtime/open', icon: 'fa-terminal', owner: 'Test' }];
      const unlock = await edge(request(app).post('/api/access/unlock')).send({ code: '739251' }).expect(200);
      const cookie = unlock.headers['set-cookie'][0].split(';')[0];
      const page = await edge(request(app).get('/psyx')).set('Cookie', cookie).expect(200);
      expect(page.text).toContain('href="https://bench.example.test/"');
      expect(page.text).toContain('href="https://rag.example.test/upload"');
      expect(page.text).toContain('href="/api/test-runtime/open"');
      expect(page.text).toMatch(/id="nav-trigger-personal-group"/);
      expect(page.text).toMatch(/href="\/psyx" class="dropdown-item active"/);
      expect(page.text).toContain('class="privacy-home"');
    } finally {
      app.locals.publicUrls = previousUrls;
      app.locals.trustedRuntimeNavItems = previousLaunchers;
    }
  });

  test('PsyX lock revokes the shared adult session and proxy HTTPS sets a secure cookie', async () => {
    const unlocked = await edge(request(app).post('/api/access/unlock')).set('X-Forwarded-Proto', 'https').send({ code: '739251' }).expect(200);
    expect(unlocked.headers['set-cookie'][0]).toContain('Secure');
    const cookie = unlocked.headers['set-cookie'][0].split(';')[0];
    await edge(request(app).post('/api/psyx/auth/lock')).set('Cookie', cookie).send({}).expect(200);
    const state = await edge(request(app).get('/api/access/session')).set('Cookie', cookie).expect(200);
    expect(state.body.data.unlocked).toBe(false);
    await edge(request(app).get('/api/voice-personas/private/agents')).set('Cookie', cookie).expect(401);
  });

  test('expiry, failed attempts and missing configuration use the existing session mechanism', async () => {
    let at = 1000;
    const fixture = express(); fixture.use(cookieParser()); fixture.use(express.json());
    registerParentalAccess({ app: fixture, express, now: () => at, env: { AGENTX_PARENTAL_CODE: 'synthetic', AGENTX_PARENTAL_SESSION_MINUTES: '5' } });
    expect((await edge(request(fixture).get('/api/access/session')).expect(200)).body.data.numericCodeLength).toBeNull();
    fixture.get('/api/private', (_req, res) => res.json({ private: true }));
    const unlocked = await edge(request(fixture).post('/api/access/unlock')).send({ code: 'synthetic' }).expect(200);
    const cookie = unlocked.headers['set-cookie'][0].split(';')[0];
    at += 300001;
    await edge(request(fixture).get('/api/private')).set('Cookie', cookie).expect(401);
    for (let count = 0; count < 8; count++) await edge(request(fixture).post('/api/access/unlock')).send({ code: 'wrong' }).expect(403);
    await edge(request(fixture).post('/api/access/unlock')).send({ code: 'synthetic' }).expect(429);
    at += 300001;
    await edge(request(fixture).post('/api/access/unlock')).send({ code: 'synthetic' }).expect(200);
    const unconfigured = express(); unconfigured.use(cookieParser()); unconfigured.use(express.json());
    registerParentalAccess({ app: unconfigured, express, env: {} });
    await edge(request(unconfigured).post('/api/access/unlock')).send({ code: '' }).expect(503);
    await edge(request(unconfigured).get('/api/private')).expect(401);
  });
});

describe('locked browser navigations to a protected service entry', () => {
  const env = { AGENTX_PARENTAL_CODE: '739251', CORE_PUBLIC_URL: 'https://home.example',
    BENCHMARK_PUBLIC_URL: 'https://home.example:3081', RAG_PUBLIC_URL: 'https://home.example:3082' };
  function gatewayApp(overrides = {}) {
    const gateway = express();
    gateway.use(cookieParser());
    gateway.use(express.json());
    registerParentalAccess({ app: gateway, express, env: { ...env, ...overrides } });
    return gateway;
  }
  const forwarded = (gateway, { host, uri, accept = 'text/html,application/xhtml+xml', method = 'GET' }) =>
    edge(request(gateway).get('/api/access/authorize')).set('Accept', accept).set('X-Forwarded-Method', method)
      .set('X-Forwarded-Proto', 'https').set('X-Forwarded-Host', host).set('X-Forwarded-Uri', uri);

  test('are sent to the unlock page and return to the requested service page once unlocked', async () => {
    const gateway = gatewayApp();
    const target = 'https://home.example:3081/leaderboard?tab=judges';
    await forwarded(gateway, { host: 'home.example:3081', uri: '/leaderboard?tab=judges' })
      .expect(302).expect('Location', `https://home.example/unlock?next=${encodeURIComponent(target)}`)
      .expect('Cache-Control', 'private, no-store');
    const unlock = await edge(request(gateway).post('/api/access/unlock')).send({ code: '739251', next: target }).expect(200);
    expect(unlock.body.data.next).toBe(target);
    const cookie = unlock.headers['set-cookie'][0].split(';')[0];
    await forwarded(gateway, { host: 'home.example:3081', uri: '/leaderboard?tab=judges' }).set('Cookie', cookie).expect(204);
  });

  test('API calls, non-GET requests and unknown destinations still get the bare 401', async () => {
    const gateway = gatewayApp();
    await forwarded(gateway, { host: 'home.example:3081', uri: '/api/benchmark/batches', accept: 'application/json' }).expect(401);
    await forwarded(gateway, { host: 'home.example:3081', uri: '/leaderboard', method: 'POST' }).expect(401);
    await forwarded(gateway, { host: 'evil.example', uri: '/leaderboard' }).expect(401);
    await forwarded(gateway, { host: 'home.example:3081', uri: '//evil.example/x' }).expect(401);
    await edge(request(gateway).get('/api/access/authorize')).set('Accept', 'text/html').expect(401);
  });

  test('the unlock destination only follows the configured public origins', async () => {
    const gateway = gatewayApp();
    for (const [next, expected] of [
      ['https://home.example:3082/', 'https://home.example:3082/'],
      ['https://home.example/portal', 'https://home.example/portal'],
      ['https://evil.example/leaderboard', '/dad'],
      ['http://home.example:3081/leaderboard', '/dad'],
      ['/leaderboard', '/leaderboard']
    ]) {
      const unlock = await edge(request(gateway).post('/api/access/unlock')).send({ code: '739251', next }).expect(200);
      expect(unlock.body.data.next).toBe(expected);
    }
  });

  test('without a configured Core public URL the service check stays a plain 401', async () => {
    const gateway = gatewayApp({ CORE_PUBLIC_URL: '' });
    await forwarded(gateway, { host: 'home.example:3081', uri: '/leaderboard' }).expect(401);
  });
});
