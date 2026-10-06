import asyncio
import io
import json
import threading
import time
import unittest
import wave

from voice_control import VoiceControl, is_stop_result, recognize


def result(text, confidence=1):
    return {"text": text, "result": [{"word": word, "conf": confidence} for word in text.split()]}


def wav(seconds=.1, rate=16000, channels=1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(channels); audio.setsampwidth(2); audio.setframerate(rate)
        audio.writeframes(b"\0\0" * int(rate * seconds) * channels)
    return buffer.getvalue()


class VoiceControlTest(unittest.TestCase):
    def test_only_complete_confident_commands_are_controls(self):
        for text in ["stop", "stop stop stop stop", "nestor silence", "silence nestor", "arrête", "tais toi"]:
            with self.subTest(text=text):
                self.assertTrue(is_stop_result([result(text)]))
        for text in ["", "nestor", "[unk]", "stop [unk]", "[unk] silence", "orion", "let's go"]:
            with self.subTest(text=text):
                self.assertFalse(is_stop_result([result(text)]))
        self.assertFalse(is_stop_result([result("stop", .79)]))
        self.assertFalse(is_stop_result([{"text": "stop"}]))

    def test_a_request_after_a_finalized_stop_segment_is_not_dropped(self):
        self.assertFalse(is_stop_result([result("stop"), result("[unk]")]))
        self.assertTrue(is_stop_result([result("stop stop"), result("stop")]))

    def test_request_local_recognizer_consumes_all_segments(self):
        class Recognizer:
            def __init__(self, *_args): self.calls = 0
            def SetWords(self, value): assert value
            def AcceptWaveform(self, _data): self.calls += 1; return self.calls == 1
            def Result(self): return json.dumps(result("stop"))
            def FinalResult(self): return json.dumps(result("[unk]"))
        self.assertIsNone(VoiceControl(object(), Recognizer).classify(wav(.5)))

    def test_other_formats_and_long_audio_keep_general_transcription(self):
        def unexpected(*_args): raise AssertionError("Must not construct a recognizer")
        detector = VoiceControl(object(), unexpected)
        for raw in [b"not a wav", wav(channels=2), wav(seconds=21)]:
            self.assertIsNone(detector.classify(raw))


class RecognizeTest(unittest.TestCase):
    def run_recognize(self, classify, transcribe):
        async def scenario():
            return await recognize(asyncio.get_running_loop(), classify, transcribe)
        return asyncio.run(scenario())

    def test_a_request_waits_for_the_longer_of_the_two_passes_not_their_sum(self):
        def classify(): time.sleep(.2); return None
        def transcribe(): time.sleep(.2); return ("synthetic request", 200)
        started = time.perf_counter()
        command, transcription, elapsed_ms = self.run_recognize(classify, transcribe)
        self.assertIsNone(command)
        self.assertEqual(transcription, ("synthetic request", 200))
        self.assertLess(time.perf_counter() - started, .35)
        self.assertGreaterEqual(elapsed_ms, 190)
        self.assertLess(elapsed_ms, 350)

    def test_a_command_answers_at_once_and_its_transcription_is_never_read(self):
        finished = threading.Event()
        def transcribe(): time.sleep(.3); finished.set(); raise RuntimeError("never read")
        async def scenario():
            answer = await recognize(asyncio.get_running_loop(), lambda: "stop", transcribe)
            # Read before the loop closes: closing waits for the dropped transcription.
            return answer, finished.is_set()
        (command, transcription, elapsed_ms), transcribed = asyncio.run(scenario())
        self.assertEqual(command, "stop")
        self.assertIsNone(transcription)
        self.assertLess(elapsed_ms, 200)
        self.assertFalse(transcribed, "the answer did not wait for the transcription")

    def test_a_failed_command_check_fails_the_request_and_a_failed_transcription_is_reported(self):
        def broken(): raise ValueError("classifier failed")
        with self.assertRaises(ValueError):
            self.run_recognize(broken, lambda: ("unused", 1))
        def failing(): raise RuntimeError("transcription failed")
        with self.assertRaises(RuntimeError):
            self.run_recognize(lambda: None, failing)


if __name__ == "__main__":
    unittest.main()
