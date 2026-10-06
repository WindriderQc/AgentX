'use strict';

const CURRENT_PROXY_ROUTES = Object.freeze([
  'GET /api/voix/contract',
  'GET /api/voix/health',
  'GET /api/voix/models',
  'GET /api/voix/config',
  'GET /api/voix/settings',
  'GET /api/voix/sessions/status',
  'GET /api/voix/sessions/:sessionId/events',
  'GET /api/voix/media-vault/status',
  'GET /api/voix/media-vault/clips',
  'POST /api/voix/media-vault/clips',
  'GET /api/voix/media-vault/clips/:clipId/audio',
  'DELETE /api/voix/media-vault/clips/:clipId',
  'POST /api/voix/config/conversation-mode',
  'POST /api/voix/config/personality',
  'POST /api/voix/config/tts',
  'POST /api/voix/sessions/start',
  'POST /api/voix/sessions/stop',
  'POST /api/voix/sessions/cancel',
  'POST /api/voix/transcribe',
  'POST /api/voix/warm',
  'POST /api/voix/synthesize'
]);

const TARGET_ROUTES = Object.freeze([
  'GET /voice/health',
  'GET /voice/devices',
  'POST /voice/devices/verify',
  'POST /voice/sessions',
  'POST /voice/sessions/:id/ptt/start',
  'POST /voice/sessions/:id/ptt/stop',
  'POST /voice/sessions/:id/transcribe',
  'POST /voice/sessions/:id/speak',
  'POST /voice/sessions/:id/cancel',
  'GET /voice/sessions/:id/events'
]);

const MACHINE_CONSUMER_ROUTES = Object.freeze([
  'POST /api/consumers/nestor/v1/household-family/sessions',
  'POST /api/consumers/nestor/v1/household-family/sessions/:sessionId/turns/text'
]);

const EVENT_TYPES = Object.freeze([
  'session_created',
  'capture_started',
  'audio_captured',
  'wake_waiting',
  'wake_ignored',
  'stt_started',
  'stt_completed',
  'llm_started',
  'llm_completed',
  'tts_started',
  'tts_completed',
  'playback_started',
  'playback_completed',
  'interrupted',
  'session_error'
]);

