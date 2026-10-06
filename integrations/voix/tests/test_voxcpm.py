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
from app.tts.voxcpm_server import LEAD_SILENCE, TAIL_SILENCE, Worker, handler_for, load_voices, reference_options, soften_ending


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
                yield np.ones(8, dtype=np.float32) * 0.1
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
    assert events[-1]["frames"] == 14 and closed[-1] == "Following"  # lead silence + 12 chunks + tail silence


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


def test_reference_transcript_switches_the_worker_to_continuation_cloning():
    assert reference_options("/voices/a.wav") == {"reference_wav_path": "/voices/a.wav"}
    assert reference_options("/voices/a.wav", "  ") == {"reference_wav_path": "/voices/a.wav"}
    assert reference_options("/voices/a.wav", " Bon, une bonne tempête. ") == {
        "reference_wav_path": "/voices/a.wav", "prompt_wav_path": "/voices/a.wav", "prompt_text": "Bon, une bonne tempête."}


def test_voices_directory_names_each_reference_and_keeps_transcripts_optional(tmp_path):
    for name in ("narrator", "helper", "bad id"):
        (tmp_path / f"{name}.wav").write_bytes(b"RIFF")
    (tmp_path / "narrator.txt").write_text(" Une phrase exacte. ", encoding="utf-8")
    (tmp_path / "narrator.name").write_text("Narrator (clone)\n", encoding="utf-8")
    voices = load_voices(tmp_path)
    assert list(voices) == ["helper", "narrator"]
    assert voices["narrator"]["name"] == "Narrator (clone)"
    assert voices["narrator"]["options"]["prompt_text"] == "Une phrase exacte."
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
    events = [job.output.get(timeout=1) for _ in range(6)]
    thread.join(timeout=1)
    audio = [np.frombuffer(b64.b64decode(e["pcm"]), dtype="<f4") for e in events if e["type"] == "audio"]
    assert [len(a) for a in audio] == [LEAD_SILENCE, 4000, 4000, TAIL_SILENCE]
    assert not audio[0].any(), "a short lead-in silence protects the first syllable"
    assert audio[1][-1] == np.float32(0.5), "only the final chunk is faded"
    assert abs(audio[2][-1]) < 0.01 and audio[2][0] == np.float32(0.5)
    assert not audio[3].any()
    assert events[-1] == {"type": "done", "frames": 4, "samples": LEAD_SILENCE + 8000 + TAIL_SILENCE}
    assert soften_ending(np.ones(10, dtype=np.float32))[-1] < 0.01


def test_the_fade_lands_on_the_cut_even_when_silence_follows_it():
    cut = np.concatenate([np.full(3000, 0.5, dtype=np.float32), np.zeros(960, dtype=np.float32)])
    soft = soften_ending(cut)
    assert abs(soft[2999]) < 0.01 and soft[1000] == np.float32(0.5) and not soft[3000:].any()


def test_low_noise_after_the_cut_does_not_move_the_fade():
    cut = np.concatenate([np.full(4800, 0.5, dtype=np.float32), np.full(960, 0.002, dtype=np.float32)])
    soft = soften_ending(cut)
    assert abs(soft[4799]) < 0.01 and soft[2000] == np.float32(0.5) and not soft[4800:].any()
