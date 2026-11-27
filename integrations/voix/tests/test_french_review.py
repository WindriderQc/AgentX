import io
import wave
from types import SimpleNamespace

import pytest

from app.stt.french_review import FrenchReview, reviewed_text
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
    words = [{"word": word, "conf": .95} for word in ("quel", "temps", "fait-il", "dehors")]
    assert reviewed_text(source, clip(), unused, lambda *_: words) == "Quel temps fait-il dehors ?"
    words[1]["conf"] = .4
    assert reviewed_text(source, clip(), unused, lambda *_: words) is None


def test_non_pcm_long_and_failed_reviews_preserve_original():
    source = Transcript("Un bateau.")
    assert reviewed_text(source, b"compressed", unused, unused) is None
    assert reviewed_text(source, clip(5), unused, unused) is None
    def failure(_): raise RuntimeError("decoder unavailable")
    review = FrenchReview(None, None)
    assert review(clip(), source, failure, None) is source
    with pytest.raises(RecognitionCancelled):
        review(clip(), source, unused, SimpleNamespace(is_set=lambda: True))
