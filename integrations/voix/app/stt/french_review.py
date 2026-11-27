"""Bounded acoustic cross-check for two French dictation ambiguities on short PCM uploads."""
import io
import json
import re
import wave

from app.stt.requests import RecognitionCancelled, check_cancelled

_NOUN = re.compile(r"\b(?:bateau|b[aâ]ton)\b", re.I)
_WEATHER = re.compile(r"^\s*quel\s+([\w'’ -]{2,24}?)\s+d['’]or([ ?!.]*)$", re.I)
_CANONICAL_WEATHER = re.compile(r"temps\s+fait[- ]il", re.I)


def noun(token):
    return "bateau" if token.casefold() == "bateau" else "bâton"


def same_slot(source, match, candidate):
    choices = list(_NOUN.finditer(candidate))
    if len(choices) != 1:
        return None
    other = choices[0]
    def neighbours(text, span):
        before = re.findall(r"\w+", text[:span.start()].casefold())
        after = re.findall(r"\w+", text[span.end():].casefold())
        return (before[-1] if before else None, after[0] if after else None)
    left, right = neighbours(source, match)
    if neighbours(candidate, other) != (left, right):
        return None
    return noun(other[0])


def pcm_clip(raw):
    try:
        with wave.open(io.BytesIO(raw)) as w:
            rate, count = w.getframerate(), w.getnframes()
            if (w.getnchannels() != 1 or w.getsampwidth() != 2 or
                    not 8000 <= rate <= 96000 or not 0 < count <= 4 * rate):
                return None
            samples = w.readframes(count)
            return (rate, samples) if len(samples) == count * 2 else None
    except (EOFError, wave.Error):
        return None


def acoustic_view(rate, samples, lead_seconds):
    out = io.BytesIO()
    rate = round(rate * .9)
    with wave.open(out, "wb") as w:
        w.setparams((1, 2, rate, 0, "NONE", ""))
        w.writeframes(bytes(round(rate * lead_seconds) * 2) + samples)
    return out.getvalue()


def open_words(model, factory, rate, samples):
    recognizer = factory(model, rate)
    recognizer.SetWords(True)
    ended = recognizer.AcceptWaveform(samples)
    words = json.loads(recognizer.Result()).get("result", []) if ended else []
    return words + json.loads(recognizer.FinalResult()).get("result", [])


def weather_text(match, words):
    if not _CANONICAL_WEATHER.fullmatch(match[1]):
        # Require an independent open-vocabulary reading of the weather question.
        cue = [w["word"] for w in words[:3] if w.get("conf", 0) >= .8]
        if cue != ["quel", "temps", "fait-il"] or len(words) != 4:
            return None
    return "Quel temps fait-il dehors" + match[2]


def reviewed_text(text, raw, decode, listen, cancel=None):
    if getattr(text, "evidence", {}).get("segments") != 1:
        return None
    weather = _WEATHER.fullmatch(text)
    nouns = list(_NOUN.finditer(text))
    if not weather and (len(nouns) != 1 or re.search(r"\bb[aâ]ton[ -]rouge\b", text, re.I)):
        return None
    if weather and not re.fullmatch(r"t[\w'’ -]*il", weather[1], re.I):
        return None
    clip = pcm_clip(raw)
    if clip is None:
        return None
    rate, samples = clip
    check_cancelled(cancel)
    if weather:
        words = [] if _CANONICAL_WEATHER.fullmatch(weather[1]) else listen(rate, samples)
        return weather_text(weather, words)
    match = nouns[0]
    first = decode(acoustic_view(rate, samples, .24))
    proposed = same_slot(text, match, first)
    if not proposed or proposed == noun(match[0]):
        return None
    check_cancelled(cancel)
    if same_slot(text, match, decode(acoustic_view(rate, samples, 0))) != proposed:
        return None
    if match[0][0].isupper() and match.start() == 0:
        proposed = proposed.capitalize()
    return text[:match.start()] + proposed + text[match.end():]


class FrenchReview:
    def __init__(self, model, factory):
        self.model = model
        self.factory = factory

    def __call__(self, raw, text, decode, cancel):
        def listen(rate, samples):
            check_cancelled(cancel)
            return open_words(self.model, self.factory, rate, samples)

        try:
            updated = reviewed_text(text, raw, decode, listen, cancel)
        except RecognitionCancelled:
            raise
        except RuntimeError:
            # An optional decoding pass can be busy or unavailable after the
            # original completed. Preserve cancellation and the primary result.
            check_cancelled(cancel)
            return text
        if not updated or updated == text:
            return text
        result = type(text)(updated)
        result.__dict__.update(vars(text))
        if getattr(text, "segments", None) and len(text.segments) == 1:
            result.segments = [{**text.segments[0], "text": updated}]
        result.evidence = dict(text.evidence, normalizationChanged=True)
        return result
