"""A speech-only peer starts without GPU packages, devices or model loading."""
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
_STARTUP_PROBE = r"""
import importlib.abc
import sys

BLOCKED = {"torch", "torchaudio", "silero_vad", "sounddevice", "faster_whisper",
           "kokoro_onnx", "onnxruntime", "yt_dlp", "deno"}

class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in BLOCKED:
            raise ImportError(f"{name} must not be loaded for speech discovery")
        return None

sys.meta_path.insert(0, Block())
from fastapi.testclient import TestClient
from app.service import app

with TestClient(app) as client:
    health = client.get("/health")
    assert health.status_code == 200, health.text
    assert health.json()["running"] is False
    assert health.json()["warmup"]["state"] == "disabled"
    assert health.json()["recognition"]["device"] == "cpu"
    model = client.get("/v1/models").json()["data"][0]
    assert model["compute_type"] == "int8"
    assert client.get("/api/voices").status_code == 200
    assert client.get("/assets/voice-audio.js").status_code == 200
    for retired in ("/sessions/status", "/memory/status", "/media-vault/status"):
        assert client.get(retired).status_code == 404
print("ok")
"""


def test_cpu_peer_discovery_never_imports_engines_or_opens_native_sessions(tmp_path):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("VOIX_", "WHISPER_", "KOKORO_", "TTS_",
                                  "VOXCPM_", "WINDOWS_SAPI_")) and key != "ONNX_PROVIDER"}
    env.update({
        "VOIX_SKIP_DOTENV": "1", "VOIX_STARTUP_WARMUP": "false",
        "VOIX_PREFERENCES_PATH": str(tmp_path / "preferences.json"),
        "KOKORO_MODEL_PATH": str(tmp_path / "missing.onnx"),
        "KOKORO_VOICES_PATH": str(tmp_path / "missing.bin"),
        "WHISPER_DEVICE": "cpu", "WHISPER_COMPUTE_TYPE": "int8",
        "PYTHONPATH": str(ROOT),
    })
    result = subprocess.run([sys.executable, "-c", _STARTUP_PROBE],
                            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr[-3000:]
    assert result.stdout.strip().endswith("ok")
