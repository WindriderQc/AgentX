import base64
import threading

import numpy as np
import pytest

from app.tts import voxcpm
from app.tts.pocket_server import stream_voice
from app.tts.voxcpm_server import LEAD_SILENCE, TAIL_SILENCE, Worker, at_rate, soften_ending


class FakeModel:
    """Stands in for the speech model: yields three chunks unless it is told to stop."""

    def __init__(self):
        self.stops = []

    def generate_audio_stream(self, state, text, stop=None):
        self.stops.append(stop)
        for value in (0.1, 0.2, 0.3):
            if stop.is_set():
                return
            yield np.full(480, value, dtype=np.float64)


def test_the_generator_yields_float32_and_stops_the_model_when_its_reader_leaves():
    model = FakeModel()
    chunks = list(stream_voice(model, "state", "Bonjour."))
    assert [c.dtype for c in chunks] == [np.dtype("<f4")] * 3 and all(c.ndim == 1 for c in chunks)
    assert model.stops[0].is_set(), "a finished stream releases the model too"
    reader = stream_voice(model, "state", "Bonjour.")
    next(reader)
    assert not model.stops[1].is_set()
    reader.close()
    assert model.stops[1].is_set(), "a reader that leaves early stops generation"


def test_a_worker_at_another_rate_declares_it_and_keeps_the_same_silence_durations():
    def generate(text, voice):
        yield np.full(2000, 0.5, dtype=np.float32)
        yield np.full(2000, 0.5, dtype=np.float32)
    worker = Worker(generate, "narrator", sample_rate=24000, model="kyutai/pocket-tts", tag="pocket")
    job = worker.submit(dict(id="a", text="Bonjour.", voice="narrator"))
    thread = threading.Thread(target=worker.execute, args=(job,))
    thread.start()
    events = [job.output.get(timeout=1) for _ in range(6)]
    thread.join(timeout=1)
    assert events[0]["sample_rate"] == 24000
    audio = [np.frombuffer(base64.b64decode(e["pcm"]), dtype="<f4") for e in events if e["type"] == "audio"]
    lead, tail = at_rate(LEAD_SILENCE, 24000), at_rate(TAIL_SILENCE, 24000)
    assert (lead, tail) == (1920, 2880), "80 ms and 120 ms at 24 kHz"
    assert [len(a) for a in audio] == [lead, 2000, 2000, tail]
    assert abs(audio[2][-1]) < 0.01 and audio[2][0] == np.float32(0.5), "the final chunk still ends softly"
    assert events[-1] == {"type": "done", "frames": 4, "samples": lead + 4000 + tail}
    # The fade is a duration: half as many samples at half the rate.
    half = soften_ending(np.ones(4000, dtype=np.float32), 24000)
    full = soften_ending(np.ones(4000, dtype=np.float32))
    assert np.count_nonzero(half < 0.999) < np.count_nonzero(full < 0.999)


def test_the_client_accepts_the_rate_a_worker_declares_and_refuses_an_unknown_one():
    def meta(rate):
        return dict(type="meta", protocol="voix-pcm-v1", voice="narrator", encoding="f32le", sample_rate=rate, channels=1)
    decoder = voxcpm.Decoder("narrator")
    decoder.accept(meta(24000))
    assert decoder.rate == 24000
    for rate in (0, 11025, "24000", None):
        with pytest.raises(ValueError):
            voxcpm.Decoder("narrator").accept(meta(rate))
