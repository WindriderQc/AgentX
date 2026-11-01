'use strict';
// All audio, permissions and transports are synthetic. No service or device access.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { Conversation } = require('../public/browser-conversation');
const capture = require('../../../public/js/voice/voice-capture');
const tick = () => new Promise(resolve => setImmediate(resolve));

function browser() {
  const tracks = [], nodes = [];
  const window = {
    isSecureContext: true, crypto: require('node:crypto').webcrypto,
    AgentXVoiceCapture: { ...capture, Endpoint: class extends capture.Endpoint {
      constructor(...args) { super(...args); this.maxSamples = 2000; }
    } },
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ echoCancellation: true }) };
      tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    AudioContext: class {
      sampleRate = 1000; state = 'running'; destination = {};
      audioWorklet = { addModule: async () => {} };
      async resume() {} async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    },
    AudioWorkletNode: class {
      constructor() { nodes.push(this); }
      port = { postMessage(data) { this.epoch = data.epoch; } }; connect() {} disconnect() {}
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../../public/js/voice/browser-conversation'), 'utf8'),
    { window, URL, AbortController, Blob, setTimeout, clearTimeout });
  let time = 0;
  return { api: window.NestorConversation, tracks, nodes, send(value = 0, count = 20) {
    const node = nodes.at(-1); time += count / 1000;
    node.port.onmessage?.({ data: { samples: new Float32Array(count).fill(value), epoch: node.port.epoch, time } });
  } };
}

test('an opted-in capture discards an over-budget sound, waits for real silence, and recovers on the same stream', async t => {
  const h = browser(), lifetime = new AbortController(), notices = [], errors = [], phrases = [];
  const audio = await h.api.openAudio(lifetime.signal, error => errors.push(error), { onCaptureRecovery: value => notices.push(value.state) });
  t.after(() => { lifetime.abort(); audio.close(); });
  audio.listen(blob => phrases.push(blob), () => {});
  for (let i = 0; i < 101; i++) h.send(.03);
  assert.deepEqual(errors, [], 'a capture limit must not permanently disable the opted-in kiosk');
  assert.deepEqual(notices, ['waiting-silence']); assert.equal(h.tracks[0].enabled, true);
  for (let i = 0; i < 1000; i++) h.send(.03);
  assert.deepEqual(notices, ['waiting-silence'], 'continuous sound cannot repeatedly grow fresh captures');
  assert.equal(phrases.length, 0);
  audio.quiet(); audio.listen(blob => phrases.push(blob), () => {});
  for (let i = 0; i < 101; i++) h.send(.03);
  assert.deepEqual(notices, ['waiting-silence'], 'changing capture owners cannot bypass the real-silence gate');
  for (let i = 0; i < 49; i++) h.send(); assert.deepEqual(notices, ['waiting-silence']);
  h.send(); assert.deepEqual(notices, ['waiting-silence', 'ready']);
  for (let i = 0; i < 10; i++) h.send(.03);
  for (let i = 0; i < 50; i++) h.send();
  assert.equal(phrases.length, 1, 'only a fresh utterance after silence may be submitted');
  assert.equal(h.tracks.length, 1, 'recovery requests no new stream or permission');
  assert.equal(capture.MAX_CAPTURE_BYTES, 33488896, 'the actual production limit stays unchanged');
});

test('explicit Stop while waiting for silence prevents any automatic capture restart', async t => {
  const h = browser(), lifetime = new AbortController(), notices = [];
  const audio = await h.api.openAudio(lifetime.signal, () => {}, { onCaptureRecovery: value => notices.push(value.state) });
  t.after(() => audio.close()); audio.listen(() => assert.fail('no utterance'), () => {});
  for (let i = 0; i < 101; i++) h.send(.03);
  lifetime.abort();
  for (let i = 0; i < 100; i++) h.send();
  assert.deepEqual(notices, ['waiting-silence']); assert.equal(h.tracks[0].stopped, true); assert.equal(h.tracks.length, 1);
});