function voiceContract({ timeoutMs = 10000, longTimeoutMs = 120000, soundStatus = null } = {}) {
  const availableSounds = Math.max(0, Number(soundStatus?.available) || 0);
  const catalogSounds = Math.max(0, Number(soundStatus?.catalog) || 0);
  const missingSounds = Array.isArray(soundStatus?.missing)
    ? soundStatus.missing.map((id) => String(id || '')).filter(Boolean).slice(0, 100)
    : [];
  const soundsAvailable = soundStatus?.status === 'ready' && availableSounds > 0;
  return {
    version: 'agentx-voice-v1',
    source: 'agentx-household',
    readOnly: false,
    control: {
      mode: 'explicit-operator-actions',
      automaticMicrophoneActivation: false,
      actions: ['select-conversation-mode', 'select-personality', 'start-session', 'stop-session', 'interrupt-turn']
    },
    authority: {
      householdExtension: 'same-origin browser bridge, household persona policy, and parent-visible audit',
      voixNative: 'private Windows STT/TTS peer and physical audio runtime',
      surfaceSatellite: 'future browser-kiosk mic-state and hard-mute integration; VoiX owns the current native wake gate'
    },
    runtime: {
      binding: 'fixed-private-peer',
      transport: 'same-origin',
      timeoutMs: Math.max(1000, Number(timeoutMs) || 10000),
      longTimeoutMs: Math.max(5000, Number(longTimeoutMs) || 120000),
      healthRoute: '/api/voix/health'
    },
    privacy: {
      rawAudioPersisted: false,
      audioRetention: 'ephemeral-memory-only',
      optInMediaVault: 'explicit-opt-in-encrypted-local',
      mediaVaultFeedsMemoryOrRag: false,
      continuousListening: true,
      browserSessionListensBetweenRepliesUntilStopped: true,
      browserPausesWhenHidden: true,
      nativeSessionListensUntilExplicitlyStopped: true,
      childFacingAudit: 'bounded transcript, reply, safety, route, model, host, and timing evidence in the Household parent audit without raw or rendered audio',
      policy: 'household-sovereignty-and-owner-control'
    },
    capabilities: {
      browserConversation: {
        status: 'available', route: '/voice', captureOwner: 'visiting-browser',
        personaCatalogRoute: '/api/voice-personas/catalog',
        secureContextRequired: true, explicitStartRequired: false,
        initialPermissionAndAudioActivationRequired: true,
        automaticStart: 'when-permission-and-browser-audio-policy-allow',
        spaceRoutes: { personal: '/dad', family: '/panel' },
        listeningPreference: { scope: 'space-on-this-browser', defaults: { personal: 'open', family: 'wake' }, options: ['wake', 'open'] },
        browserWake: { detection: 'local-transcript-prefix', followupSeconds: 30, phrases: ['Hey Nestor', 'Eille Nestor'], agentReceivesAmbientSpeechInWakeMode: false },
        streamingReplies: true, automaticReturnToListening: true,
        acousticInterruption: false
      },
      pushToTalk: {
        status: 'available',
        captureOwner: 'browser',
        secureContextRequired: true,
        explicitUserGestureRequired: true
      },
      stt: {
        status: 'configured',
        route: '/api/voix/transcribe',
        processing: 'private-voix-peer'
      },
      tts: {
        status: 'configured',
        route: '/api/voix/synthesize',
        browserFallback: true,
        languageMode: 'one-language-per-turn-quebec-french-default',
        supportedLanguages: ['en', 'fr'],
        profiles: {
          en: { locale: 'en-CA', nativeLanguage: 'en-us', nativeVoice: 'af_heart' },
          fr: { locale: 'fr-CA', nativeLanguage: 'fr-fr', nativeVoice: 'ff_siwis' }
        }
      },
      nativeSessions: {
        status: 'operator_controlled',
        controlOwner: 'household-cockpit-and-voix-native-console',
        statusRoute: '/api/voix/sessions/status',
        eventsRoute: '/api/voix/sessions/:sessionId/events',
        startRoute: '/api/voix/sessions/start',
        stopRoute: '/api/voix/sessions/stop',
        cancelRoute: '/api/voix/sessions/cancel',
        conversationModeRoute: '/api/voix/config/conversation-mode',
        personalityRoute: '/api/voix/config/personality',
        reason: 'The guarded household cockpit and private VoiX console expose explicit session controls; neither starts the microphone automatically.'
      },
      conversationModes: {
        status: 'operator_controlled',
        default: 'family',
        family: {
          packId: 'kidx_nestor',
          scopeId: 'family',
          memoryOwner: 'household-family',
          toolsEnabled: false,
          activation: 'default-safe'
        },
        dad: {
          packId: 'personal_operator',
          scopeId: 'personal',
          memoryOwner: 'voix-personal',
          toolsEnabled: false,
          activation: 'explicit-operator-selection'
        },
        transition: 'stop-select-start',
        speakerIdentity: 'local-enrollment-required',
        wakeWordAuthorizesDad: false,
        recognizedOwnerMaySelectDad: false,
        antiReplayRequired: true,
        reason: 'Family remains the default for every speaker. Voice recognition may suggest a label after qualification, but Dad always requires the owner to select and activate it explicitly.'
      },
      sounds: {
        status: soundsAvailable ? 'available' : 'unavailable',
        available: availableSounds,
        catalog: catalogSounds,
        missing: missingSounds,
        owner: 'agentx-household',
        packs: ['kidx_nestor', 'kidx_reader'],
        selection: 'deterministic-server-side-allowlist',
        modelSelectsClip: false,
        catalogRoute: '/api/voice-personas/sounds',
        assetPath: '/assets/household/sounds',
        playback: 'browser-surface-attempts-after-spoken-reply',
        nativeVoixPlayback: false,
        playsOnSafetyEscalation: false,
        auditField: 'soundId',
        auditMeaning: 'clip-selected-for-browser-offer-not-playback-receipt',
        reason: 'A child asking in a household browser surface what an animal sounds like gets the spoken answer and a browser-offered catalog sound when available. Recordings, human imitations and imagined effects are identified by kind and introduced accordingly. The clip is chosen by a bounded catalog match on the child utterance, never by the model. Native VoiX turns do not advertise a clip because VoiX does not consume this browser playback contract. The parent audit records which clip was offered; it does not claim the browser successfully played or the child heard it.'
      },
      vad: {
        status: 'available',
        owner: 'voix-native',
        processing: 'local-before-wake-gate'
      },
      wakeWord: {
        status: 'available',
        owner: 'voix-native',
        engineDecision: 'local-whisper-prefix-gate',
        futureOptimization: 'qualified-custom-openWakeWord',
        activation: 'explicit-native-session-start',
        reason: 'An armed native session keeps room speech inside local VAD and Whisper until an address prefix opens the bounded follow-up window. Family retains only aggregate event and classification evidence when no AgentX turn or TTS is launched.'
      },
      sovereignArchive: {
        status: 'configured',
        owner: 'voix-native',
        retention: 'mode-scoped-local',
        familyRetention: 'aggregate-only',
        dadRetention: 'text-only-local-append-only',
        audioRetention: 'ephemeral-memory-only',
        includes: ['aggregate session and safety events', 'Dad transcripts and replies when enabled', 'memory events'],
        excludes: ['microphone audio', 'rendered TTS audio', 'Family transcripts', 'Family replies'],
        futureCameraEvidence: 'not-captured'
      },
      mediaVault: {
        status: 'available',
        owner: 'voix-native',
        processing: 'local-windows-dpapi-current-user',
        capture: 'one accepted utterance in RAM for a bounded save window',
        persistence: 'explicit-opt-in-only',
        passiveCapture: false,
        continuousRecording: false,
        feedsMemory: false,
        feedsRag: false,
        authorizesIdentity: false,
        emotionAuthority: 'none',
        childGate: 'guardian-approval-required',
        routes: {
          status: '/api/voix/media-vault/status',
          clips: '/api/voix/media-vault/clips'
        }
      },
      speakerRecognition: {
        status: 'enrollment_evidence_ready',
        matcherStatus: 'not_installed',
        owner: 'voix-native',
        processing: 'local',
        authority: 'non-authoritative hint only; never selects Dad or unlocks tools'
      },
      physicalAudioLoop: {
        status: 'external',
        owner: 'voix-native-or-surface-satellite'
      }
    },
    routes: {
      currentHouseholdProxy: [...CURRENT_PROXY_ROUTES],
      nativeFamilyConsumer: [...MACHINE_CONSUMER_ROUTES],
      agentxVoiceV1Target: [...TARGET_ROUTES]
    },
    eventTypes: [...EVENT_TYPES],
    migration: {
      pushToTalkDefault: true,
      compatibility: 'Current clients keep using /api/voix/* until a native satellite implements the target session contract.',
      wakeWordGate: [
        'local-first engine',
        'visible mic-active state',
        'hard mute or obvious software pause',
        'false-positive handling',
        'parent-visible child audit',
        'native runtime capability evidence'
      ]
    }
  };
}

module.exports = { CURRENT_PROXY_ROUTES, EVENT_TYPES, MACHINE_CONSUMER_ROUTES, TARGET_ROUTES, voiceContract };
