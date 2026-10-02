"""Bounded local command recognition; no conversation, memory or audio storage."""
import io
import json
import re
import unicodedata
import wave

GRAMMAR = json.dumps([
    "stop", "stop stop", "stop stop stop", "silence", "nestor silence",
    "silence nestor", "nestor stop", "stop nestor", "arrête", "tais toi", "[unk]",
], ensure_ascii=False)


def is_stop_result(results):
    # Judge the complete utterance, including every finalized segment. A leading
    # Stop followed by a request must never discard that request.
    text = " ".join(row.get("text", "") for row in results).strip().lower()
    text = "".join(char for char in unicodedata.normalize("NFD", text)
                   if unicodedata.category(char) != "Mn")
    command = r"(?:stop|silence|arrete|tais toi)"
    pattern = r"^(?:nestor )?" + command + r"(?: nestor)?(?: " + command + r"(?: nestor)?)*$"
    if not re.fullmatch(pattern, text):
        return False
    words = [word for row in results for word in row.get("result", [])]
    return bool(words) and all(word.get("conf", 0) >= 0.8 for word in words)


class VoiceControl:
    def __init__(self, model, recognizer_factory):
        self.model = model
        self.recognizer_factory = recognizer_factory

    def classify(self, raw):
        # Browser transport is mono PCM WAV. Other native upload formats retain
        # their existing Whisper decoder, as do longer conversational utterances.
        try:
            with wave.open(io.BytesIO(raw)) as audio:
                rate = audio.getframerate()
                if (audio.getnchannels() != 1 or audio.getsampwidth() != 2
                        or audio.getcomptype() != "NONE" or not 8000 <= rate <= 96000
                        or audio.getnframes() > rate * 20):
                    return None
                recognizer = self.recognizer_factory(self.model, rate, GRAMMAR)
                recognizer.SetWords(True)
                results = []
                while data := audio.readframes(4000):
                    if recognizer.AcceptWaveform(data):
                        results.append(json.loads(recognizer.Result()))
                results.append(json.loads(recognizer.FinalResult()))
        except (wave.Error, EOFError):
            return None
        return "stop" if is_stop_result(results) else None
