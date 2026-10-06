'use strict';
const { matchesVoixMemoryTurn } = require('./voice-memory-turns');

// VoiX HTTP routes of the Household surface: the browser-facing /api/voix
// proxy and the native Nestor voice-memory consumer. Household's register()
// supplies its runtime services and the helpers it shares with other routes.

const crypto = require('crypto');
const personaCatalog = require('./persona-catalog');
const { voiceContract } = require('./voice-contract');
const { createScriptRelay } = require('./asset-relay');
const { getVoiceUpstream } = require('../../src/services/voice/transport');
const { createSynthesisHandler } = require('../../src/services/voice/voix-synthesis');
const {
  VOIX_TIMEOUT_MS, VOIX_MEDIA_VAULT_CATEGORIES, VOIX_MEDIA_VAULT_SUBJECTS, fetchWithTimeout, voixUrl, upstreamJson, readUpstreamJson, finiteNumber,
  publicVoixConfig, publicVoixConversation, publicVoixEvent, publicVoixMediaClip, publicVoixMediaVault, publicVoixSession
} = require('./voix-client');

const VOIX_LONG_TIMEOUT_MS = () => Math.max(5000, Number(process.env.VOIX_LONG_TIMEOUT_MS) || 120000);
const VOIX_MEDIA_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const VOIX_MEMORY_PACK_ID = 'personal_operator';
const VOIX_MEMORY_MODE_ID = 'operator';