function harness(extra = {}) {
  let say, speech, options, captureRecovery, heard = 'Hey Nestor, bonjour', failure = null, online = true;
  const counts = { opens: 0, sessions: 0, recognitions: 0, turns: 0, listens: 0, closes: 0, availabilityChecks: 0 }, phases = [];
  const audio = { listen(callback, onSpeech) { say = callback; speech = onSpeech; counts.listens++; }, quiet() {}, close() { counts.closes++; },
    reviewStatus: () => ({ id: 'synthetic-clip' }), recordTranscription() {}, clearReview() {}, async play() {} };
  const c = new Conversation({ recoverCapture: true, canResumeRecognition: () => { counts.availabilityChecks++; return online; },
    wakeAckDelayMs: 0, holdingDelayMs: null,
    openAudio: async (_signal, _onError, value) => { counts.opens++; options = value; captureRecovery = value.onCaptureRecovery; return audio; },
    createSession: async () => { counts.sessions++; return { sessionId: 'synthetic-reliability-session' }; },
    transcribe: async () => { counts.recognitions++; if (failure) throw failure; return heard; },
    turn: async () => { counts.turns++; return { text: '' }; }, message() {}, ...extra
  }, (state, detail) => phases.push([state, detail]));
  return { c, counts, phases, audio, say: () => say(new Blob(['synthetic utterance'])),
    recovery: value => captureRecovery(value), options: () => options, beginSpeech: () => speech?.(),
    fail(value) { failure = value; }, heard(value) { heard = value; }, online(value) { online = value; } };
}
const unavailable = () => Object.assign(Error('Synthetic speech service unavailable'), { status: 503 });

test('capture recovery rearms wake, preserves session and exposes a French actionable state', async () => {
  const h = harness(); await h.c.start({ language: 'fr', wakeWord: true }); const session = h.c.session;
  h.c.wake.extend(); h.recovery({ state: 'waiting-silence' });
  assert.equal(h.c.state, 'recovering'); assert.equal(h.c.session, session); assert.equal(h.c.wake.active(), false);
  assert.match(h.phases.at(-1)[1], /silence/i);
  h.recovery({ state: 'ready' }); assert.equal(h.c.state, 'listening'); assert.equal(h.counts.opens, 1);
  assert.equal(h.counts.sessions, 1); h.c.stop(true); h.recovery({ state: 'ready' });
  assert.equal(h.c.state, 'paused'); assert.equal(h.counts.opens, 1);
});

test('a transient recognition failure resumes fresh listening without replaying audio or creating a session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr', wakeWord: true });
  const session = h.c.session; h.fail(unavailable()); await h.say();
  assert.equal(h.c.state, 'recovering'); assert.match(h.phases.at(-1)[1], /reconnaissance|connexion/i);
  t.mock.timers.tick(2000); await tick();
  assert.equal(h.c.state, 'listening'); assert.equal(h.c.session, session); assert.equal(h.c.wake.active(), false);
  assert.equal(h.counts.recognitions, 1); assert.equal(h.counts.turns, 0); assert.equal(h.counts.opens, 1);
  h.fail(null); await h.say(); assert.equal(h.counts.turns, 1); assert.equal(h.counts.sessions, 1);
});

test('offline recovery waits without collecting new audio and resumes after reconnect on the same stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr', wakeWord: true });
  h.online(false); h.fail(unavailable()); await h.say(); const listens = h.counts.listens;
  t.mock.timers.tick(30000); await tick();
  assert.equal(h.c.state, 'recovering'); assert.equal(h.counts.listens, listens); assert.equal(h.counts.recognitions, 1);
  const checks = h.counts.availabilityChecks; t.mock.timers.tick(24*60*60*1000); await tick();
  assert.equal(h.counts.availabilityChecks, checks, 'offline waiting has no polling or retry loop');
  h.online(true); h.c.retryRecognition();
  assert.equal(h.c.state, 'listening'); assert.equal(h.counts.opens, 1); assert.equal(h.counts.recognitions, 1);
});

test('Pause cancels a queued recognition recovery and cannot be undone by late reconnect callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr', wakeWord: true });
  h.fail(unavailable()); await h.say(); h.c.stop(true);
  const listens = h.counts.listens; t.mock.timers.tick(60000); await tick(); h.c.retryRecognition();
  assert.equal(h.c.state, 'paused'); assert.equal(h.counts.listens, listens); assert.equal(h.counts.opens, 1);
});

test('repeated service failures stop bounded automatic recovery and retain explicit replay/resume controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr' }); h.fail(unavailable());
  for (let i = 0; i < 2; i++) { await h.say(); t.mock.timers.tick(2000); await tick(); assert.equal(h.c.state, 'listening'); }
  await h.say(); assert.equal(h.c.state, 'reviewing'); assert.match(h.phases.at(-1)[1], /reconnaissance|micro/i);
  const listens = h.counts.listens; t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.listens, listens);
  assert.equal(h.counts.recognitions, 3); assert.equal(h.counts.turns, 0);
});

