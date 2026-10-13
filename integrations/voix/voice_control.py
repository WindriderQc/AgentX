"""Bounded local command recognition; no conversation, memory or audio storage."""
import io
import json
import re
import time
import unicodedata
import wave
from concurrent.futures import ThreadPoolExecutor

# A general decode may hold its serial inference lock for a long time on CPU.
# Controls need their own bounded executor, including when that pool is full.
_CONTROL_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="voix-controls")

COMMANDS = ("stop", "stop talking", "silence", "arrête", "arrête de parler", "arrête toi", "tais toi")
GRAMMAR = json.dumps([
    phrase for command in COMMANDS for phrase in (command, "nestor " + command, command + " nestor")
] + ["stop stop", "stop stop stop", "[unk]"], ensure_ascii=False)


def is_stop_result(results):
    # Judge the complete utterance, including every finalized segment. A leading
    # Stop followed by a request must never discard that request.
    text = " ".join(row.get("text", "") for row in results).strip().lower()
    text = "".join(char for char in unicodedata.normalize("NFD", text)
                   if unicodedata.category(char) != "Mn")
    text = " ".join("".join(" " if unicodedata.category(char)[0] in "PS" else char
                            for char in text).split())
    command = r"(?:stop(?: talking)?|silence|arrete(?: de parler| toi)?|tais toi)"
    pattern = r"^(?:nestor )?" + command + r"(?: nestor)?(?: " + command + r"(?: nestor)?)*$"
    if not re.fullmatch(pattern, text):
        return False
    words = [word for row in results for word in row.get("result", [])]
    return bool(words) and all(word.get("conf", 0) >= 0.8 for word in words)


async def recognize(loop, classify, transcribe, clock=time.perf_counter):
    """Check the bounded CPU command detector before starting transcription.

    A standalone control never loads or queues the general speech model. Dropping
    an executor future cannot stop its decoder: it would keep occupying the GPU
    or the serial transcription lock after a Stop had already been answered.
    Both calls stay off the event loop. Returns (command, transcription, elapsed_ms).
    """
    started = clock()
    command = await loop.run_in_executor(_CONTROL_EXECUTOR, classify)
    if command:
        return command, None, round((clock() - started) * 1000)
    result = await loop.run_in_executor(None, transcribe)
    return None, result, round((clock() - started) * 1000)


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
