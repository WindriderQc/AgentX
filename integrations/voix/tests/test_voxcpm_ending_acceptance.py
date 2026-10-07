import base64
import json

import numpy as np
import pytest

from scripts import voxcpm_ending_acceptance as acceptance


class FakeResponse:
    def __init__(self, events):
        self.events = events

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def raise_for_status(self):
        pass

    def iter_lines(self, chunk_size):
        return iter(json.dumps(event).encode() for event in self.events)


class FakeSession:
    def __init__(self, events):
        self.events = events

    def post(self, *args, **kwargs):
        return FakeResponse(self.events)


def events():
    audio = np.array([0.0, 0.2, -0.1], dtype="<f4")
    return [
        {"type": "meta", "protocol": "voix-pcm-v1", "encoding": "f32le", "channels": 1,
         "sample_rate": 48000, "voice": "sample-voice"},
        {"type": "audio", "sequence": 1, "samples": 3,
         "pcm": base64.b64encode(audio.tobytes()).decode("ascii")},
        {"type": "done", "frames": 1, "samples": 3, "generation_ms": 500},
    ]


def test_acceptance_decodes_complete_stream_without_saving_audio():
    result = acceptance.collect_stream(FakeSession(events()), "http://localhost", "Bonjour.", "sample-voice")
    assert np.allclose(result["audio"], [0.0, 0.2, -0.1])
    assert result["sample_rate"] == 48000
    assert result["first_signal_ms"] is not None
    assert result["generation_ms"] == 500
    assert acceptance.wav_bytes(result["audio"], 48000)[:4] == b"RIFF"


@pytest.mark.parametrize("change", [
    lambda values: values[:-1],
    lambda values: [*values[:2], {**values[2], "samples": 2}],
    lambda values: [values[0], {**values[1], "sequence": 2}, values[2]],
])
def test_acceptance_rejects_incomplete_or_reordered_audio(change):
    with pytest.raises(ValueError):
        acceptance.collect_stream(FakeSession(change(events())), "http://localhost", "Bonjour.", "sample-voice")


def test_asr_hints_flag_tails_for_review_without_claiming_acoustic_truth():
    assert len(acceptance.SENTENCES) >= 40
    assert sum(len(sentence) >= 89 for sentence in acceptance.SENTENCES) >= 10
    assert acceptance.review_hint("C'est fait !", "C'est fait") == "asr_exact"
    assert acceptance.review_hint("La porte est fermée.", "La porte est") == "review_possible_dropped_tail"
    assert acceptance.review_hint("La porte est fermée.", "La porte est fermée vraiment") == "review_possible_added_tail"
