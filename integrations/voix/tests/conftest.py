"""Isolate speech tests before app.config reads instance settings at import time."""
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest


_SETTING_PREFIXES = (
    "VOIX_", "WHISPER_", "KOKORO_", "TTS_", "VOXCPM_", "WINDOWS_SAPI_",
)
for _name in list(os.environ):
    if _name.startswith(_SETTING_PREFIXES) or _name == "ONNX_PROVIDER":
        del os.environ[_name]

# Initial service import must not read the developer's saved speech choices.
_STATE = TemporaryDirectory(prefix="agentx-speech-tests-")
os.environ["VOIX_SKIP_DOTENV"] = "1"
os.environ["VOIX_PREFERENCES_PATH"] = str(Path(_STATE.name) / "preferences.json")


@pytest.fixture(autouse=True)
def _isolated_speech_preferences(monkeypatch, tmp_path):
    monkeypatch.setenv("VOIX_PREFERENCES_PATH", str(tmp_path / "preferences.json"))
