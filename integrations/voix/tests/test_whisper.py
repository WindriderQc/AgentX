from types import SimpleNamespace
import io
import threading

import numpy as np
import pytest

from app.stt import whisper
from app.stt.whisper import _run


def test_uploaded_speech_threshold_can_be_calibrated_by_the_instance(monkeypatch):
    from dataclasses import replace
    calibrated = replace(whisper.settings, whisper_vad_threshold=0.7)
    monkeypatch.setattr(whisper, "settings", calibrated)
    class FakeModel:
        def transcribe(self, audio, **options):
            assert options["vad_parameters"]["threshold"] == 0.7
            assert options["vad_parameters"]["neg_threshold"] == 0.35
            return iter([SimpleNamespace(text="Oui.")]), SimpleNamespace(language="fr", duration_after_vad=0.2)
    assert _run(FakeModel(), "speech.wav", "fr", vad_filter=True) == "Oui."


@pytest.mark.parametrize("value", ["0", "1", "-0.1", "nan", "inf"])
def test_invalid_speech_threshold_is_rejected_at_startup(monkeypatch, value):
    from app.config import load_settings
    monkeypatch.setenv("WHISPER_VAD_THRESHOLD", value)
    with pytest.raises(ValueError, match="WHISPER_VAD_THRESHOLD"):
        load_settings()


def test_run_uses_quality_beam_and_requested_language():
    class FakeModel:
        kwargs = None

        def transcribe(self, audio, **kwargs):
            self.kwargs = kwargs
            return iter([
                SimpleNamespace(text=" Nestor "),
                SimpleNamespace(text=" est prêt. "),
            ]), SimpleNamespace(language=kwargs["language"])

    model = FakeModel()
    text = _run(model, "audio.wav", "fr")

    assert text == "Nestor est prêt."
    assert model.kwargs == {
        "beam_size": 5,
        "language": "fr",
        "task": "transcribe",
        "vad_filter": False,
        "hotwords": "Nestor, AgentX, OpenClaw, VoiX",
        "initial_prompt": (
            "Conversation en français québécois avec Nestor. "
            "Noms propres : Nestor, AgentX, OpenClaw et VoiX."
        ),
        "condition_on_previous_text": False,
    }


@pytest.mark.parametrize("language,expected", [("auto", None), ("en", "en")])
def test_bilingual_transcription_does_not_force_french_or_translate(language, expected):
    class FakeModel:
        def transcribe(self, audio, **kwargs):
            assert kwargs["language"] == expected
            assert kwargs["task"] == "transcribe"
            assert kwargs["initial_prompt"] == whisper.settings.whisper_hotwords
            assert "français" not in kwargs["initial_prompt"]
            return iter([SimpleNamespace(text="Because my Ollama server is not available.")]), SimpleNamespace(language="en")

    assert _run(FakeModel(), "audio.wav", language) == "Because my Ollama server is not available."


@pytest.mark.parametrize("cuda_failure", [False, True])
def test_uploaded_audio_keeps_speech_detection_on_cpu_fallback(monkeypatch, cuda_failure):
    calls = []

    class FakeModel:
        def __init__(self, device):
            self.device = device

        def transcribe(self, audio, **kwargs):
            calls.append((self.device, audio, kwargs))
            if cuda_failure and self.device == "cuda":
                raise RuntimeError("CUDA runtime unavailable")
            return iter([]), SimpleNamespace(language=kwargs["language"])

    monkeypatch.setattr(whisper, "_prefer_cpu", False)
    monkeypatch.setattr(whisper, "_models", {})
    monkeypatch.setattr(whisper, "_active_backend", lambda: ("cuda", "float16"))
    monkeypatch.setattr(whisper, "_get_model", lambda device, compute: FakeModel(device))
    text, elapsed = whisper.transcribe_path("browser.wav", language="fr")

    assert text == ""
    assert elapsed >= 0
    assert [device for device, _, _ in calls] == (["cuda", "cpu"] if cuda_failure else ["cuda"])
    assert all(audio == "browser.wav" and opts["vad_filter"] is True for _, audio, opts in calls)
    assert all(opts["language"] == "fr" for _, _, opts in calls)
    assert all(opts["vad_parameters"] == {
        "threshold": 0.85, "neg_threshold": 0.35,
        "min_speech_duration_ms": 100, "min_silence_duration_ms": 200, "speech_pad_ms": 400,
    } for _, _, opts in calls)


