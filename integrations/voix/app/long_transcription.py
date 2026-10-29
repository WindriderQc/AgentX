"""Opt-in native long transcription using the same recognizer and admission lane."""
import asyncio
from functools import partial
import json
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException, Request
from app.cancel import CancelToken
from app.long_transcription_network import youtube_url
from app.long_transcription_store import Store
from app.stt.requests import RecognitionCancelled
from app.stt.admission import recognition_lane

router = APIRouter()
_owner = None
_owner_lock = threading.Lock()


def limits():
    # faster-whisper holds decoded float32 mono 16 kHz. Budget this independently
    # of compressed file size; 512 MiB permits ~2h20 before the model's own RAM.
    decoded = int(os.environ.get("VOIX_LONG_DECODED_BYTES", 512 * 1024 * 1024))
    return {"maxSeconds": decoded / (16000 * 4),
            "maxDownloadBytes": int(os.environ.get("VOIX_LONG_DOWNLOAD_BYTES", 2 * 1024**3))}


def bounded_pcm(source, target, max_seconds, token):
    """Decode to disk with a hard sample budget, including lying media metadata."""
    import av
    import wave
    count = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(str(source), options={'protocol_whitelist': 'file,pipe'}) as container, wave.open(str(target), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        for frame in container.decode(audio=0):
            if token.is_set():
                raise RecognitionCancelled()
            for sample in resampler.resample(frame):
                count += sample.samples
                if count > max_seconds * 16000:
                    raise RuntimeError("Budget mémoire de décodage dépassé.")
                out.writeframesraw(sample.to_ndarray().tobytes())
        for sample in resampler.resample(None):
            count += sample.samples
            if count > max_seconds * 16000:
                raise RuntimeError("Budget mémoire de décodage dépassé.")
            out.writeframesraw(sample.to_ndarray().tobytes())
    return count / 16000


class Owner:
    def __init__(self, root, *, downloader=None, transcriber=None):
        self.store = Store(root)
        self.downloader = downloader or self.download
        self.transcriber = transcriber or self.transcribe
        self.tokens = {}
        self.thread_lock = threading.Lock()

    def start(self, identity, url, language):
        with self.thread_lock:
            prior = self.store.get(identity)
            if not prior and self.tokens:
                raise HTTPException(503, 'Un traitement long est déjà actif.')
            row, fresh = self.store.create({"id": identity, "url": url, "language": language,
                "state": "running", "stage": "accepted", "createdAt": time.time(), "startedAt": time.time()})
            if fresh:
                token = self.tokens[identity] = CancelToken()
                threading.Thread(target=self.work, args=(row, token), daemon=True).start()
            return row

    def cancel(self, identity):
        with self.thread_lock:
            row = self.store.get(identity)
            if not row:
                raise KeyError(identity)
            if row['state'] in ('completed', 'failed', 'cancelled'):
                return row
            if identity in self.tokens:
                self.tokens[identity].set()
                return self.store.update(identity, cancelRequested=True, stage="cancelling")
            return row

    def download(self, row, directory, token):
        budget = limits()
        args = [sys.executable, "-m", "app.long_transcription_download", row["url"], str(directory),
                str(budget["maxDownloadBytes"]), str(budget["maxSeconds"])]
        # One owned session contains the downloader and restricted Deno solver.
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(args, stdout=output, stderr=errors, cwd=Path(__file__).parent.parent,
                                       env={**os.environ, "YTDLP_NO_PLUGINS": "1"},
                                       start_new_session=(os.name != 'nt'),
                                       creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0))
            try:
                while process.poll() is None:
                    if token.is_set():
                        raise RecognitionCancelled()
                    time.sleep(.1)
                if process.returncode:
                    raise RuntimeError("Téléchargement impossible : vidéo inaccessible, format absent ou dépendance yt-dlp indisponible.")
                output.seek(0)
                return json.loads(output.read(8192).decode("utf8"))
            finally:
                if process.poll() is None:
                    # Terminate this owned downloader session, including its
                    # restricted Deno solver, before acknowledging cancellation.
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW, check=False)
                    else:
                        os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        if os.name != 'nt':
                            os.killpg(process.pid, signal.SIGKILL)
                        else:
                            process.kill()
                        process.wait()

    def transcribe(self, path, language, token):
        from app.stt.whisper import transcribe_path
        from app.config import settings
        return asyncio.run(recognition_lane.run(partial(transcribe_path, path, language=language, cancel=token),
                         cancel=token, queue_timeout=settings.whisper_queue_timeout_seconds))[0]

    def work(self, row, token):
        identity = row["id"]
        try:
            with tempfile.TemporaryDirectory(prefix="audio-", dir=self.store.root) as work:
                directory = Path(work)
                self.store.update(identity, stage="downloading")
                meta = self.downloader(row, directory, token)
                if token.is_set():
                    raise RecognitionCancelled()
                source = directory / meta["path"]
                if source.parent != directory or not source.is_file():
                    raise RuntimeError("Piste audio invalide.")
                self.store.update(identity, stage="decoding", title=meta["title"], duration=meta["duration"])
                pcm = directory / "decoded.wav"
                # Fakes can supply a WAV; the production path always bounds decoded samples.
                duration = bounded_pcm(source, pcm, limits()["maxSeconds"], token)
                source.unlink()
                self.store.update(identity, stage="transcribing", duration=duration)
                text = self.transcriber(pcm, row["language"], token)
                if token.is_set():
                    raise RecognitionCancelled()
                segments = getattr(text, "segments", [])
                result = {"text": str(text), "segments": segments,
                          "detectedLanguage": getattr(text, "language", None)}
                if len(json.dumps(result).encode()) > 8 * 1024**2:
                    raise RuntimeError("Résultat trop volumineux pour le stockage configuré.")
                self.store.update(identity, state="completed", stage="completed", result=result, finishedAt=time.time())
        except RecognitionCancelled:
            self.store.update(identity, state="cancelled", stage="cancelled", finishedAt=time.time())
        except Exception:
            stage = (self.store.get(identity) or {}).get("stage")
            message = {"downloading": "Téléchargement impossible. Vérifiez que la vidéo est publique et que yt-dlp est disponible.",
                       "decoding": "Décodage audio impossible ou budget de ressources dépassé.",
                       "transcribing": "Reconnaissance indisponible. Vérifiez le modèle et les ressources du service vocal."}.get(stage, "Traitement interrompu.")
            self.store.update(identity, state="failed", error=message, finishedAt=time.time())
        finally:
            with self.thread_lock:
                self.tokens.pop(identity, None)


