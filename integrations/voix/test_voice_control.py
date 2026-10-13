import asyncio
import io
import json
import threading
import unittest
import wave
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

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
    def test_the_cpu_detector_obeys_the_same_complete_utterance_examples_as_the_browser(self):
        examples = json.loads((Path(__file__).parents[2] / "shared/voice-control-examples.json").read_text())
        for text in examples["stop"]:
            with self.subTest(text=text): self.assertTrue(is_stop_result([result(text)]))
        for text in examples["speech"]:
            with self.subTest(text=text): self.assertFalse(is_stop_result([result(text)]))

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

    def test_ordinary_speech_starts_one_decode_after_the_complete_command_check(self):
        checked = threading.Event()
        decoded = []
        def classify(): checked.set(); return None
        def transcribe():
            self.assertTrue(checked.is_set())
            decoded.append(True)
            return ("synthetic request", 200)
        command, transcription, elapsed_ms = self.run_recognize(classify, transcribe)
        self.assertIsNone(command)
        self.assertEqual(transcription, ("synthetic request", 200))
        self.assertEqual(decoded, [True])
        self.assertGreaterEqual(elapsed_ms, 0)

    def test_a_stop_never_enters_the_unavailable_general_decoder(self):
        decoded = threading.Event()
        def unavailable():
            decoded.set()
            raise RuntimeError("GPU unavailable")
        command, transcription, elapsed_ms = self.run_recognize(lambda: "stop", unavailable)
        self.assertEqual(command, "stop")
        self.assertIsNone(transcription)
        self.assertFalse(decoded.is_set(), "a Stop cannot leave a decoder running or queued")
        self.assertGreaterEqual(elapsed_ms, 0)

    def test_stop_can_run_when_the_general_executor_is_occupied(self):
        entered, release = threading.Event(), threading.Event()
        def busy_decoder():
            entered.set()
            release.wait(5)
        async def scenario():
            loop = asyncio.get_running_loop()
            loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
            pending = loop.run_in_executor(None, busy_decoder)
            while not entered.is_set(): await asyncio.sleep(0)
            try:
                answer = await asyncio.wait_for(recognize(loop, lambda: "stop", busy_decoder), 2)
                self.assertEqual(answer[:2], ("stop", None))
                self.assertFalse(release.is_set())
            finally:
                release.set()
                await pending
        asyncio.run(scenario())

    def test_cancellation_while_classifying_does_not_leave_a_decode_behind(self):
        started = threading.Event()
        release = threading.Event()
        decoded = threading.Event()
        def classify():
            started.set()
            release.wait(2)
            return None
        async def scenario():
            task = asyncio.create_task(recognize(asyncio.get_running_loop(), classify, decoded.set))
            await asyncio.get_running_loop().run_in_executor(None, started.wait, 2)
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError): await task
        asyncio.run(scenario())
        self.assertFalse(decoded.is_set())

    def test_a_failed_command_check_fails_the_request_and_a_failed_transcription_is_reported(self):
        def broken(): raise ValueError("classifier failed")
        decoded = threading.Event()
        with self.assertRaises(ValueError):
            self.run_recognize(broken, decoded.set)
        self.assertFalse(decoded.is_set())
        def failing(): raise RuntimeError("transcription failed")
        with self.assertRaises(RuntimeError):
            self.run_recognize(lambda: None, failing)


if __name__ == "__main__":
    unittest.main()