def test_uploaded_noise_with_no_detected_speech_never_decodes_or_retries_a_language():
    calls = []
    def no_words():
        raise AssertionError("audio without speech must not decode words")
        yield
    class FakeModel:
        def transcribe(self, audio, **options):
            calls.append(options)
            return no_words(), SimpleNamespace(language="ja", all_language_probs=None, duration_after_vad=0)
    text = _run(FakeModel(), "notification.wav", "fr-en", vad_filter=True)
    assert text == "" and text.language == ""
    assert len(calls) == 1


def test_real_subtitle_words_are_not_blacklisted():
    class FakeModel:
        def transcribe(self, audio, **kwargs):
            assert kwargs["vad_filter"] is True
            return iter([SimpleNamespace(text="Explique le sous-titrage de Radio-Canada.")]), SimpleNamespace()

    assert _run(FakeModel(), "speech.wav", "fr", vad_filter=True) == "Explique le sous-titrage de Radio-Canada."


@pytest.mark.parametrize("language", ["fr", "en"])
def test_bilingual_mode_keeps_detected_french_or_english_in_one_pass(language):
    calls = []
    class FakeModel:
        def transcribe(self, audio, **options):
            calls.append(options)
            assert options["language"] is None
            return iter([SimpleNamespace(text="Bonjour" if language == "fr" else "Hello")]), SimpleNamespace(language=language)
    assert _run(FakeModel(), "speech.wav", "fr-en", vad_filter=True) == ("Bonjour" if language == "fr" else "Hello")
    assert len(calls) == 1
    assert calls[0]["vad_filter"] is True


@pytest.mark.parametrize("selected", ["fr", "en"])
def test_bilingual_mode_rewinds_upload_and_never_decodes_detected_japanese(selected):
    calls = []
    def wrong_language_segments():
        raise AssertionError("Japanese segments must not be decoded")
        yield
    class FakeModel:
        def transcribe(self, audio, **options):
            assert audio.read() == b"audio bytes"
            calls.append(options)
            if len(calls) == 1:
                assert options["language"] is None
                return wrong_language_segments(), SimpleNamespace(language="ja", all_language_probs=[
                    ("ja", 0.8), ("fr", 0.15 if selected == "fr" else 0.05), ("en", 0.15 if selected == "en" else 0.05)])
            assert options["language"] == selected
            return iter([SimpleNamespace(text="Bonjour" if selected == "fr" else "Hello")]), SimpleNamespace(language=selected)
    with io.BytesIO(b"audio bytes") as audio:
        assert _run(FakeModel(), audio, "fr-en", vad_filter=True) == ("Bonjour" if selected == "fr" else "Hello")
    assert len(calls) == 2
    assert all(options["vad_filter"] is True and options["task"] == "transcribe" for options in calls)


def test_bilingual_mode_reports_missing_language_evidence_instead_of_guessing():
    class FakeModel:
        def transcribe(self, audio, **options):
            return iter([]), SimpleNamespace(language="ja", all_language_probs=None)
    with pytest.raises(RuntimeError, match="French/English speech detection is unavailable"):
        _run(FakeModel(), "speech.wav", "fr-en")


def test_uploaded_memory_stream_rewinds_for_cpu_fallback(monkeypatch):
    payloads = []

    class FakeModel:
        def __init__(self, device):
            self.device = device

        def transcribe(self, audio, **kwargs):
            assert kwargs["vad_filter"] is True
            payloads.append(audio.read())
            if self.device == "cuda":
                raise RuntimeError("CUDA runtime unavailable")
            return iter([SimpleNamespace(text="Bonjour")]), SimpleNamespace()

    monkeypatch.setattr(whisper, "_prefer_cpu", False)
    monkeypatch.setattr(whisper, "_models", {})
    monkeypatch.setattr(whisper, "_active_backend", lambda: ("cuda", "float16"))
    monkeypatch.setattr(whisper, "_get_model", lambda device, compute: FakeModel(device))
    with io.BytesIO(b"whole utterance") as audio:
        assert whisper.transcribe_path(audio, language="fr")[0] == "Bonjour"
    assert payloads == [b"whole utterance", b"whole utterance"]


