"""Recoverable CUDA failures and model ownership; no real models or GPU calls."""
import io
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest

from app.stt import whisper


@pytest.fixture
def runtime(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(whisper, "settings", replace(whisper.settings,
        whisper_device="cuda", whisper_compute_type="int8_float16"))
    for name, value in {
        "_prefer_cpu": False, "_retry_at": 0.0, "_gpu_failures": 0,
        "_failure_reason": None, "_retrying": False, "_models": {}, "_last_run_at": None,
    }.items():
        monkeypatch.setattr(whisper, name, value)
    monkeypatch.setattr(whisper.time, "monotonic", lambda: clock[0])
    return clock


def install_model(monkeypatch, action):
    def build(device, compute):
        assert compute == ("int8" if device == "cpu" else "int8_float16")
        class Model:
            def transcribe(self, audio, **options):
                action(device, audio, options)
                return iter([SimpleNamespace(text="Bonjour.")]), SimpleNamespace(language="fr")
        return Model()
    monkeypatch.setattr(whisper, "_build_model", build)


@pytest.mark.parametrize("uploaded", [False, True], ids=["native", "upload"])
def test_transient_cuda_failure_recovers_with_original_audio_and_settings(monkeypatch, runtime, uploaded):
    seen = []
    def run(device, audio, options):
        seen.append((device, audio.read() if uploaded else audio.copy(), options))
        if len(seen) == 1:
            raise RuntimeError("CUDA failed with error out of memory")
    install_model(monkeypatch, run)
    def transcribe():
        if uploaded:
            with io.BytesIO(b"prefix:whole utterance") as audio:
                audio.seek(7)
                return whisper.transcribe_path(audio, language="fr")
        return whisper.transcribe(np.ones(16000, dtype=np.float32), language="fr")

    assert transcribe()[0] == "Bonjour."
    status = whisper.backend_status()
    assert status["device"] == "cpu" and status["degraded"]
    assert status["failure_reason"] == "out_of_memory" and status["retry_after_seconds"] == 30
    assert transcribe()[0] == "Bonjour."
    assert [row[0] for row in seen] == ["cuda", "cpu", "cpu"]
    runtime[0] += 30
    assert transcribe()[0] == "Bonjour."
    assert [row[0] for row in seen] == ["cuda", "cpu", "cpu", "cuda"]
    assert all(row[2]["beam_size"] == 5 and row[2]["language"] == "fr"
               and row[2]["vad_filter"] is uploaded for row in seen)
    if uploaded:
        assert all(row[1] == b"whole utterance" for row in seen)
    else:
        assert all(np.array_equal(row[1], seen[0][1]) for row in seen)
    assert whisper.backend_status() == {
        "device": "cuda", "compute_type": "int8_float16", "degraded": False,
        "retry_after_seconds": 0, "retrying": False, "consecutive_gpu_failures": 0,
        "failure_reason": None,
    }
    assert set(whisper._models) == {("cuda", "int8_float16")}


def test_repeated_cuda_failures_back_off_without_hot_reload_loop(monkeypatch, runtime):
    calls = []
    def run(device, audio, options):
        calls.append(device)
        if device == "cuda":
            raise RuntimeError("cuDNN unavailable")
    install_model(monkeypatch, run)
    for failures, delay in enumerate([30, 60, 120, 240, 300, 300], start=1):
        whisper.transcribe_path("sample.wav", language="fr")
        status = whisper.backend_status()
        assert status["consecutive_gpu_failures"] == failures
        assert status["retry_after_seconds"] == delay
        assert whisper.warm(max_age_s=0) is None
        runtime[0] += delay - 1
        whisper.transcribe_path("sample.wav", language="fr")
        assert calls.count("cuda") == failures
        runtime[0] += 1


def test_cpu_only_deployment_never_attempts_gpu(monkeypatch, runtime):
    monkeypatch.setattr(whisper, "settings", replace(whisper.settings, whisper_device="cpu"))
    monkeypatch.setattr(whisper, "_prefer_cpu", True)
    calls = []
    install_model(monkeypatch, lambda device, *_: calls.append(device))
    whisper.preload_model()
    whisper.transcribe_path("sample.wav")
    runtime[0] += 1000
    assert whisper.warm() is not None
    assert whisper.warm() is None
    assert calls == ["cpu", "cpu"]
    assert whisper.backend_status()["degraded"] is False


def test_non_cuda_and_cpu_errors_surface_without_replaying(monkeypatch, runtime):
    calls = []
    def run(device, *_):
        calls.append(device)
        raise ValueError("Invalid audio")
    install_model(monkeypatch, run)
    with pytest.raises(ValueError, match="Invalid audio"):
        whisper.transcribe_path("sample.wav")
    assert calls == ["cuda"] and whisper.backend_status()["degraded"] is False
    monkeypatch.setattr(whisper, "_prefer_cpu", True)
    monkeypatch.setattr(whisper, "_retry_at", 200)
    with pytest.raises(ValueError, match="Invalid audio"):
        whisper.transcribe_path("sample.wav")
    assert calls == ["cuda", "cpu"] and whisper.backend_status()["consecutive_gpu_failures"] == 0


def test_failed_warm_does_not_load_or_run_cpu_and_can_recover(monkeypatch, runtime):
    calls = []
    fail = [True]
    def run(device, *_):
        calls.append(device)
        if fail[0]:
            raise RuntimeError("CUDA unavailable")
    install_model(monkeypatch, run)
    assert whisper.warm() is None
    assert calls == ["cuda"] and not whisper._models
    assert whisper.warm() is None
    runtime[0] += 30
    fail[0] = False
    assert whisper.warm() is not None
    assert calls == ["cuda", "cuda"] and not whisper.backend_status()["degraded"]


def test_recovery_warm_is_due_even_after_recent_cpu_transcription(monkeypatch, runtime):
    calls = []
    def run(device, *_):
        calls.append(device)
        if len(calls) == 1:
            raise RuntimeError("CUDA unavailable")
    install_model(monkeypatch, run)
    whisper.transcribe_path("sample.wav")
    runtime[0] += 29
    whisper.transcribe_path("sample.wav")
    runtime[0] += 1
    assert whisper.warm() is not None
    assert calls == ["cuda", "cpu", "cpu", "cuda"]


def test_preload_failure_reports_degraded_until_a_decode_succeeds(monkeypatch, runtime):
    install_model(monkeypatch, lambda *_: None)
    healthy_build = whisper._build_model
    builds = []
    def build(device, compute):
        builds.append(device)
        if len(builds) == 1:
            raise RuntimeError("CUDA unavailable")
        return healthy_build(device, compute)
    monkeypatch.setattr(whisper, "_build_model", build)
    assert whisper.preload_model()["device"] == "cpu"
    assert whisper.backend_status()["degraded"] is True
    runtime[0] += 30
    assert whisper.preload_model()["device"] == "cuda"
    assert whisper.backend_status()["degraded"] is True
    whisper.transcribe_path("sample.wav")
    assert whisper.backend_status()["degraded"] is False


def test_uploads_serialize_warm_skips_busy_model_and_discovery_never_waits(monkeypatch, runtime):
    entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def run(device, audio, options):
        calls.append(str(audio))
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
    install_model(monkeypatch, run)
    def second():
        second_started.set()
        return whisper.transcribe_path("second.wav")
    with ThreadPoolExecutor(max_workers=3) as pool:
        first = pool.submit(whisper.transcribe_path, "first.wav")
        try:
            assert entered.wait(5)
            other = pool.submit(second)
            assert second_started.wait(5)
            assert pool.submit(whisper.warm, max_age_s=0).result(timeout=1) is None
            assert pool.submit(whisper.backend_status).result(timeout=1)["device"] == "cuda"
            assert calls == ["first.wav"]
        finally:
            release.set()
        assert first.result(timeout=5)[0] == other.result(timeout=5)[0] == "Bonjour."
    assert calls == ["first.wav", "second.wav"]


def test_health_exposes_current_fallback_without_loading_model_or_logging_payload(monkeypatch, runtime, caplog):
    from fastapi.testclient import TestClient
    from app.service import app
    monkeypatch.setattr(whisper._LOG, "propagate", True)
    def run(device, *_):
        if device == "cuda":
            raise RuntimeError("CUDA out of memory; private transcript must not be logged")
    install_model(monkeypatch, run)
    whisper.transcribe_path("private-path.wav")
    def forbidden(*_):
        raise AssertionError("Discovery cannot load or decode a model")
    monkeypatch.setattr(whisper, "_get_model", forbidden)
    client = TestClient(app)
    for route in ("/health", "/api/health"):
        response = client.get(route)
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "degraded"
        assert body["recognition"]["failure_reason"] == "out_of_memory"
        assert body["recognition"]["retry_after_seconds"] == 30
    assert client.get("/v1/models").json()["data"][0]["device"] == "cpu"
    assert "out_of_memory" in caplog.text
    assert "private transcript" not in caplog.text and "private-path" not in caplog.text