test('a permission refusal or a response failure is never automatically retried as a new request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ turn: async () => { h.counts.turns++; throw unavailable(); } });
  t.after(() => h.c.stop()); await h.c.start({ language: 'fr' }); const session = h.c.session;
  await h.say(); assert.equal(h.c.state, 'error'); assert.equal(h.c.session, session);
  t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.turns, 1); assert.equal(h.counts.opens, 1);
  await h.c.start({ language: 'fr' }); assert.equal(h.counts.sessions, 1); assert.equal(h.counts.turns, 1);
  h.fail(Object.assign(Error('Synthetic forbidden'), { status: 403 })); await h.say();
  assert.equal(h.c.state, 'reviewing'); const listens = h.counts.listens;
  t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.listens, listens);
});

test('typing during recovery cancels its timer rather than reopening the microphone during the response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr' });
  h.fail(unavailable()); await h.say(); assert.equal(h.c.canType(), true);
  assert.equal(await h.c.typed('Synthetic typed request'), true); const listens = h.counts.listens;
  t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.turns, 1); assert.equal(h.counts.listens, listens);
});


test('twenty minutes of continuous synthetic input retains only bounded silence-gate counters', () => {
  const rate=48000, gate=new capture.SilenceGate(rate,1000,.015), noise=new Float32Array(1024).fill(.03);
  for(let i=0;i<Math.ceil(rate*1200/noise.length);i++) assert.equal(gate.push(noise),false);
  assert.ok(Object.values(gate).every(value=>typeof value==='number'),'the gate retains no audio array');
  const quiet=new Float32Array(4800);
  for(let i=0;i<5;i++) assert.equal(gate.push(quiet),false);
  gate.push(noise);
  for(let i=0;i<9;i++) assert.equal(gate.push(quiet),false,'quiet intervals cannot accumulate across another sound');
  assert.equal(gate.push(quiet),true);
  assert.equal(gate.push(new Float32Array([NaN])),false,'invalid samples do not count as real silence');
});

test('explicit Pause and explicit Start have an intent hook; automatic resume and suspension do not rewrite consent', async () => {
  const intent=[], h=harness({microphoneIntent:wanted=>intent.push(wanted)});
  await h.c.start({language:'fr'},{automatic:true}); assert.deepEqual(intent,[]);
  const session=h.c.session; h.c.pause(); assert.deepEqual(intent,[false]);
  assert.equal(h.c.state,'paused'); assert.equal(h.c.session,session);
  await h.c.start({language:'fr'}); assert.deepEqual(intent,[false,true]);
  h.c.stop(true); assert.deepEqual(intent,[false,true],'programmatic suspension is not a user preference change');
  h.c.stop();
});

test('late callbacks from an abandoned recovery cannot affect a newly resumed session', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness(); t.after(()=>h.c.stop()); await h.c.start({language:'fr',wakeWord:true});
  const oldCapture=h.options().onCaptureRecovery; h.fail(unavailable()); await h.say();
  const oldResume=h.c.recovery.pending.resume, session=h.c.session;
  h.c.pause(); await h.c.start({language:'fr',wakeWord:true});
  const listens=h.counts.listens; oldCapture({state:'ready'}); oldResume(); t.mock.timers.tick(60000);await tick();
  assert.equal(h.c.state,'listening'); assert.equal(h.c.session,session); assert.equal(h.counts.listens,listens);
  assert.equal(h.counts.recognitions,1); assert.equal(h.counts.turns,0); assert.equal(h.counts.opens,2);
});

test('an unmounted surface cancels recovery instead of reopening its microphone', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness({canResumeRecognition:()=>null});t.after(()=>h.c.stop());
  await h.c.start({language:'fr'});h.fail(unavailable());await h.say();
  t.mock.timers.tick(2000);await tick();assert.equal(h.c.state,'paused');assert.equal(h.counts.opens,1);
});

