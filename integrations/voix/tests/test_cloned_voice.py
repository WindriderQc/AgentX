import asyncio
import base64
from dataclasses import replace
import json
import threading

import httpx
import numpy as np
import pytest

from app.cancel import CancelToken
from app.tts import provider, voxcpm
from app.tts.cloned_voice_worker import FADE_SAMPLES, LEAD_SILENCE, TAIL_SILENCE, Worker, handler_for, load_voices, soften_ending


def test_voxcpm_keeps_semicolon_and_comma_context_without_changing_legacy_chunks():
    from app.tts.chunker import ClauseChunker
    text = "Une courte pause suffit; prenez votre temps pour choisir la suite."
    chunker = ClauseChunker(sentence_only=True)
    assert chunker.feed("Une courte pause suffit;") == []
    assert chunker.feed(" prenez votre temps pour choisir la suite.") == [text]
    assert ClauseChunker().feed(text) == ["Une courte pause suffit;", "prenez votre temps pour choisir la suite."]


def metadata():
    return dict(type="meta", protocol="voix-pcm-v1", voice="nestor-a", encoding="f32le", sample_rate=48000, channels=1)


def frame(sequence=1, samples=None):
    audio = np.array([0.1, 0.2], dtype="<f4") if samples is None else samples
    return dict(type="audio", sequence=sequence, samples=len(audio), pcm=base64.b64encode(audio.tobytes()).decode())


def test_decoder_rejects_missing_frames_nonfinite_audio_and_bad_completion():
    decoder = voxcpm.Decoder("nestor-a")
    with pytest.raises(ValueError):
        decoder.accept(frame())
    decoder.accept(metadata())
    with pytest.raises(ValueError):
        decoder.accept(frame(2))
    with pytest.raises(ValueError):
        decoder.accept(frame(samples=np.array([np.nan], dtype="<f4")))
    assert len(decoder.accept(frame())) == 2
    with pytest.raises(ValueError):
        decoder.accept(dict(type="done", frames=2, samples=2))
    decoder.accept(dict(type="done", frames=1, samples=2))
    assert decoder.done


@pytest.mark.asyncio
async def test_client_rejects_transport_eof_after_audio_and_cancels_worker(monkeypatch):
    seen = []
    def handle(request):
        seen.append(request.method)
        if request.method == "DELETE":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(200, text="\n".join(json.dumps(e) for e in [metadata(), frame()]) + "\n")
    factory = httpx.AsyncClient
    monkeypatch.setattr(voxcpm, "settings", replace(voxcpm.settings, voxcpm_base_url="http://worker"))
    monkeypatch.setattr(voxcpm.httpx, "AsyncClient", lambda **kwargs: factory(transport=httpx.MockTransport(handle), **kwargs))
    with pytest.raises(RuntimeError, match="before completion"):
        async for _ in voxcpm.stream("Bonjour"):
            pass
    assert seen == ["POST", "DELETE"]


@pytest.mark.asyncio
async def test_cancel_token_interrupts_a_stalled_stream(monkeypatch):
    entered = asyncio.Event()
    deleted = []
    class Stalled(httpx.AsyncByteStream):
        async def __aiter__(self):
            entered.set()
            await asyncio.Event().wait()
            yield b""
    def handle(request):
        if request.method == "DELETE":
            deleted.append(request.url.path)
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(200, stream=Stalled())
    factory = httpx.AsyncClient
    monkeypatch.setattr(voxcpm, "settings", replace(voxcpm.settings, voxcpm_base_url="http://worker"))
    monkeypatch.setattr(voxcpm.httpx, "AsyncClient", lambda **kwargs: factory(transport=httpx.MockTransport(handle), **kwargs))
    cancel = CancelToken()
    async def consume():
        async for _ in voxcpm.stream("Bonjour", cancel=cancel):
            pass
    task = asyncio.create_task(consume())
    await asyncio.wait_for(entered.wait(), 1)
    cancel.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert len(deleted) == 1


