import io
import json
import unittest
import wave

from voice_control import VoiceControl, is_stop_result


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


if __name__ == "__main__":
    unittest.main()
