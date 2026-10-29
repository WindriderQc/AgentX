"""No model/GPU/network. Native durability, egress and cancellation contracts."""
import json
from pathlib import Path
import socket
import threading
import time
import uuid
import wave
from unittest.mock import patch

import pytest
from app.long_transcription_network import youtube_url, public_target
from app.long_transcription_store import Store
from app.long_transcription import Owner, bounded_pcm
from app.cancel import CancelToken


def test_urls_and_every_egress_target_are_bounded():
    assert youtube_url("https://youtu.be/abcdefghijk?list=ignored").endswith("v=abcdefghijk")
    for value in ("https://127.0.0.1/x", "file:///etc/passwd", "https://youtube.com.evil.test/watch?v=abcdefghijk",
                  "https://www.youtube.com/playlist?list=x", "https://user:secret@youtube.com/watch?v=abcdefghijk"):
        with pytest.raises(ValueError):
            youtube_url(value)
    for host in ("localhost", "169.254.169.254", "youtube.com.evil.test", "127.0.0.1"):
        with pytest.raises(ValueError):
            public_target(host, 443)
    for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"):
        with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]):
            with pytest.raises(ValueError):
                public_target("www.youtube.com", 443)
    with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]):
        assert public_target("rr1.googlevideo.com", 443)[4][0] == "8.8.8.8"
        with pytest.raises(ValueError):
            public_target("www.youtube.com", 80)


def test_receipt_restart_never_replays_an_active_job(tmp_path):
    store = Store(tmp_path)
    row = {"id": str(uuid.uuid4()), "url": "https://www.youtube.com/watch?v=abcdefghijk",
           "language": "auto", "state": "running", "stage": "transcribing"}
    assert store.create(row)[1]
    assert not store.create(row)[1]
    with pytest.raises(ValueError):
        store.create({**row, "language": "en"})
    store.close()
    restarted = Store(tmp_path)
    assert restarted.get(row["id"])["state"] == "failed"
    assert restarted.get(row["id"])["stage"] == "interrupted"
    restarted.close()


def audio(path, seconds=1):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
        output.writeframes(b"\0\0" * int(seconds * 16000))


def wait(owner, identity):
    for _ in range(100):
        row = owner.store.get(identity)
        if row["state"] in ("completed", "failed", "cancelled"):
            return row
        time.sleep(.02)
    raise AssertionError("native worker did not terminate")


def test_small_nonprivate_audio_fixture_uses_same_transcriber_contract(tmp_path):
    calls = []
    def download(row, directory, token):
        audio(directory / "fixture.wav")
        return {"path": "fixture.wav", "duration": 1, "title": "Synthetic silence fixture"}
    def transcribe(path, language, token):
        calls.append(path)
        class Text(str):
            language = "fr"
            segments = [{"start": 0, "end": 1, "text": "Synthetic fixture"}]
        return Text("Synthetic fixture")
    owner = Owner(tmp_path, downloader=download, transcriber=transcribe)
    identity = str(uuid.uuid4())
    owner.start(identity, "https://www.youtube.com/watch?v=abcdefghijk", "auto")
    result = wait(owner, identity)
    assert result["state"] == "completed"
    assert result["result"]["segments"][0]["end"] == 1
    assert result["duration"] == 1
    owner.start(identity, result["url"], "auto")
    assert len(calls) == 1
    assert not list(tmp_path.glob("audio-*"))
    owner.store.close()


def test_cancellation_remains_nonterminal_until_native_work_has_stopped(tmp_path):
    entered, stop = threading.Event(), threading.Event()
    def download(row, directory, token):
        entered.set(); stop.wait(2)
        if token.is_set():
            from app.stt.requests import RecognitionCancelled
            raise RecognitionCancelled()
    owner = Owner(tmp_path, downloader=download)
    identity = str(uuid.uuid4())
    owner.start(identity, "https://www.youtube.com/watch?v=abcdefghijk", "auto")
    assert entered.wait(1)
    row = owner.cancel(identity)
    assert row["state"] == "running" and row["stage"] == "cancelling"
    stop.set()
    assert wait(owner, identity)["state"] == "cancelled"
    owner.store.close()


def test_decoded_sample_budget_is_real_and_does_not_trust_metadata(tmp_path):
    source = tmp_path / "fixture.wav"; audio(source, 2)
    with pytest.raises(RuntimeError, match="mémoire"):
        bounded_pcm(source, tmp_path / "out.wav", .5, CancelToken())