def test_worker_cancels_active_and_queued_generation_then_handles_next_request():
    generated, closed = [], []
    def generate(text, voice=None):
        try:
            for _ in range(12):
                generated.append(text)
                yield np.ones(4000, dtype=np.float32) * 0.1
        finally:
            closed.append(text)
    worker = Worker(generate, "nestor-a")
    job = worker.submit(dict(id="one", text="First", voice="nestor-a"))
    thread = threading.Thread(target=worker.execute, args=(job,))
    thread.start()
    assert job.output.get(timeout=1)["type"] == "meta"
    assert job.output.get(timeout=1)["type"] == "audio"
    worker.cancel("one")
    thread.join(timeout=1)
    assert not thread.is_alive() and len(generated) < 12 and closed == ["First"]
    queued = worker.submit(dict(id="two", text="Queued", voice="nestor-a"))
    worker.cancel("two")
    worker.execute(queued)
    assert "Queued" not in generated
    following = worker.submit(dict(id="three", text="Following", voice="nestor-a"))
    thread = threading.Thread(target=worker.execute, args=(following,))
    thread.start()
    events = []
    while not events or events[-1]["type"] != "done":
        events.append(following.output.get(timeout=1))
    thread.join(timeout=1)
    assert events[-1]["samples"] == LEAD_SILENCE + 12 * 4000 + TAIL_SILENCE and closed[-1] == "Following"


def test_voxcpm_is_an_additional_selection_not_a_default_change(monkeypatch):
    import app.runtime as runtime
    monkeypatch.setattr(runtime, "settings", replace(runtime.settings, voxcpm_base_url="http://worker"))
    cfg = runtime.RuntimeConfig.from_settings()
    original = cfg.to_dict()
    assert cfg.update({"tts_provider": "voxcpm"}) == ["tts_provider"]
    assert cfg.language == original["language"]
    assert runtime.settings.tts_provider == original["tts_provider"]
    for choice in ("kokoro", "windows_sapi"):
        assert cfg.update({"tts_provider": choice}) == ["tts_provider"]
        assert provider.provider_name(choice) == choice


def test_voices_directory_names_each_reference_and_ignores_transcripts(tmp_path):
    for name in ("narrator", "helper", "bad id"):
        (tmp_path / f"{name}.wav").write_bytes(b"RIFF")
    (tmp_path / "narrator.txt").write_bytes(b"\xff\xfe")  # ignored, even when not valid UTF-8
    (tmp_path / "narrator.name").write_text("Narrator (clone)\n", encoding="utf-8")
    voices = load_voices(tmp_path)
    assert list(voices) == ["helper", "narrator"]
    assert voices["narrator"]["name"] == "Narrator (clone)"
    assert voices["narrator"]["options"] == {"reference_wav_path": str(tmp_path / "narrator.wav")}
    assert voices["helper"] == {"name": "helper", "options": {"reference_wav_path": str(tmp_path / "helper.wav")}}


def test_one_worker_serves_each_named_voice_and_reports_them():
    spoken = []
    def generate(text, voice):
        spoken.append((text, voice))
        yield np.ones(4, dtype=np.float32) * 0.1
    worker = Worker(generate, "narrator", {"narrator": "Narrator", "helper": "Helper"})
    for request_id, voice in (("a", "helper"), ("b", "narrator")):
        job = worker.submit(dict(id=request_id, text="Bonjour.", voice=voice))
        thread = threading.Thread(target=worker.execute, args=(job,))
        thread.start()
        events = [job.output.get(timeout=1) for _ in range(5)]
        thread.join(timeout=1)
        assert [event["type"] for event in events] == ["meta", "audio", "audio", "audio", "done"]
        assert events[0]["voice"] == voice
    assert spoken == [("Bonjour.", "helper"), ("Bonjour.", "narrator")]
    with pytest.raises(ValueError, match="Unknown voice"):
        worker.submit(dict(id="c", text="Bonjour.", voice="other"))


