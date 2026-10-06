import numpy as np

import app.tts.kokoro as kokoro
from app.tts.kokoro import _phonemes_without_language_switch_markers, _voice_style


def test_weighted_voice_blend_is_normalized():
    class FakeTts:
        styles = {
            "male": np.array([1.0, 0.0], dtype=np.float32),
            "french": np.array([0.0, 1.0], dtype=np.float32),
        }

        def get_voice_style(self, name):
            return self.styles[name]

    style = _voice_style(FakeTts(), "male:0.85+french:0.15")
    assert np.allclose(style, np.array([0.85, 0.15], dtype=np.float32))


def test_single_voice_name_stays_on_fast_path():
    assert _voice_style(object(), "am_michael") == "am_michael"


def test_espeak_code_switch_markers_are_not_synthesized_as_letters():
    class FakeTokenizer:
        def phonemize(self, text, language):
            assert text == "Passe par OpenClaw."
            assert language == "fr-fr"
            return "pˈas paʁ (en)ˈəʊpən klˈɔː(fr)."

    class FakeTts:
        tokenizer = FakeTokenizer()

    assert _phonemes_without_language_switch_markers(
        FakeTts(), "Passe par OpenClaw.", "fr-fr"
    ) == "pˈas paʁ ˈəʊpən klˈɔː."


def test_synthesis_sends_clean_phonemes_to_kokoro(monkeypatch):
    seen = {}

    class FakeTokenizer:
        def phonemize(self, text, language):
            return "(en)ˈəʊpən klˈɔː(fr)"

    class FakeTts:
        tokenizer = FakeTokenizer()

        def create(self, **kwargs):
            seen.update(kwargs)
            return np.zeros(16, dtype=np.float32), 24000

    monkeypatch.setattr(kokoro, "_get_tts", lambda: FakeTts())

    samples, rate, _elapsed = kokoro.synthesize(
        "OpenClaw", language="fr-fr", voice="am_michael"
    )

    assert samples.shape[0] >= 16
    assert rate == 24000
    assert seen["text"] == "ˈəʊpən klˈɔː"
    assert seen["lang"] == "fr-fr"
    assert seen["is_phonemes"] is True