def test_connect_proxy_blocks_private_destinations_and_redirect_tunnels():
    from app.long_transcription_network import youtube_proxy
    from urllib.parse import urlsplit
    with youtube_proxy() as proxy:
        url = urlsplit(proxy)
        for target in ('169.254.169.254:443', 'localhost:443', 'www.youtube.com:443'):
            with patch('socket.getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]):
                connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                connection.settimeout(2)
                connection.connect(('127.0.0.1', url.port))
                connection.sendall(('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n').encode())
                assert b'403 Forbidden' in connection.recv(4096)
                connection.close()


def test_native_owner_lock_and_crash_spool_cleanup(tmp_path):
    store = Store(tmp_path)
    with pytest.raises((BlockingIOError, OSError)):
        Store(tmp_path)
    directory = tmp_path / 'audio-interrupted'; directory.mkdir(); (directory / 'private.wav').write_bytes(b'fixture')
    store.close()
    restarted = Store(tmp_path)
    assert not directory.exists()
    restarted.close()


def test_official_deno_solver_runtime_has_no_network_or_filesystem_grants():
    import subprocess
    import sys
    from yt_dlp.extractor.youtube.jsc._builtin.deno import DenoJCP
    runtime = Path(sys.executable).parent / "deno"
    script = """let denied = 0;
try { await fetch('http://169.254.169.254/'); } catch (e) { if (e.name === 'NotCapable') denied++; }
try { await Deno.readTextFile('/etc/passwd'); } catch (e) { if (e.name === 'NotCapable') denied++; }
console.log(denied);"""
    result = subprocess.run([str(runtime), "run", *DenoJCP._DENO_BASE_OPTIONS, "--no-npm", "--cached-only", "-"],
                            input=script, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "2"


def test_downloader_passes_only_native_https_audio_and_packaged_solver(tmp_path, monkeypatch):
    import yt_dlp
    from app.long_transcription_download import download
    captured = {}
    class FakeDownloader:
        def __init__(self, options):
            captured.update(options)
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def extract_info(self, url, download=False):
            assert url == "https://www.youtube.com/watch?v=abcdefghijk" and not download
            return {"title": "Synthetic download fixture", "duration": 1}
        def process_info(self, info):
            (tmp_path / "source.m4a").write_bytes(b"native-audio-fixture")
        def prepare_filename(self, info):
            return str(tmp_path / "source.m4a")
    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeDownloader)
    download("https://youtu.be/abcdefghijk", tmp_path, 1024 * 1024, 10)
    assert captured["format"] == "bestaudio[protocol=https]"
    assert captured["proxy"].startswith("http://127.0.0.1:")
    assert captured["remote_components"] == []
    assert list(captured["js_runtimes"]) == ["deno"]
    assert captured["allowed_extractors"] == ["youtube"]


def test_native_http_contract_rejects_bad_urls_body_and_reused_identity(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import app.long_transcription as module
    entered, release = threading.Event(), threading.Event()
    def download(row, directory, token):
        entered.set(); release.wait(3)
        from app.stt.requests import RecognitionCancelled
        raise RecognitionCancelled()
    native = Owner(tmp_path, downloader=download)
    monkeypatch.setenv("VOIX_LONG_TRANSCRIPTIONS_DIR", str(tmp_path))
    monkeypatch.setattr(module, "_owner", native)
    app = FastAPI(); app.include_router(module.router)
    client = TestClient(app)
    identity = str(uuid.uuid4())
    body = {"id": identity, "url": "https://youtu.be/abcdefghijk", "language": "auto"}
    assert client.post("/v1/audio/long-transcriptions", json={**body, "url": "https://127.0.0.1/"}).status_code == 400
    assert client.post("/v1/audio/long-transcriptions", content=b"x" * 4097).status_code == 413
    try:
        assert client.post("/v1/audio/long-transcriptions", json=body).status_code == 200
        assert entered.wait(1)
        assert client.post("/v1/audio/long-transcriptions", json=body).status_code == 200
        assert client.post("/v1/audio/long-transcriptions", json={**body, "language": "fr"}).status_code == 400
        assert client.post("/v1/audio/long-transcriptions", json={**body, "id": str(uuid.uuid4())}).status_code == 503
        assert client.post("/v1/audio/long-transcriptions/" + identity + "/cancel").json()["stage"] == "cancelling"
    finally:
        release.set()
        wait(native, identity)
        native.store.close()


def test_capability_probe_never_starts_a_model_and_requires_private_storage(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import app.long_transcription as module
    native = Owner(tmp_path, downloader=lambda *_: None, transcriber=lambda *_: None)
    monkeypatch.setattr(module, '_owner', native)
    monkeypatch.setenv('VOIX_LONG_TRANSCRIPTIONS_DIR', str(tmp_path))
    app = FastAPI(); app.include_router(module.router)
    client = TestClient(app)
    payload = client.get('/v1/audio/long-transcriptions/capabilities').json()
    assert payload['contract'] == 'voix.long-transcriptions/v1' and payload['durable']
    assert not native.tokens and not native.store.list()
    monkeypatch.delenv('VOIX_LONG_TRANSCRIPTIONS_DIR')
    assert client.get('/v1/audio/long-transcriptions/capabilities').status_code == 503
    native.store.close()
