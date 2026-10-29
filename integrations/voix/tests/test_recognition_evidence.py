from types import SimpleNamespace

from app.stt.whisper import _run


def test_evidence_distinguishes_forced_language_vad_and_decoder_signals():
    class Model:
        def transcribe(self, *_args, **_options):
            segments = [SimpleNamespace(start=0.0, end=1.0, text="Nestor.", avg_logprob=-0.2, no_speech_prob=0.01, compression_ratio=1.4),
                        SimpleNamespace(start=0.0, end=1.0, text="Bonjour.", avg_logprob=-0.4, no_speech_prob=0.1, compression_ratio=1.2)]
            return iter(segments), SimpleNamespace(language="fr", duration=2.1, duration_after_vad=0.9)

    text = _run(Model(), "fixture.wav", "fr", vad_filter=True)
    assert text == "Nestor. Bonjour."
    assert text.evidence == {"schema": 1, "requestedLanguage": "fr", "languageSource": "requested",
                             "decodedLanguage": "fr", "segments": 2, "normalizationChanged": False,
                             "audioSeconds": 2.1, "speechSeconds": 0.9, "avgLogProbability": -0.3,
                             "maxNoSpeechProbability": 0.1, "maxCompressionRatio": 1.4}
    assert "text" not in text.evidence and "confidence" not in text.evidence


def test_empty_vad_reports_the_filter_result_without_claiming_a_decoded_language():
    class Model:
        def transcribe(self, *_args, **_options):
            return iter([]), SimpleNamespace(language="fr", duration=1.5, duration_after_vad=0)

    text = _run(Model(), "fixture.wav", "fr", vad_filter=True)
    assert text == ""
    assert text.evidence["audioSeconds"] == 1.5 and text.evidence["speechSeconds"] == 0
    assert "decodedLanguage" not in text.evidence and "avgLogProbability" not in text.evidence


def test_missing_or_invalid_decoder_metrics_stay_absent():
    class Model:
        def transcribe(self, *_args, **_options):
            return iter([SimpleNamespace(start=0.0, end=1.0, text="Bonjour", avg_logprob=float("nan"), no_speech_prob=-1)]), SimpleNamespace(language="fr")

    evidence = _run(Model(), "fixture.wav", "auto").evidence
    assert evidence["languageSource"] == "detected"
    assert "audioSeconds" not in evidence and "avgLogProbability" not in evidence
    assert "maxNoSpeechProbability" not in evidence