def test_the_final_chunk_fades_and_ends_with_silence():
    import base64 as b64
    def generate(text, voice):
        yield np.full(4000, 0.5, dtype=np.float32)
        yield np.full(4000, 0.5, dtype=np.float32)
    worker = Worker(generate, "narrator")
    job = worker.submit(dict(id="a", text="Bonjour.", voice="narrator"))
    thread = threading.Thread(target=worker.execute, args=(job,))
    thread.start()
    events = []
    while not events or events[-1]["type"] not in {"done", "error"}:
        events.append(job.output.get(timeout=1))
    thread.join(timeout=1)
    audio = [np.frombuffer(b64.b64decode(e["pcm"]), dtype="<f4") for e in events if e["type"] == "audio"]
    assert [len(a) for a in audio] == [LEAD_SILENCE, 4000 - FADE_SAMPLES, 4000, FADE_SAMPLES, TAIL_SILENCE]
    assert not audio[0].any(), "a short lead-in silence protects the first syllable"
    assert audio[1][-1] == np.float32(0.5), "only the final chunk is faded"
    assert abs(audio[3][-1]) < 0.01 and audio[3][0] == np.float32(0.5)
    assert not audio[4].any()
    assert events[-1] == {"type": "done", "frames": 5, "samples": LEAD_SILENCE + 8000 + TAIL_SILENCE}
    assert soften_ending(np.ones(10, dtype=np.float32))[-1] < 0.01


def test_the_fade_lands_on_the_cut_even_when_silence_follows_it():
    cut = np.concatenate([np.full(3000, 0.5, dtype=np.float32), np.zeros(960, dtype=np.float32)])
    soft = soften_ending(cut)
    assert abs(soft[2999]) < 0.01 and soft[1000] == np.float32(0.5) and not soft[3000:].any()


def test_low_noise_after_the_cut_does_not_move_the_fade():
    cut = np.concatenate([np.full(4800, 0.5, dtype=np.float32), np.full(960, 0.002, dtype=np.float32)])
    soft = soften_ending(cut)
    assert abs(soft[4799]) < 0.01 and soft[2000] == np.float32(0.5) and not soft[4800:].any()


def test_diagnostic_no_end_fade_preserves_a_quiet_final_chunk():
    quiet_tail = np.concatenate([np.full(4800, 0.5, dtype=np.float32),
                                 np.full(960, 0.002, dtype=np.float32)])
    def generate(text, voice):
        yield quiet_tail
    worker = Worker(generate, "narrator", soften_final=False)
    job = worker.submit(dict(id="raw", text="Bonjour.", voice="narrator"))
    thread = threading.Thread(target=worker.execute, args=(job,))
    thread.start()
    events = [job.output.get(timeout=1) for _ in range(5)]
    thread.join(timeout=1)
    final = np.frombuffer(base64.b64decode(events[2]["pcm"]), dtype="<f4")
    assert np.array_equal(final, quiet_tail)
    assert events[-1]["type"] == "done"


@pytest.mark.parametrize("rate", [24000, 48000])
def test_first_generated_prefix_is_sent_without_waiting_for_the_next_model_chunk(rate):
    from app.tts.cloned_voice_worker import at_rate
    next_chunk = threading.Event()
    closed = threading.Event()
    samples = at_rate(8000, rate)
    def generate(text, voice):
        try:
            yield np.full(samples, 0.25, dtype=np.float32)
            assert next_chunk.wait(2), "test releases generation after observing first signal"
            yield np.full(samples, 0.5, dtype=np.float32)
        finally:
            closed.set()
    worker = Worker(generate, "narrator", sample_rate=rate)
    job = worker.submit(dict(id="first-prefix", text="Bonjour.", voice="narrator"))
    thread = threading.Thread(target=worker.execute, args=(job,))
    thread.start()
    events = []
    try:
        for _ in range(3):
            events.append(job.output.get(timeout=1))
        prefix = np.frombuffer(base64.b64decode(events[-1]["pcm"]), dtype="<f4")
        assert prefix.size == samples - at_rate(FADE_SAMPLES, rate)
        assert np.all(prefix == np.float32(0.25)), "first signal precedes the blocked second chunk"
        next_chunk.set()
        while events[-1]["type"] not in {"done", "error"}:
            events.append(job.output.get(timeout=1))
        all_audio = np.concatenate([np.frombuffer(base64.b64decode(e["pcm"]), dtype="<f4")
                                    for e in events if e["type"] == "audio"])
        assert events[-1]["type"] == "done"
        assert events[-1]["samples"] == all_audio.size == at_rate(LEAD_SILENCE + TAIL_SILENCE, rate) + samples * 2
        assert events[-1]["frames"] == len(events) - 2
        assert closed.wait(1)
    finally:
        next_chunk.set()
        worker.cancel(job.id)
        thread.join(timeout=2)
    assert not thread.is_alive()
