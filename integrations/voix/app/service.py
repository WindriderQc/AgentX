"""Speech service: local transcription and synthesis for AgentX Core.

The service only turns audio into text and text into audio. It owns no
conversation, memory, microphone or speaker: spoken conversation runs in the
Household page, and Core owns the turn. Requests are stateless apart from the
speech choices (engine and voices) an operator may save through /config.
"""
from __future__ import annotations

import asyncio
import io
import logging
import time
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.datastructures import UploadFile

from app import warmup
from app.audio_upload import audio_form
from app.config import settings
from app.runtime import RuntimeConfig, static_settings
from app.tts import preferences as speech_preferences
from app.tts import provider as tts

VERSION = "3.0.0"
WEB_DIR = Path(__file__).parent / "web"
TTS_RESPONSE_FORMATS = {
    "wav": ("WAV", "audio/wav", None),
    "mp3": ("MP3", "audio/mpeg", None),
    "flac": ("FLAC", "audio/flac", None),
    "ogg": ("OGG", "audio/ogg", "VORBIS"),
    "opus": ("OGG", "audio/ogg", "OPUS"),
}
_LOG = logging.getLogger(__name__)

# The live speech choices, and the reason saved ones could not be read (if any).
speech = RuntimeConfig.from_settings()
speech_preferences_error = speech_preferences.load(speech)
_warmup_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _warmup_task
    if settings.voix_startup_warmup:
        _warmup_task = asyncio.create_task(warmup.run(speech.tts_provider))
    else:
        warmup.mark("disabled")
    try:
        yield
    finally:
        if _warmup_task is not None and not _warmup_task.done():
            _warmup_task.cancel()
        _warmup_task = None


app = FastAPI(title="VoiX", version=VERSION, lifespan=lifespan)


# ======================= health / discovery =======================

@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "version": VERSION,
        # No native conversation exists in this service. Callers written for the
        # earlier service read this flag, so it stays, always false.
        "running": False,
        "warmup": warmup.snapshot(),
    }


@app.get("/api/health")
def api_health() -> dict:
    return health()


@app.get("/version")
def version() -> dict:
    return {"version": VERSION}


@app.get("/v1/models")
def models() -> dict:
    return {
        "object": "list",
        "data": [{
            "id": settings.whisper_model,
            "object": "model",
            "owned_by": "voix",
            "type": "whisper",
            "device": settings.whisper_device,
            "compute_type": settings.whisper_compute_type,
            "language": settings.voix_language,
        }],
        "default": settings.whisper_model,
    }


@app.get("/api/voices")
async def voice_catalog() -> dict:
    from app.tts.catalog import catalog

    return await asyncio.to_thread(catalog)


@app.get("/assets/voice-audio.js")
def voice_audio_script() -> FileResponse:
    return FileResponse(WEB_DIR / "voice-audio.js", media_type="application/javascript")


# ======================= speech settings =======================

def update_config(data: dict) -> list[str]:
    """Validate the whole edit, save it when asked, then apply it."""
    candidate = speech.snapshot()
    candidate.update(data)
    if data.get("persist"):
        speech_preferences.save(candidate)
    return speech.update(data)


@app.get("/config")
def get_config() -> dict:
    return {
        "config": speech.to_dict(),
        "static": static_settings(),
        "running": False,
        "speech_preferences": {"fields": list(speech_preferences.FIELDS),
                               "error": speech_preferences_error},
        "restart_note": "Models require a restart. Speech choices can be saved across restarts.",
    }


@app.post("/config")
async def post_config(request: Request) -> Response:
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "A JSON object is required"}, status_code=400)
    data = body if isinstance(body, dict) else {}
    try:
        changed = update_config(data)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except OSError:
        return JSONResponse({"error": "Speech preferences could not be saved"}, status_code=503)
    return JSONResponse({"changed": changed, "config": speech.to_dict(),
                         "speech_preferences_saved": bool(data.get("persist")),
                         "applies": "immediately"})


# ======================= recognition =======================

@app.post("/v1/audio/transcriptions")
async def transcriptions(request: Request) -> Response:
    async with audio_form(request) as form:
        file = form.get("file")
        if not isinstance(file, UploadFile):
            return JSONResponse({"error": "audio file is required"}, status_code=422)
        filename = file.filename
        raw = await file.read()
        model, language, response_format = (
            str(form.get(key) or "") for key in ("model", "language", "response_format"))
    if not raw:
        return JSONResponse({"error": "empty audio"}, status_code=400)
    # Uploaded audio belongs to its caller: an omitted language means automatic
    # detection, not the service default. Household sends fr-en for its
    # bilingual selector.
    selected_language = language or "auto"
    loop = asyncio.get_running_loop()
    text, ms = await loop.run_in_executor(None, _transcribe_bytes, raw, filename, selected_language)
    # Operational timing has no transcript, filename or audio content.
    _LOG.info("Audio upload transcribed: bytes=%d stt_ms=%d", len(raw), round(ms))
    if str(response_format or "json").strip().lower() == "text":
        return Response(content=text, media_type="text/plain; charset=utf-8")
    return JSONResponse({
        "text": text,
        "language": selected_language,
        # Whisper's own decision lets the caller keep one voice for the reply.
        "detectedLanguage": getattr(text, "language", "") or None,
        "model": model or settings.whisper_model,
        "sttMs": round(ms),
    })


@app.post("/api/preload-stt")
async def preload_stt() -> dict:
    from app.stt import whisper as stt

    info = await asyncio.get_running_loop().run_in_executor(None, stt.preload_model)
    return {"ok": True, **info}