test('capture overflow over a reply preserves that reply and waits for silence before starting the next capture', async () => {
  let finish, interrupted=0;
  const h=harness({turn:async()=>({text:'Une réponse synthétique.'}),synthesize:async()=>new ArrayBuffer(1),interrupt:async()=>{interrupted++;}});
  h.audio.canInterrupt=true;h.audio.holdPlayback=()=>{};h.audio.resumePlayback=()=>{};
  h.audio.play=()=>new Promise(resolve=>{finish=resolve;});
  try {
    await h.c.start({language:'fr',interruption:true}); const exchange=h.say();await tick();
    assert.equal(h.c.state,'speaking');const turn=h.c.activeTurn;h.beginSpeech();h.recovery({state:'waiting-silence'});
    assert.equal(turn.request.signal.aborted,false);assert.equal(turn.speech.signal.aborted,false);assert.equal(interrupted,0);
    finish();await exchange;assert.equal(h.c.state,'recovering');const listens=h.counts.listens;
    h.recovery({state:'ready'});assert.equal(h.c.state,'listening');assert.equal(h.counts.listens,listens+1);
  } finally { finish?.();h.c.stop(); }
});


test('typing does not bypass the silence requirement after capture overflow', async () => {
  const h=harness();try{
    await h.c.start({language:'fr'});h.recovery({state:'waiting-silence'});
    assert.equal(await h.c.typed('Synthetic typed request'),true);
    assert.equal(h.c.state,'recovering');assert.equal(h.c.recovery.captureWaiting,true);
    h.recovery({state:'ready'});assert.equal(h.c.state,'listening');assert.equal(h.counts.turns,1);
  }finally{h.c.stop();}
});

test('Pause still closes the microphone if saving the preference throws', async () => {
  const h=harness({microphoneIntent:wanted=>{if(!wanted)throw Error('Synthetic storage refusal');}});
  await h.c.start({language:'fr'});
  assert.throws(()=>h.c.pause(),/storage refusal/);assert.equal(h.c.state,'paused');assert.equal(h.counts.closes,1);
  h.c.stop();
});

test('a failed recovery availability check becomes a visible stopped state, not a timer exception', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const h=harness({canResumeRecognition:()=>{throw Error('Synthetic unavailable view');}});
  t.after(()=>h.c.stop());await h.c.start({language:'fr'});h.fail(unavailable());await h.say();
  t.mock.timers.tick(2000);await tick();assert.equal(h.c.state,'error');assert.equal(h.counts.opens,1);
});


test('Pause rejects both a late successful recognition and a late network failure without resuming or submitting', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for (const success of [false,true]) {
    let finish;const intent=[];
    const h=harness({microphoneIntent:wanted=>intent.push(wanted),transcribe:()=>{
      h.counts.recognitions++;return new Promise((resolve,reject)=>{finish=success?resolve:reject;});
    }});
    try {
      await h.c.start({language:'fr',wakeWord:true});const exchange=h.say();await tick();
      assert.equal(typeof finish,'function');h.c.pause();const listens=h.counts.listens;
      finish(success?'Hey Nestor, question synthétique':unavailable());await exchange;
      for(let i=0;i<10;i++)h.c.retryRecognition();t.mock.timers.tick(60000);await tick();
      assert.equal(h.c.state,'paused');assert.equal(h.counts.listens,listens);assert.equal(h.counts.opens,1);
      assert.equal(h.counts.turns,0);assert.equal(h.counts.recognitions,1);assert.deepEqual(intent,[true,false]);
    }finally{h.c.stop();}
  }
});

test('repeated reconnect events cannot duplicate a resume or bypass the two-recovery budget', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const h=harness();t.after(()=>h.c.stop());
  await h.c.start({language:'fr'});h.fail(unavailable());
  for(let failure=0;failure<2;failure++){
    h.online(false);await h.say();const listens=h.counts.listens;
    for(let i=0;i<10;i++)h.c.retryRecognition();t.mock.timers.tick(60000);await tick();
    assert.equal(h.counts.listens,listens);h.online(true);
    for(let i=0;i<10;i++)h.c.retryRecognition();
    assert.equal(h.counts.listens,listens+1);assert.equal(h.c.state,'listening');
  }
  await h.say();assert.equal(h.c.state,'reviewing');const listens=h.counts.listens;
  for(let i=0;i<10;i++)h.c.retryRecognition();t.mock.timers.tick(60000);await tick();
  assert.equal(h.counts.listens,listens);assert.equal(h.counts.recognitions,3);assert.equal(h.counts.opens,1);assert.equal(h.counts.turns,0);
});
