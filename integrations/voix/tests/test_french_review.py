import io
import wave
from types import SimpleNamespace

import pytest

from app.stt.french_review import FrenchReview, reviewed_text, weather_ending
from app.stt.requests import RecognitionCancelled


class Transcript(str):
    evidence = {"segments": 1}


def clip(seconds=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams((1, 2, 16000, 0, "NONE", ""))
        w.writeframes(bytes(32000 * seconds))
    return out.getvalue()


def unused(*args):
    pytest.fail("ineligible pass")


@pytest.mark.parametrize("original, alternate, expected", [
    ("Prends le bateau vert.", "Prends le baton vert.", "Prends le bâton vert."),
    ("Prends le bâton vert.", "Prends le bateau vert.", "Prends le bateau vert."),
    ("BATEAU ?", "bâton", "Bâton ?"),
])
def test_only_the_locally_confirmed_noun_changes(original, alternate, expected):
    sizes = []
    def decode(payload):
        with wave.open(io.BytesIO(payload)) as w:
            assert w.getframerate() == 14400
            sizes.append(w.getnframes())
        return alternate
    assert reviewed_text(Transcript(original), clip(), decode, unused) == expected
    assert sizes == [16000 + 3456, 16000]


@pytest.mark.parametrize("candidate", ["Trouve un bâton ici.", "Prends le bateau vert.",
                                      "Prends le bateau et le bâton.", ""])
def test_missing_or_displaced_word_preserves_first_read(candidate):
    assert reviewed_text(Transcript("Prends le bateau vert."), clip(), lambda _: candidate, unused) is None


def test_two_views_must_agree():
    views = iter(["Prends le bâton vert.", "Prends le bateau vert."])
    assert reviewed_text(Transcript("Prends le bateau vert."), clip(), lambda _: next(views), unused) is None


@pytest.mark.parametrize("source", ["Trouve le bouton.", "Il a combattu.", "À Baton Rouge.",
                                    "Un bateau et un bâton.", "Quel lingot d’or ?", "Un collier d’or."])
def test_controls_preserved_without_model_call(source):
    assert reviewed_text(Transcript(source), clip(), unused, unused) is None


def test_weather_needs_clear_syntax_or_independent_words():
    assert reviewed_text(Transcript("Quel temps fait-il d'or ?"), clip(), unused, unused) == "Quel temps fait-il dehors ?"
    source = Transcript("Quel tanfètil d’or ?")
    assert reviewed_text(source, clip(), unused, lambda *_: []) is None
    assert reviewed_text(source, clip(), unused, lambda *_: True) == "Quel temps fait-il dehors ?"


def test_recover_weak_question_only_with_independent_acoustic_confirmation():
    source = Transcript("Qu'est-ce que tu fais là ?")
    source.evidence = {"segments": 1, "avgLogProbability": -.9}
    assert reviewed_text(source, clip(), unused, lambda *_: False) is None
    assert reviewed_text(source, clip(), unused, lambda *_: True) == "Quel temps fait-il dehors ?"


@pytest.mark.parametrize("cue,score,word,margin,accepted", [
    ("temps", .95, "dehors", 2, True), ("temps", .95, "demain", 3, False),
    ("train", .95, "dehors", 2, False), ("temps", .4, "dehors", 2, False),
    ("temps", .95, "dehors", .2, False),
])
def test_weather_acoustic_checks(cue, score, word, margin, accepted):
    import json
    class Reader:
        def __init__(self, *args): self.ending = len(args) == 3
        def SetWords(self, value): pass
        def SetMaxAlternatives(self, value): pass
        def AcceptWaveform(self, data): return False
        def FinalResult(self):
            if self.ending:
                return json.dumps({"alternatives": [{"text": word, "confidence": 8 + margin},
                                                    {"text": "[unk]", "confidence": 8}]})
            return json.dumps({"result": [{"word": w, "conf": score, "start": .2, "end": .6}
                                          for w in ("quel", cue, "fait-il", "bureau")]})
    assert weather_ending(None, Reader, 16000, bytes(32000)) is accepted


def test_non_pcm_long_and_failed_reviews_preserve_original():
    source = Transcript("Un bateau.")
    assert reviewed_text(source, b"compressed", unused, unused) is None
    assert reviewed_text(source, clip(5), unused, unused) is None
    def failure(_): raise RuntimeError("decoder unavailable")
    review = FrenchReview(None, None)
    assert review(clip(), source, failure, None) is source
    with pytest.raises(RecognitionCancelled):
        review(clip(), source, unused, SimpleNamespace(is_set=lambda: True))