@app.post("/api/stt/warm")
async def warm_stt() -> dict:
    """Run the recognition model once for a caller that knows an utterance is coming."""
    from app.stt import whisper as stt

    warm_ms = await asyncio.get_running_loop().run_in_executor(None, stt.warm)
    if warm_ms is None:
        return {"warmed": False}
    # Operational timing only: the run decodes silence and its text is discarded.
    _LOG.info("STT warmed: warm_ms=%d", round(warm_ms))
    return {"warmed": True, "warmMs": round(warm_ms)}


# ======================= synthesis =======================

async def speech_request_profile(body: dict) -> dict:
    """Resolve the engine, language and voice of one request.

    A request names its own engine, language and voice. With ``native_defaults``
    it asks for the service's saved choices instead: the default language, and
    the voice saved for that language on the selected engine.
    """
    selected = tts.provider_name(body.get("tts_provider") or speech.tts_provider)
    language, voice = body.get("language"), body.get("voice")
    if body.get("native_defaults"):
        language = language or speech.language
        if not voice and selected == speech.tts_provider:
            voice = getattr(speech, "tts_voice_" + language[:2], "")
    return await asyncio.to_thread(tts.resolve, selected, language=language, voice=voice)


async def _resolved_profile(body: dict) -> dict | JSONResponse:
    try:
        return await speech_request_profile(body)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except tts.VoiceUnavailable as exc:
        # The caller chooses another voice; the service never substitutes one.
        return JSONResponse({"error": str(exc)}, status_code=503)


async def _synthesized_file(body: dict, text: str, response_format: str) -> Response:
    """One complete audio file, with the applied engine, voice and language in headers."""
    from app.tts.transport import headers

    invalid = _audio_format_error(response_format)
    if invalid is not None:
        return invalid
    profile = await _resolved_profile(body)
    if isinstance(profile, JSONResponse):
        return profile
    synthesis = partial(tts.synthesize, text, profile["provider"],
                        language=profile.get("language"), voice=profile.get("voice"))
    samples, sample_rate, _ = await asyncio.get_running_loop().run_in_executor(None, synthesis)
    response = _audio_response(samples, sample_rate, response_format)
    response.headers.update(headers(profile))
    return response


@app.post("/api/tts")
async def api_tts(request: Request) -> Response:
    body = await _read_request_data(request)
    text = str(body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    return await _synthesized_file(body, text, body.get("response_format", "wav"))


@app.post("/v1/audio/speech")
async def openai_speech(request: Request) -> Response:
    body = await _read_request_data(request)
    text = str(body.get("input") or body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "input is required"}, status_code=400)
    return await _synthesized_file(body, text, body.get("response_format", "mp3"))


@app.post("/api/tts/stream")
async def stream_speech(request: Request) -> Response:
    from app.tts.transport import headers, pcm_events

    body = await _read_request_data(request)
    text = str(body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text is required"}, status_code=400)
    profile = await _resolved_profile(body)
    if isinstance(profile, JSONResponse):
        return profile
    return StreamingResponse(pcm_events(text, profile), media_type="application/x-ndjson",
                             headers=headers(profile))


@app.post("/diagnostics/tts-smoke")
async def diagnostics_tts_smoke(request: Request) -> dict:
    body = await _read_request_data(request)
    text = str(body.get("text") or "Bonjour, ceci est un test de synthese locale.").strip()
    started = time.perf_counter()
    samples, sample_rate, tts_ms = await asyncio.get_running_loop().run_in_executor(
        None, tts.synthesize, text, speech.tts_provider)
    total_ms = (time.perf_counter() - started) * 1000.0
    return {
        "ok": True,
        "provider": tts.provider_name(speech.tts_provider),
        "text": text,
        "chars": len(text),
        "bytes": int(np.asarray(samples).nbytes),
        "sampleRate": sample_rate,
        "timings": {"tts_ms": round(tts_ms), "total_ms": round(total_ms)},
    }


# ======================= helpers =======================

async def _read_request_data(request: Request) -> dict:
    """A JSON object or a form, as a dict; anything else is an empty request."""
    content_type = request.headers.get("content-type", "")
    if "application/x-www-form-urlencoded" in content_type or "multipart/form-data" in content_type:
        return dict(await request.form())
    try:
        body = await request.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return dict(await request.form())


def _audio_format_error(response_format: str) -> JSONResponse | None:
    if str(response_format or "wav").strip().lower() in TTS_RESPONSE_FORMATS:
        return None
    return JSONResponse(
        {"error": f"Unsupported response_format '{response_format}'. "
                  f"Supported: {sorted(TTS_RESPONSE_FORMATS)}"},
        status_code=400,
    )


def _audio_response(samples: np.ndarray, sample_rate: int, response_format: str = "wav") -> Response:
    import soundfile as sf

    format_name, media_type, subtype = TTS_RESPONSE_FORMATS[str(response_format or "wav").strip().lower()]
    buffer = io.BytesIO()
    options = {"format": format_name, **({"subtype": subtype} if subtype else {})}
    sf.write(buffer, samples, sample_rate, **options)
    return Response(content=buffer.getvalue(), media_type=media_type)


def _transcribe_bytes(raw: bytes, filename: str | None, language: str | None) -> tuple[str, float]:
    """Decode and transcribe an upload in memory; it never reaches the disk."""
    from app.stt import whisper as stt

    with io.BytesIO(raw) as audio:
        return stt.transcribe_path(audio, language=language)
