"""Optional adapter on the existing VoiX process, configured by the instance."""
import asyncio
import os
import time

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile
from vosk import KaldiRecognizer, Model, SetLogLevel

from app.service import app, audio_form, settings, _transcribe_bytes
from voice_control import VoiceControl

model_dir = os.environ.get("VOIX_CONTROL_MODEL_DIR", "").strip()
if not model_dir:
    raise RuntimeError("VOIX_CONTROL_MODEL_DIR is required for the voice-control adapter")
SetLogLevel(-1)
control = VoiceControl(Model(model_dir), KaldiRecognizer)


@app.get("/api/voice-controls/status")
async def status():
    return {"ready": True, "recognizer": "vosk", "controls": ["stop"], "audioStored": False}


@app.post("/v1/audio/transcriptions/controls")
async def transcriptions_with_controls(request: Request):
    async with audio_form(request) as form:
        file = form.get("file")
        if not isinstance(file, UploadFile):
            return JSONResponse({"error": "audio file is required"}, status_code=422)
        filename = file.filename
        raw = await file.read()
        model, language, response_format = (str(form.get(key) or "")
                                            for key in ("model", "language", "response_format"))
    if not raw:
        return JSONResponse({"error": "empty audio"}, status_code=400)
    language = language or "auto"
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    command = await loop.run_in_executor(None, control.classify, raw)
    control_ms = round((time.perf_counter() - started) * 1000)
    if command:
        # This structured control cannot become a user request or a spoken
        # acknowledgement. Do not ask general-purpose STT to reinterpret it.
        return JSONResponse({"text": "", "control": command, "language": language,
                             "model": "vosk-command", "sttMs": control_ms})
    text, ms = await loop.run_in_executor(None, _transcribe_bytes, raw, filename, language)
    if str(response_format or "json").strip().lower() == "text":
        return Response(content=text, media_type="text/plain; charset=utf-8")
    return JSONResponse({"text": text, "language": language, "detectedLanguage": getattr(text, "language", "") or None,
                         "model": model or settings.whisper_model,
                         "sttMs": round(ms) + control_ms})