@pytest.mark.parametrize("language", ["fr", "en"])
def test_transcript_reports_the_language_whisper_decoded(language):
    class FakeModel:
        def transcribe(self, audio, **options):
            return iter([SimpleNamespace(text="Bonjour" if language == "fr" else "Hello")]), SimpleNamespace(language=language)
    text = _run(FakeModel(), "speech.wav", "fr-en", vad_filter=True)
    assert text.language == language


class _RecordingModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        return iter([SimpleNamespace(text="Bonjour")]), SimpleNamespace(language=kwargs["language"])


def _resident(monkeypatch, model):
    """One loaded model that has not run yet in this process."""
    monkeypatch.setattr(whisper, "_prefer_cpu", False)
    monkeypatch.setattr(whisper, "_active_backend", lambda: ("cuda", "float16"))
    monkeypatch.setattr(whisper, "_get_model", lambda device, compute: model)
    monkeypatch.setattr(whisper, "_last_run_at", None)
    return model


def test_warm_runs_the_model_once_on_silence_without_speech_detection(monkeypatch):
    model = _resident(monkeypatch, _RecordingModel())

    elapsed = whisper.warm()

    assert isinstance(elapsed, float) and elapsed >= 0
    assert len(model.calls) == 1
    audio, options = model.calls[0]
    assert audio.dtype == np.float32 and audio.shape == (16000,) and not audio.any()
    assert options["vad_filter"] is False, "the speech filter would skip the model on silence"
    assert options["language"] == "fr"


def test_warm_does_nothing_inside_the_window_and_runs_again_after_it(monkeypatch):
    model = _resident(monkeypatch, _RecordingModel())

    assert whisper.warm() is not None
    assert whisper.warm() is None
    assert len(model.calls) == 1
    assert whisper.warm(max_age_s=0.0) is not None
    assert len(model.calls) == 2


def test_warm_does_nothing_while_another_warm_is_in_progress(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    class BlockedModel(_RecordingModel):
        def transcribe(self, audio, **kwargs):
            entered.set()
            assert release.wait(5)
            return super().transcribe(audio, **kwargs)

    model = _resident(monkeypatch, BlockedModel())
    results = []
    first = threading.Thread(target=lambda: results.append(whisper.warm()))
    first.start()
    try:
        assert entered.wait(5)
        assert whisper.warm(max_age_s=0.0) is None
    finally:
        release.set()
        first.join(5)

    assert len(model.calls) == 1
    assert results[0] is not None


def test_warm_returns_none_when_the_model_fails_and_leaves_the_next_call_free(monkeypatch):
    class FailingModel(_RecordingModel):
        failing = True

        def transcribe(self, audio, **kwargs):
            if self.failing:
                self.calls.append((audio, kwargs))
                raise RuntimeError("decoder failed")
            return super().transcribe(audio, **kwargs)

    model = _resident(monkeypatch, FailingModel())

    assert whisper.warm() is None
    assert len(model.calls) == 1
    model.failing = False
    assert whisper.warm() is not None, "a failed run neither holds the lock nor opens the window"
    assert len(model.calls) == 2


@pytest.mark.parametrize("ordinary", [
    lambda: whisper.transcribe(np.ones(16000, dtype=np.float32), language="fr"),
    lambda: whisper.transcribe_path("browser.wav", language="fr"),
], ids=["native", "upload"])
def test_an_ordinary_transcription_refreshes_the_warm_window(monkeypatch, ordinary):
    model = _resident(monkeypatch, _RecordingModel())

    ordinary()

    assert whisper.warm() is None
    assert len(model.calls) == 1, "only the ordinary transcription ran the model"