def owner():
    global _owner
    root = os.environ.get("VOIX_LONG_TRANSCRIPTIONS_DIR", "")
    if not root:
        raise HTTPException(503, "Le stockage privé des transcriptions longues n’est pas configuré.")
    directory = Path(root).resolve()
    if not Path(root).is_absolute() or directory.is_relative_to(Path(__file__).resolve().parents[3]):
        raise HTTPException(503, 'Le stockage privé doit être un chemin absolu hors du dépôt.')
    with _owner_lock:
        if _owner is None:
            _owner = Owner(root)
    return _owner


def identity(value):
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
        return value
    except (ValueError, AttributeError):
        raise HTTPException(400, "Identité de tentative invalide.")


@router.get("/v1/audio/long-transcriptions/capabilities")
def capabilities():
    if any(importlib.util.find_spec(name) is None for name in ("yt_dlp", "yt_dlp_ejs", "av")):
        raise HTTPException(503, "Les dépendances de transcription longue ne sont pas installées.")
    deno = Path(sys.executable).parent / ("deno.exe" if os.name == "nt" else "deno")
    if not deno.is_file() and not shutil.which("deno"):
        raise HTTPException(503, "Le runtime officiel du téléchargement est indisponible.")
    owner()  # opens/reconciles the private receipt owner; never loads a model
    return {"contract": "voix.long-transcriptions/v1", "durable": True, **limits()}


@router.get("/v1/audio/long-transcriptions/{job_id}")
def read(job_id: str):
    row = owner().store.get(identity(job_id))
    if not row:
        raise HTTPException(404, "Tentative inconnue.")
    return row


@router.post("/v1/audio/long-transcriptions")
async def start(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 4096:
            raise HTTPException(413, "Requête trop volumineuse.")
    try:
        body = json.loads(raw)
        job_id = identity(body.get("id"))
        url = youtube_url(body.get("url"))
        language = body.get("language", "auto")
        if language not in ("auto", "fr", "en", "fr-en"):
            raise ValueError("Langue invalide.")
        return owner().start(job_id, url, language)
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/v1/audio/long-transcriptions/{job_id}/cancel")
def cancel(job_id: str):
    try:
        return owner().cancel(identity(job_id))
    except KeyError:
        raise HTTPException(404, "Tentative inconnue.")