function registerVoixRoutes(app, {
  express, logger, models, conversations, personalNotes, runtimeServices, sounds, standardJsonParser, ensureCatalog, drainVoixMemoryAudits,
  envelope, fail, cleanText, assessSafety, detectMemoryRequest, normalizeVoixMemoryTurn, normalizeVoixTranscriptionMultipart, requireVoixMemoryConsumer,
  MEMORY_BLOCK_MAX_CHARS, MEMORY_RECALL_LIMIT, VOIX_MEMORY_SCHEMA_VERSION, VOIX_MEMORY_SCOPE_ID,
  voixUpstream = getVoiceUpstream()
}) {
  const voix = express.Router();
  voix.get('/contract', (_req, res) => envelope(res, voiceContract({
    timeoutMs: VOIX_TIMEOUT_MS(),
    longTimeoutMs: VOIX_LONG_TIMEOUT_MS(),
    soundStatus: sounds.status
  })));
  voix.get('/health', async (_req, res) => {
    try { return envelope(res, await upstreamJson('/health')); }
    catch (error) { return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE'); }
  });
  voix.get('/models', async (_req, res) => {
    try { return envelope(res, await upstreamJson('/v1/models')); }
    catch (error) { return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE'); }
  });
  voix.get('/config', async (_req, res) => {
    try { return envelope(res, publicVoixConfig(await upstreamJson('/config'))); }
    catch (error) { return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE'); }
  });
  // Stateless routes below may be answered by VOIX_FALLBACK_URL; see voix-upstream.
  voix.get('/upstream', async (_req, res) => envelope(res, await voixUpstream.status()));
  voix.get('/catalog', async (_req, res) => {
    try {
      const { response, upstream } = await voixUpstream.send('/api/voices', (url) => fetchWithTimeout(url, {}, VOIX_TIMEOUT_MS()));
      res.set('X-Voix-Upstream', upstream);
      return envelope(res, await readUpstreamJson(response));
    } catch (error) { return fail(res, 503, error.message, 'VOIX_UNAVAILABLE'); }
  });
  voix.get('/player.js', createScriptRelay({ resolveUrl: () => voixUrl('/assets/voice-audio.js'), fetchWithTimeout,
    fetchUpstream: (_url, ms) => voixUpstream.send('/assets/voice-audio.js', (url) => fetchWithTimeout(url, {}, ms)),
    unavailable: (res, error) => fail(res, 503, error.message || 'Local speech player is unavailable', 'VOIX_UNAVAILABLE') }));
  voix.get('/settings', (_req, res) => envelope(res, {
    source: 'agentx-household',
    baseUrl: String(process.env.VOIX_BASE_URL || ''),
    timeoutMs: VOIX_TIMEOUT_MS(),
    longTimeoutMs: VOIX_LONG_TIMEOUT_MS(),
    mutable: false
  }));
  voix.get('/sessions/status', async (_req, res) => {
    try { return envelope(res, publicVoixSession(await upstreamJson('/sessions/status'))); }
    catch (error) { return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE'); }
  });
  voix.get('/sessions/snapshot', async (_req, res) => {
    try {
      const session = publicVoixSession(await upstreamJson('/sessions/status'));
      let events = [];
      let eventsStatus = 'not_applicable';
      if (session.sessionId) {
        try {
          const upstreamEvents = await upstreamJson(`/sessions/${encodeURIComponent(session.sessionId)}/events`);
          events = (Array.isArray(upstreamEvents) ? upstreamEvents : [])
            .map(publicVoixEvent)
            .filter(Boolean)
            .slice(-100);
          eventsStatus = 'ok';
        } catch (_error) {
          // A session can stop between the status and event reads. Preserve the
          // authoritative service status rather than misreporting VoiX as down.
          eventsStatus = 'temporarily_unavailable';
        }
      }
      return envelope(res, { session, events, eventsStatus });
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  voix.get('/sessions/:sessionId/events', async (req, res) => {
    const sessionId = cleanText(req.params?.sessionId, 120);
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId)) {
      return fail(res, 400, 'valid sessionId is required', 'VOIX_INVALID_SESSION');
    }
    try {
      const events = await upstreamJson(`/sessions/${encodeURIComponent(sessionId)}/events`);
      return envelope(res, {
        sessionId,
        events: (Array.isArray(events) ? events : []).map(publicVoixEvent).filter(Boolean).slice(-100)
      });
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  const speechRecognition = require('../../src/services/voice/voix-transcription');
  speechRecognition.registerTranscriptionProxy(voix, {
    express, normalizeMultipart: normalizeVoixTranscriptionMultipart, upstream: voixUpstream,
    fetchWithTimeout, timeoutMs: VOIX_LONG_TIMEOUT_MS, fail
  });
  speechRecognition.registerRecognitionWarmProxy(voix, { upstream: voixUpstream, fetchWithTimeout });
  voix.use(standardJsonParser);
  voix.get('/media-vault/status', async (_req, res) => {
    try {
      const status = publicVoixMediaVault(
        await upstreamJson('/media-vault/status'),
        { includeCandidateId: true }
      );
      if (!status.safetyConfirmed) {
        return fail(
          res,
          503,
          'VoiX media vault did not confirm its no-passive-capture safety boundary',
          'VOIX_MEDIA_VAULT_UNSAFE'
        );
      }
      return envelope(res, status);
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  voix.get('/media-vault/clips', async (_req, res) => {
    try {
      const upstream = await upstreamJson('/media-vault/clips');
      const values = Array.isArray(upstream) ? upstream : [];
      const clips = values.map(publicVoixMediaClip).filter(Boolean);
      if (clips.length !== values.length) {
        return fail(
          res,
          503,
          'VoiX returned a media clip outside the non-authoritative evidence contract',
          'VOIX_MEDIA_CLIP_UNSAFE'
        );
      }
      return envelope(res, { clips });
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  voix.post('/media-vault/clips', async (req, res) => {
    const candidateId = cleanText(req.body?.candidateId, 40).toLowerCase();
    const category = cleanText(req.body?.category, 40);
    const subjectKind = cleanText(req.body?.subjectKind, 20);
    if (!/^[a-f0-9]{32}$/.test(candidateId)) {
      return fail(res, 400, 'a current candidateId is required', 'VOIX_MEDIA_CANDIDATE_INVALID');
    }
    if (!VOIX_MEDIA_VAULT_CATEGORIES.includes(category)) {
      return fail(res, 400, 'unsupported media-vault category', 'VOIX_MEDIA_CATEGORY_INVALID');
    }
    if (!VOIX_MEDIA_VAULT_SUBJECTS.includes(subjectKind)) {
      return fail(res, 400, 'subjectKind must be adult, child, or unknown', 'VOIX_MEDIA_SUBJECT_INVALID');
    }
    if (req.body?.consent !== true) {
      return fail(res, 400, 'explicit consent is required', 'VOIX_MEDIA_CONSENT_REQUIRED');
    }
    if (subjectKind === 'child' && req.body?.guardianApproved !== true) {
      return fail(res, 400, 'guardian approval is required for a child sample', 'VOIX_MEDIA_GUARDIAN_REQUIRED');
    }
    if (category === 'emotion-research' && req.body?.researchConsent !== true) {
      return fail(res, 400, 'research consent is required for an emotion sample', 'VOIX_MEDIA_RESEARCH_CONSENT_REQUIRED');
    }
    const speakerLabel = cleanText(req.body?.speakerLabel, 120);
    if (category === 'speaker-enrollment' && (subjectKind === 'unknown' || !speakerLabel)) {
      return fail(
        res,
        400,
        'speaker enrollment requires a user-labelled adult or child',
        'VOIX_MEDIA_SPEAKER_LABEL_REQUIRED'
      );
    }
    const payload = {
      candidateId,
      category,
      subjectKind,
      speakerLabel,
      label: cleanText(req.body?.label, 120),
      consent: true,
      consentSource: 'household-voice-cockpit',
      guardianApproved: subjectKind === 'child',
      researchConsent: category === 'emotion-research'
    };
    try {
      const upstream = await upstreamJson('/media-vault/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const clip = publicVoixMediaClip(upstream?.clip);
      if (!upstream?.saved || !clip) {
        return fail(
          res,
          503,
          'VoiX did not confirm a safe encrypted media clip',
          'VOIX_MEDIA_CLIP_UNCONFIRMED'
        );
      }
      return envelope(res, { saved: true, clip }, 201);
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  voix.get('/media-vault/clips/:clipId/audio', async (req, res) => {
    const clipId = cleanText(req.params?.clipId, 40).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(clipId)) {
      return fail(res, 400, 'valid clipId is required', 'VOIX_MEDIA_CLIP_INVALID');
    }
    try {
      const response = await fetchWithTimeout(
        voixUrl(`/media-vault/clips/${clipId}/audio`),
        {},
        VOIX_LONG_TIMEOUT_MS()
      );
      const advertisedLength = finiteNumber(response.headers?.get?.('content-length'));
      if (advertisedLength !== null && advertisedLength > VOIX_MEDIA_AUDIO_MAX_BYTES) {
        return fail(res, 503, 'VoiX media clip exceeds the bounded review limit', 'VOIX_MEDIA_AUDIO_TOO_LARGE');
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > VOIX_MEDIA_AUDIO_MAX_BYTES) {
        return fail(res, 503, 'VoiX media clip exceeds the bounded review limit', 'VOIX_MEDIA_AUDIO_TOO_LARGE');
      }
      if (!response.ok) {
        return fail(
          res,
          response.status >= 500 ? 503 : response.status,
          'VoiX media review failed',
          'VOIX_BAD_RESPONSE'
        );
      }
      if (buffer.length < 12
        || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
        || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
        return fail(res, 503, 'VoiX did not return a confirmed WAV clip', 'VOIX_MEDIA_AUDIO_UNCONFIRMED');
      }
      res.status(200).set({
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="voix-${clipId}.wav"`
      });
      return res.send(buffer);
    } catch (error) {
      return fail(res, 503, error.message, 'VOIX_UNAVAILABLE');
    }
  });
  voix.delete('/media-vault/clips/:clipId', async (req, res) => {
    const clipId = cleanText(req.params?.clipId, 40).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(clipId)) {
      return fail(res, 400, 'valid clipId is required', 'VOIX_MEDIA_CLIP_INVALID');
    }
    try {
      const upstream = await upstreamJson(`/media-vault/clips/${clipId}`, { method: 'DELETE' });
      if (!upstream?.deleted || cleanText(upstream?.clipId, 40).toLowerCase() !== clipId) {
        return fail(res, 503, 'VoiX did not confirm clip deletion', 'VOIX_MEDIA_DELETE_UNCONFIRMED');
      }
      return envelope(res, { deleted: true, clipId });
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  const ingestVoixMemoryTurn = async (req, res) => {
    let turn;
    try { turn = normalizeVoixMemoryTurn(req.body); }
    catch (error) { return fail(res, error.statusCode || 400, error.message, error.code || 'VOIX_MEMORY_TURN_INVALID'); }
    const traceId = turn.eventId;
    let audit = await conversations.getTurn({ traceId });
    let duplicate = Boolean(audit);
    if (!audit) {
      const safety = assessSafety(turn.userText);
      let resolvedPersona = null;
      if (turn.personaVersion && runtimeServices.personas) {
        try {
          await ensureCatalog();
          resolvedPersona = personaCatalog.snapshot(await runtimeServices.personas.resolve(turn.persona, turn.personaVersion));
        } catch (error) { return fail(res, 503, error.message, 'VOIX_PERSONA_UNAVAILABLE'); }
      }
      try {
        await conversations.ensureSession({
          sessionId: turn.sessionId, packId: VOIX_MEMORY_PACK_ID, modeId: VOIX_MEMORY_MODE_ID,
          scopeId: VOIX_MEMORY_SCOPE_ID, label: `${resolvedPersona?.name || turn.persona} · voice`,
          ...(resolvedPersona ? { persona: resolvedPersona, inference: { open: false } } : {})
        });
        audit = await conversations.recordTurn({
          traceId,
          sessionId: turn.sessionId,
          packId: VOIX_MEMORY_PACK_ID,
          modeId: VOIX_MEMORY_MODE_ID,
          scopeId: VOIX_MEMORY_SCOPE_ID,
          channel: 'voice',
          inputText: turn.userText,
          replyText: turn.assistantText,
          inputSha256: crypto.createHash('sha256').update(turn.userText).digest('hex'),
          replySha256: crypto.createHash('sha256').update(turn.assistantText).digest('hex'),
          safetyFlags: safety.flagIds,
          parentAttention: safety.requiresParentAttention,
          durationMs: Number(turn.metrics.reply_done_ms || 0),
          source: 'voix-native',
          sourceTurnId: turn.turnId,
          sourceCompletedAt: turn.completedAt,
          sequence: turn.sequence,
          persona: turn.persona,
          memoryState: 'captured',
          memoryExplicit: detectMemoryRequest(turn.userText)
        });
      } catch (error) {
        if (Number(error?.code) !== 11000) {
          logger?.error?.('VoiX memory capture failed', { traceId, error: error.message });
          return fail(res, 500, 'Unable to durably capture the completed voice turn', 'VOIX_MEMORY_CAPTURE_FAILED');
        }
        audit = await conversations.getTurn({ traceId });
        duplicate = true;
      }
    }
    if (!matchesVoixMemoryTurn(audit, turn)) {
      return fail(res, 409, 'This native turn identity belongs to different completed content; the original was preserved.', 'VOIX_MEMORY_TURN_CONFLICT');
    }
    setImmediate(() => {
      drainVoixMemoryAudits().catch((error) => logger?.error?.('VoiX memory drain failed', { error: error.message }));
    });
    return envelope(res, {
      schemaVersion: VOIX_MEMORY_SCHEMA_VERSION,
      eventId: traceId,
      duplicate,
      captured: Boolean(audit),
      memoryState: audit?.memoryState || 'captured'
    }, duplicate ? 200 : 201);
  };

  const recallVoixMemoryContext = async (req, res) => {
    try {
      await drainVoixMemoryAudits();
      const limit = Math.max(1, Math.min(Number(req.body?.limit) || 8, 12));
      const { notes: memories } = await personalNotes.list({ limit: MEMORY_RECALL_LIMIT });
      const bounded = [];
      let used = 0;
      for (const row of memories) {
        const text = cleanText(row.text, 400);
        if (!text || used + text.length > MEMORY_BLOCK_MAX_CHARS) continue;
        bounded.push({ id: row.id, topic: row.topic || 'general', text, type: row.type || 'fact', createdAt: row.createdAt });
        used += text.length;
        if (bounded.length >= limit) break;
      }
      return envelope(res, {
        scopeId: VOIX_MEMORY_SCOPE_ID,
        persona: cleanText(req.body?.persona || 'default_chat', 80),
        notes: bounded,
        count: bounded.length,
        policy: { approvedOnly: true, maxCharacters: MEMORY_BLOCK_MAX_CHARS, rawAudioStored: false }
      });
    } catch (error) {
      logger?.error?.('VoiX memory recall failed', { error: error.message });
      return fail(res, 503, 'Voice memory is temporarily unavailable', 'VOIX_MEMORY_RECALL_FAILED');
    }
  };
  voix.post('/memory/turns', requireVoixMemoryConsumer, ingestVoixMemoryTurn);
  voix.post('/memory/context', requireVoixMemoryConsumer, recallVoixMemoryContext);
  const voixMemoryConsumer = express.Router();
  voixMemoryConsumer.use(standardJsonParser);
  voixMemoryConsumer.post('/turns', requireVoixMemoryConsumer, ingestVoixMemoryTurn);
  voixMemoryConsumer.post('/context', requireVoixMemoryConsumer, recallVoixMemoryContext);

  voix.get('/memory/status', async (_req, res) => {
    try {
      await drainVoixMemoryAudits();
      const [captured, processing, failed, proposed, active, latest] = await Promise.all([
        conversations.countTurns({ source: 'voix-native', memoryState: 'captured' }),
        conversations.countTurns({ source: 'voix-native', memoryState: 'processing' }),
        conversations.countTurns({ source: 'voix-native', memoryState: 'failed' }),
        models.MemoryCandidate.countDocuments({ scopeId: VOIX_MEMORY_SCOPE_ID, status: 'proposed' }),
        personalNotes.count(),
        conversations.getTurn({ source: 'voix-native' }, { sort: { sourceCompletedAt: -1 } })
      ]);
      return envelope(res, {
        state: failed ? 'degraded' : (captured || processing ? 'processing' : 'synchronized'),
        captured,
        processing,
        failed,
        proposed,
        activeMemories: active,
        lastTurnAt: latest?.sourceCompletedAt || latest?.createdAt || null,
        lastSequence: Number(latest?.sequence) || 0,
        policy: { perCompletedTurn: true, explicitRequestsApplyPrivately: true, inferredCandidatesRequireReview: true }
      });
    } catch (error) {
      return fail(res, 503, 'Voice memory status is unavailable', 'VOIX_MEMORY_STATUS_FAILED');
    }
  });

  voix.get('/memory/candidates', async (req, res) => {
    try {
      const status = cleanText(req.query?.status || 'proposed', 24);
      const query = { scopeId: VOIX_MEMORY_SCOPE_ID };
      if (['proposed', 'approved', 'rejected', 'applied'].includes(status)) query.status = status;
      const rows = await models.MemoryCandidate.find(query).sort({ createdAt: -1 }).limit(50).lean();
      return envelope(res, {
        candidates: rows.map((row) => ({
          id: row.candidateId,
          type: row.type,
          statement: row.statement,
          rationale: row.rationale,
          confidence: row.confidence,
          status: row.status,
          persona: row.persona,
          sessionId: row.sessionId,
          turnId: row.turnId,
          createdAt: row.createdAt,
          review: row.review || {}
        }))
      });
    } catch (error) {
      return fail(res, 500, error.message, 'VOIX_MEMORY_CANDIDATES_FAILED');
    }
  });

  voix.get('/memory/active', async (_req, res) => {
    try {
      const { notes: rows } = await personalNotes.list({ limit: 50 });
      return envelope(res, {
        memories: rows.map((row) => ({
          id: row.id,
          topic: cleanText(row.topic || 'general', 80),
          text: cleanText(row.text, 500),
          type: cleanText(row.type || 'fact', 40),
          source: cleanText(row.source || 'explicit-ui', 80),
          createdAt: row.createdAt || null
        }))
      });
    } catch (error) {
      return fail(res, 500, error.message, 'VOIX_MEMORY_ACTIVE_FAILED');
    }
  });

  voix.post('/memory/candidates/:candidateId/review', async (req, res) => {
    const candidateId = cleanText(req.params?.candidateId, 64);
    const action = cleanText(req.body?.action, 24);
    if (!/^[a-f0-9]{32}$/.test(candidateId) || !['approve', 'reject'].includes(action)) {
      return fail(res, 400, 'valid candidateId and approve/reject action are required', 'VOIX_MEMORY_REVIEW_INVALID');
    }
    try {
      const candidate = await models.MemoryCandidate.findOne({ candidateId, status: 'proposed' });
      if (!candidate) return fail(res, 404, 'Voice memory candidate not found or already reviewed', 'VOIX_MEMORY_CANDIDATE_NOT_FOUND');
      if (action === 'reject') {
        candidate.status = 'rejected';
        candidate.review = { by: 'operator-ui', at: new Date(), note: cleanText(req.body?.note, 500) };
        await candidate.save();
        return envelope(res, { candidateId, status: 'rejected' });
      }
      const statement = cleanText(req.body?.statement || candidate.statement, 500);
      if (!statement) return fail(res, 400, 'approved statement is required', 'VOIX_MEMORY_REVIEW_INVALID');
      const sourceTraceId = `candidate:${candidateId}`;
      const memory = await personalNotes.record({ topic: candidate.type || 'general',
        text: statement, type: 'fact', source: 'voix-reviewed', sourceTraceId });
      candidate.status = 'applied';
      candidate.statement = statement;
      candidate.memoryId = memory.id;
      candidate.review = { by: 'operator-ui', at: new Date(), note: cleanText(req.body?.note, 500) };
      await candidate.save();
      return envelope(res, { candidateId, status: 'applied', memoryId: candidate.memoryId });
    } catch (error) {
      return fail(res, 500, error.message, 'VOIX_MEMORY_REVIEW_FAILED');
    }
  });

  voix.post('/memory/:memoryId/forget', async (req, res) => {
    const memoryId = cleanText(req.params?.memoryId, 64);
    try {
      const result = await personalNotes.forget(memoryId);
      if (!result.removed) return fail(res, 404, 'Private memory not found', 'VOIX_MEMORY_NOT_FOUND');
      return envelope(res, { memoryId, status: 'forgotten' });
    } catch (error) {
      return fail(res, 400, 'Invalid private memory id', 'VOIX_MEMORY_NOT_FOUND');
    }
  });

  voix.post('/config/personality', async (req, res) => {
    const persona = cleanText(req.body?.persona, 80);
    if (!/^[a-z][a-z0-9_-]{1,79}$/.test(persona)) {
      return fail(res, 400, 'valid persona is required', 'VOIX_INVALID_PERSONA');
    }
    try {
      const current = await upstreamJson('/config');
      const profiles = Array.isArray(current?.static?.nestor_personalities)
        ? current.static.nestor_personalities
        : [];
      if (!profiles.some((profile) => profile?.id === persona)) {
        return fail(res, 400, 'unknown Nestor personality', 'VOIX_INVALID_PERSONA');
      }
      const changed = await upstreamJson('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona })
      });
      return envelope(res, {
        persona,
        applies: changed?.applies || 'next session start',
        config: changed?.config ? { persona: cleanText(changed.config.persona, 80) } : { persona }
      });
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  voix.post('/config/tts', async (req, res) => {
    const provider = cleanText(req.body?.tts_provider, 40);
    if (!['kokoro', 'windows_sapi', 'voxcpm'].includes(provider)) {
      return fail(res, 400, 'unknown voice provider', 'VOIX_INVALID_TTS_PROVIDER');
    }
    try {
      const changed = await upstreamJson('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tts_provider: provider,
          ...(req.body?.tts_voice_en !== undefined ? { tts_voice_en: cleanText(req.body.tts_voice_en, 120) } : {}),
          ...(req.body?.tts_voice_fr !== undefined ? { tts_voice_fr: cleanText(req.body.tts_voice_fr, 120) } : {}),
          ...(req.body?.persist === true ? { persist: true } : {}) })
      });
      if (changed?.config?.tts_provider !== provider) {
        return fail(res, 503, 'Native VoiX did not confirm the selected voice', 'VOIX_TTS_UNCONFIRMED');
      }
      return envelope(res, {
        tts_provider: provider,
        tts_voice_en: changed.config.tts_voice_en || '', tts_voice_fr: changed.config.tts_voice_fr || '',
        saved: changed.speech_preferences_saved === true,
        applies: cleanText(changed.applies, 80) || 'next session start'
      });
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  voix.post('/config/conversation-mode', async (req, res) => {
    const mode = cleanText(req.body?.mode, 16);
    if (!['family', 'dad'].includes(mode)) {
      return fail(res, 400, 'mode must be family or dad', 'VOIX_INVALID_CONVERSATION_MODE');
    }
    try {
      const status = await upstreamJson('/sessions/status');
      if (status?.running) {
        return fail(
          res,
          409,
          'Stop the current voice session before changing Family or Dad mode',
          'VOIX_CONVERSATION_MODE_REQUIRES_STOP'
        );
      }
      const changed = await upstreamJson('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_mode: mode })
      });
      const confirmed = cleanText(changed?.config?.conversation_mode, 16);
      if (confirmed !== mode) {
        return fail(
          res,
          503,
          'Native VoiX did not confirm the requested conversation boundary',
          'VOIX_CONVERSATION_MODE_UNCONFIRMED'
        );
      }
      return envelope(res, {
        mode,
        applies: cleanText(changed?.applies, 80) || 'next session start',
        config: { conversation_mode: mode },
        policy: publicVoixConversation({ mode })
      });
    } catch (error) {
      return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
    }
  });
  for (const action of ['start', 'stop', 'cancel']) {
    voix.post(`/sessions/${action}`, async (_req, res) => {
      try {
        const status = await upstreamJson(`/sessions/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        }, VOIX_LONG_TIMEOUT_MS());
        return envelope(res, publicVoixSession(status));
      } catch (error) {
        return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE');
      }
    });
  }
  const synthesizeSpeech = createSynthesisHandler({ upstream: voixUpstream, timeoutMs: VOIX_LONG_TIMEOUT_MS, fail, cleanText });
  voix.post('/synthesize', synthesizeSpeech);
  voix.post('/synthesize/stream', synthesizeSpeech);
  app.use('/api/voix', voix);
  app.use('/api/consumers/nestor/v1/voice-memory', voixMemoryConsumer);
}

module.exports = { registerVoixRoutes };
